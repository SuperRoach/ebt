#include <Arduino.h>
#include <HTTPClient.h>
#include <NetworkClientSecure.h>
#include <Preferences.h>
#include <WiFi.h>
#include <esp_ota_ops.h>
#include <mbedtls/sha256.h>

#include "../include/secrets.h"
#include "build_config.h"
#include "ota.h"
#include "telemetry_ca.h"

namespace {
struct FirmwareOffer {
  String id;
  String digest;
  size_t size;
};

FirmwareOffer pending;
String origin;
String lastInstalledRelease;
bool trial = false;
unsigned long trialStarted;
unsigned long lastAttempt;
bool attempted = false;

bool matches(const char *value, size_t length, bool uuid = false) {
  if (strlen(value) != length) return false;
  for (size_t i = 0; i < length; ++i) {
    if (uuid && (i == 8 || i == 13 || i == 18 || i == 23)) {
      if (value[i] != '-') return false;
    } else if (!isxdigit(static_cast<unsigned char>(value[i]))) return false;
  }
  return true;
}

constexpr size_t chunkSize = 8192;
uint8_t chunk[chunkSize];
esp_ota_handle_t handle;
const esp_partition_t *target = nullptr;
mbedtls_sha256_context hash;
size_t offset = 0;
bool cellularFailed = false;
unsigned long cellularFailedAt;

void resetDownload() {
  if (!target) return;
  esp_ota_abort(handle);
  mbedtls_sha256_free(&hash);
  target = nullptr;
  offset = 0;
}

bool readWifiChunk(const String &url, size_t length) {
  NetworkClientSecure client;
  client.setCACert(telemetryRootCa);
  client.setHandshakeTimeout(5);
  HTTPClient http;
  http.useHTTP10();
  http.setConnectTimeout(5000);
  http.setTimeout(5000);
  if (!http.begin(client, url)) return false;
  http.addHeader("Authorization", String("Bearer ") + EBT_DEVICE_KEY);
  if (http.GET() != HTTP_CODE_OK || http.getSize() != static_cast<int>(length)) return false;
  auto &stream = http.getStream();
  stream.setTimeout(5000);
  return stream.readBytes(chunk, length) == length;
}

bool finishDownload() {
  uint8_t digest[32];
  const bool hashed = mbedtls_sha256_finish(&hash, digest) == 0;
  char hex[65];
  if (hashed) {
    for (size_t i = 0; i < sizeof(digest); ++i) snprintf(hex + i * 2, 3, "%02x", digest[i]);
  }
  if (!hashed || !pending.digest.equalsIgnoreCase(hex)) {
    resetDownload();
    return false;
  }
  const auto *partition = target;
  mbedtls_sha256_free(&hash);
  target = nullptr;
  offset = 0;
  if (esp_ota_end(handle) != ESP_OK) return false;
  Preferences preferences;
  if (!preferences.begin("ebt-ota") || preferences.putString("last-release", pending.id) != pending.id.length()) return false;
  if (esp_ota_set_boot_partition(partition) == ESP_OK) return true;
  preferences.remove("last-release");
  return false;
}
}

// Arduino otherwise confirms the image before setup, before telemetry can be checked.
extern "C" bool verifyRollbackLater() { return true; }

void beginFirmwareTrial() {
  Preferences preferences;
  if (preferences.begin("ebt-ota", true)) lastInstalledRelease = preferences.getString("last-release");
  esp_ota_img_states_t state;
  trial = esp_ota_get_state_partition(esp_ota_get_running_partition(), &state) == ESP_OK &&
          state == ESP_OTA_IMG_PENDING_VERIFY;
  trialStarted = millis();
}

void checkFirmwareTrial() {
  if (!trial || millis() - trialStarted < 180000) return;
  Serial.println("OTA image could not reach the telemetry API. Rolling back.");
  esp_ota_mark_app_invalid_rollback_and_reboot();
}

void acceptFirmwareOffer(JsonVariantConst offer) {
  if (trial && esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) {
    trial = false;
    Serial.println("OTA image confirmed by telemetry acknowledgement");
  }
  if (trial) return;
  if (offer.isNull()) {
    resetDownload();
    pending = {};
    return;
  }
  const char *id = offer["releaseId"] | "";
  const char *version = offer["version"] | "";
  const char *digest = offer["sha256"] | "";
  const size_t size = offer["sizeBytes"] | 0U;
  if (!*version || strcmp(version, EBT_FIRMWARE_VERSION) == 0 ||
      !matches(id, 36, true) || lastInstalledRelease == id || !matches(digest, 64) || size < 1024) return;
  const String url = EBT_API_URL;
  if (!url.startsWith("https://")) return;
  const int path = url.indexOf('/', 8);
  if (path < 0) return;
  origin = url.substring(0, path);
  const auto *partition = esp_ota_get_next_update_partition(nullptr);
  if (!partition || size > partition->size) return;
  if (pending.id != id) {
    resetDownload();
    cellularFailed = false;
    attempted = false;
  }
  pending = {id, digest, size};
}

bool firmwareWifiNeeded() {
  return !pending.id.isEmpty() && cellularFailed &&
         (!attempted || millis() - lastAttempt >= 60000);
}

void serviceFirmwareUpdate(bool cellularEnabled) {
  if (pending.id.isEmpty() || (attempted && millis() - lastAttempt < 60000)) return;
  const size_t length = min(chunkSize, pending.size - offset);
  const String url = origin + "/api/v1/firmware/releases/" + pending.id +
                     "?offset=" + String(offset) + "&length=" + String(length);
  bool received = false;
  if (cellularEnabled && (!cellularFailed || millis() - cellularFailedAt >= 60000)) {
    received = readCellularFirmwareChunk(url, chunk, length);
    cellularFailed = !received;
    if (!received) cellularFailedAt = millis();
  } else if (!cellularEnabled) {
    cellularFailed = true;
  }
  if (!received) {
    if (!firmwareWifiNeeded() || WiFi.status() != WL_CONNECTED) return;
    received = readWifiChunk(url, length);
  }
  if (received) {
    if (!target) {
      const auto *partition = esp_ota_get_next_update_partition(nullptr);
      if (partition && esp_ota_begin(partition, pending.size, &handle) == ESP_OK) {
        target = partition;
        mbedtls_sha256_init(&hash);
        if (mbedtls_sha256_starts(&hash, 0) != 0) resetDownload();
      }
    }
    if (target && mbedtls_sha256_update(&hash, chunk, length) == 0 &&
        esp_ota_write(handle, chunk, length) == ESP_OK) {
      offset += length;
      if (offset < pending.size) return;
      if (finishDownload()) {
        Serial.println("Firmware verified. Rebooting into the OTA slot.");
        ESP.restart();
        return;
      }
    }
    resetDownload();
  }
  lastAttempt = millis();
  attempted = true;
  Serial.println("OTA transfer paused or image verification failed. Keeping the current firmware.");
}
