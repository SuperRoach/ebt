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

bool downloadFirmware() {
  const auto *partition = esp_ota_get_next_update_partition(nullptr);
  if (!partition || pending.size > partition->size) return false;
  NetworkClientSecure client;
  client.setCACert(telemetryRootCa);
  client.setHandshakeTimeout(5);
  HTTPClient http;
  http.useHTTP10();
  http.setConnectTimeout(5000);
  http.setTimeout(5000);
  if (!http.begin(client, origin + "/api/v1/firmware/releases/" + pending.id)) return false;
  http.addHeader("Authorization", String("Bearer ") + EBT_DEVICE_KEY);
  if (http.GET() != HTTP_CODE_OK || http.getSize() != static_cast<int>(pending.size)) return false;

  esp_ota_handle_t handle;
  if (esp_ota_begin(partition, pending.size, &handle) != ESP_OK) return false;
  mbedtls_sha256_context hash;
  mbedtls_sha256_init(&hash);
  bool ok = mbedtls_sha256_starts(&hash, 0) == 0;
  uint8_t buffer[2048];
  size_t remaining = pending.size;
  const auto started = millis();
  auto lastRead = started;
  auto &stream = http.getStream();
  while (ok && remaining && millis() - started < 120000) {
    const int available = stream.available();
    if (available <= 0) {
      if (!http.connected() || millis() - lastRead >= 5000) break;
      delay(2);
      continue;
    }
    const int received = stream.read(buffer, min(min(remaining, sizeof(buffer)), static_cast<size_t>(available)));
    if (received <= 0) break;
    lastRead = millis();
    ok = mbedtls_sha256_update(&hash, buffer, received) == 0 &&
         esp_ota_write(handle, buffer, received) == ESP_OK;
    remaining -= received;
    delay(1);
  }
  uint8_t digest[32];
  ok = ok && remaining == 0 && mbedtls_sha256_finish(&hash, digest) == 0;
  mbedtls_sha256_free(&hash);
  if (ok) {
    char hex[65];
    for (size_t i = 0; i < sizeof(digest); ++i) snprintf(hex + i * 2, 3, "%02x", digest[i]);
    ok = pending.digest.equalsIgnoreCase(hex);
  }
  if (!ok) {
    esp_ota_abort(handle);
    return false;
  }
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
  if (pending.id != id) attempted = false;
  pending = {id, digest, size};
}

bool firmwareWifiNeeded() {
  return !pending.id.isEmpty() && (!attempted || millis() - lastAttempt >= 60000);
}

void serviceFirmwareUpdate() {
  if (!firmwareWifiNeeded() || WiFi.status() != WL_CONNECTED) return;
  Serial.printf("Downloading firmware release %s over Wi-Fi\n", pending.id.c_str());
  if (downloadFirmware()) {
    Serial.println("Firmware verified. Rebooting into the OTA slot.");
    ESP.restart();
  }
  lastAttempt = millis();
  attempted = true;
  Serial.println("OTA download or image verification failed. Keeping the current firmware.");
}
