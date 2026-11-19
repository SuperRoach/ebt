#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <NetworkClientSecure.h>
#include <SD_MMC.h>
#include <WiFi.h>
#include <Wire.h>
#include <esp_random.h>
#include <cerrno>
#include <fcntl.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#include <sys/time.h>
#include <unistd.h>

#include "../include/secrets.h"
#include "build_config.h"
#include "gnss_motion.h"
#include "ota.h"
#include "telemetry_ca.h"

namespace {
constexpr int modemRx = 17;
constexpr int modemTx = 18;
constexpr unsigned long baud = 115200;
constexpr unsigned long pollInterval = 1000;
constexpr unsigned long gpsLossInterval = 15000;
HardwareSerial modem(1);
constexpr unsigned int cardCaptureQueueCapacity = 8;
struct CaptureRecord {
  char payload[1024]{};
};

struct DeviceJob {
  void (*run)(void *);
  void *context;
  TaskHandle_t caller;
  const char *label;
};

QueueHandle_t captures;
QueueHandle_t gpsStatus;
QueueHandle_t modemJobs;
QueueHandle_t storageJobs;
QueueHandle_t ramDelivery;
TaskHandle_t storageOwner;

// A job and its context live on the delivery task's stack until the modem
// owner signals completion. Jobs execute in full between due GPS polls.
template <typename Work>
void onModem(const char *label, Work &work) {
  DeviceJob job{[](void *context) { (*static_cast<Work *>(context))(); },
               &work, xTaskGetCurrentTaskHandle(), label};
  xQueueSend(modemJobs, &job, portMAX_DELAY);
  ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
}

template <typename Work>
void onStorage(Work &work) {
  DeviceJob job{[](void *context) { (*static_cast<Work *>(context))(); },
                &work, xTaskGetCurrentTaskHandle(), nullptr};
  xQueueSend(storageJobs, &job, portMAX_DELAY);
  xTaskNotifyGive(storageOwner);
  ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
}

bool modemReply(const char *prefix, String &data, unsigned long timeout,
                const char *terminal = "OK") {
  String line;
  bool discard = false;
  data = "";
  const auto started = millis();

  while (millis() - started < timeout) {
    const int byte = modem.read();
    if (byte < 0) {
      delay(1);
      continue;
    }
    // CCERTDOWN can emit its prompt without a trailing newline.
    if (byte == '>' && line.isEmpty() && terminal && terminal[0] == '>') return true;
    if (byte == '\r') continue;
    if (byte != '\n') {
      if (line.length() < 200 && !discard) line += static_cast<char>(byte);
      else discard = true;
      continue;
    }
    if (!discard) {
      line.trim();
      if (terminal && line == terminal) return true;
      if (line == "ERROR" || line.startsWith("+CME ERROR:")) return false;
      if (prefix && line.startsWith(prefix)) {
        data = line.substring(strlen(prefix));
        data.trim();
        if (!terminal) return true;
      }
    }
    line = "";
    discard = false;
  }
  return false;
}

void modemRequest(const char *request) {
  while (modem.available()) modem.read();
  modem.print(request);
  modem.print("\r\n");
}

bool command(const char *request, const char *prefix, String &data, unsigned long timeout) {
  modemRequest(request);
  return modemReply(prefix, data, timeout);
}

bool modemOk(const String &request, unsigned long timeout = 1500) {
  String response;
  return command(request.c_str(), nullptr, response, timeout);
}

bool coordinate(const String &field, const String &hemisphere, char positive, char negative,
                double maximum, double &value) {
  if (field.isEmpty() || hemisphere.length() != 1) return false;
  char *end;
  const double raw = strtod(field.c_str(), &end);
  if (end == field.c_str() || *end || !isfinite(raw) || raw < 0 || raw >= (maximum + 1) * 100) return false;
  const int degrees = static_cast<int>(raw / 100);
  const double minutes = raw - degrees * 100;
  value = degrees + minutes / 60;
  if (minutes >= 60 || value > maximum) return false;
  if (hemisphere[0] == negative) value = -value;
  else if (hemisphere[0] != positive) return false;
  return true;
}

#ifndef EBT_DEVICE_ID
#error "Select a tracker profile that defines EBT_DEVICE_ID"
#endif
constexpr char deviceId[] = EBT_DEVICE_ID;
constexpr char queueDir[] = "/ebt-queue";
constexpr size_t maxRecordSize = sizeof(CaptureRecord::payload);
constexpr int uploadsPerPoll = 8;
char bootId[33], sessionId[33];
uint32_t counter = 0;
bool cardReady = false;
String pending;
String lastTimestamp;

void randomId(char (&id)[33]) {
  for (int i = 0; i < 4; ++i) snprintf(id + 8 * i, 9, "%08lx", (unsigned long)esp_random());
}

size_t splitFields(const String &data, String *fields, size_t count) {
  int start = 0;
  for (size_t i = 0; i < count; ++i) {
    const int end = data.indexOf(',', start);
    fields[i] = end < 0 ? data.substring(start) : data.substring(start, end);
    fields[i].trim();
    if (end < 0) return i + 1;
    start = end + 1;
  }
  return count;
}

bool number(const String &field, double &value) {
  if (field.isEmpty()) return false;
  char *end;
  value = strtod(field.c_str(), &end);
  return !*end && isfinite(value);
}

bool utcTimestamp(const String &date, const String &time, char (&timestamp)[21]) {
  if (date.length() != 6 || time.length() < 6) return false;
  for (int i = 0; i < 6; ++i) {
    if (!isDigit(date[i]) || !isDigit(time[i])) return false;
  }
  snprintf(timestamp, sizeof(timestamp), "20%.2s-%.2s-%.2sT%.2s:%.2s:%.2sZ",
           date.c_str() + 4, date.c_str() + 2, date.c_str(),
           time.c_str(), time.c_str() + 2, time.c_str() + 4);
  return true;
}

double readBatteryVoltage() {
  constexpr uint8_t address = 0x36;
  Wire.beginTransmission(address);
  Wire.write(0x02);
  if (Wire.endTransmission(false) != 0 || Wire.requestFrom(address, uint8_t{2}) != 2) return NAN;
  const int high = Wire.read();
  const int low = Wire.read();
  return ((high << 8) | low) * 0.000078125;
}

JsonObject beginSample(JsonDocument &batch, const char *timestamp, double battery) {
  if (counter == UINT32_MAX) {
    randomId(bootId);
    counter = 0;
  }
  char sequence[44];
  snprintf(sequence, sizeof(sequence), "%s:%010lu", bootId, (unsigned long)++counter);
  batch["version"] = 1;
  batch["deviceId"] = deviceId;
  batch["firmwareVersion"] = EBT_FIRMWARE_VERSION;
  batch["recordingSessionId"] = sessionId;
  batch["recordingState"] = "recording";
  batch["transport"] = "wifi";
  if (isfinite(battery) && battery >= 0 && battery <= 30) batch["batteryVoltage"] = battery;
  else batch["batteryVoltage"] = nullptr;
  auto sample = batch["samples"].to<JsonArray>().add<JsonObject>();
  sample["sequence"] = sequence;
  sample["timestamp"] = timestamp;
  return sample;
}

bool clockReady() {
  return time(nullptr) >= 1735689600;  // Reject the unset clock at startup.
}

bool inferGpsTimestamp(const String &gpsTime, char (&timestamp)[21]) {
  if (!clockReady() || gpsTime.length() < 6) return false;
  for (int i = 0; i < 6; ++i) {
    if (!isDigit(gpsTime[i])) return false;
  }
  if (gpsTime.length() > 6) {
    if (gpsTime[6] != '.' || gpsTime.length() == 7) return false;
    for (unsigned int i = 7; i < gpsTime.length(); ++i) {
      if (!isDigit(gpsTime[i])) return false;
    }
  }
  const int hour = (gpsTime[0] - '0') * 10 + gpsTime[1] - '0';
  const int minute = (gpsTime[2] - '0') * 10 + gpsTime[3] - '0';
  const int second = (gpsTime[4] - '0') * 10 + gpsTime[5] - '0';
  if (hour > 23 || minute > 59 || second > 59) return false;

  constexpr time_t secondsPerDay = 86400;
  const time_t now = time(nullptr);
  time_t candidate = now - now % secondsPerDay + hour * 3600 + minute * 60 + second;
  // Choose the closest UTC date across midnight before checking freshness.
  if (candidate - now > secondsPerDay / 2) candidate -= secondsPerDay;
  if (now - candidate > secondsPerDay / 2) candidate += secondsPerDay;
  if (now - candidate > 30 || candidate - now > 2) return false;
  tm utc{};
  return gmtime_r(&candidate, &utc) && strftime(timestamp, sizeof(timestamp), "%Y-%m-%dT%H:%M:%SZ", &utc) == 20;
}

void syncModemTime() {
  String response;
  if (!command("AT+CCLK?", "+CCLK:", response, 1500)) return;
  int year, month, day, hour, minute, second, offset;
  if (sscanf(response.c_str(), "\"%2d/%2d/%2d,%2d:%2d:%2d%3d\"",
             &year, &month, &day, &hour, &minute, &second, &offset) != 7 ||
      year < 25 || month < 1 || month > 12 || day < 1 || day > 31 ||
      hour > 23 || minute > 59 || second > 59 || abs(offset) > 56) return;
  tm local{};
  local.tm_year = 100 + year;
  local.tm_mon = month - 1;
  local.tm_mday = day;
  local.tm_hour = hour;
  local.tm_min = minute;
  local.tm_sec = second;
  // CTZU mode 1 keeps the modem RTC in UTC.
  const timeval now{mktime(&local), 0};
  settimeofday(&now, nullptr);
}

struct GpsFix {
  char timestamp[21];
  String utcTime;
  double latitude;
  double longitude;
  bool inferredDate;
  GnssMotion motion;
};

bool fixTimestamp(const String &date, const String &time, char (&timestamp)[21]) {
  return date.isEmpty() ? inferGpsTimestamp(time, timestamp) : utcTimestamp(date, time, timestamp);
}

void syncGpsClock(const GpsFix &fix) {
  // A valid dated fix gives TLS a clock even with neither uplink available.
  tm utc{};
  if (!fix.inferredDate && strptime(fix.timestamp, "%Y-%m-%dT%H:%M:%SZ", &utc)) {
    const timeval now{mktime(&utc), 0};  // ESP32 boots with the UTC timezone.
    settimeofday(&now, nullptr);
  }
}

const char *readGpsFix(GpsFix &fix, unsigned long timeout) {
  String response;
  String gps[9];
  if (!command("AT+CGPSINFO", "+CGPSINFO:", response, timeout)) {
    return "modem-no-response";
  }
  if (response.isEmpty() || response.startsWith(",")) {
    return "no-fix";
  }
  if (splitFields(response, gps, 9) < 6) {
    return "incomplete-response";
  }

  if (!coordinate(gps[0], gps[1], 'N', 'S', 90, fix.latitude)) return "invalid-latitude";
  if (!coordinate(gps[2], gps[3], 'E', 'W', 180, fix.longitude)) return "invalid-longitude";
  fix.inferredDate = gps[4].isEmpty();
  if (!fixTimestamp(gps[4], gps[5], fix.timestamp)) {
    return "invalid-gps-time";
  }
  if (lastTimestamp == fix.timestamp || (fix.inferredDate && lastTimestamp.compareTo(fix.timestamp) > 0)) {
    return "repeated-timestamp";
  }
  fix.utcTime = gps[5];
  fix.motion = readGnssMotion(gps[7].c_str(), gps[8].c_str());
  if (!fix.motion.speed.valid() || !fix.motion.heading.valid()) {
    Serial.printf("GPS motion unavailable at %s: AT+CGPSINFO speed(knots)=\"%s\" (%s), heading(deg)=\"%s\" (%s)\n",
                  fix.timestamp, gps[7].c_str(), fix.motion.speed.status,
                  gps[8].c_str(), fix.motion.heading.status);
  }
  return nullptr;
}

const char *capture(String &payload) {
  const auto started = millis();
  GpsFix fix;
  if (const char *reason = readGpsFix(fix, 10000)) return reason;
  syncGpsClock(fix);

  String response, gnss[18];
  const bool gnssResponded = command("AT+CGNSSINFO", "+CGNSSINFO:", response, 10000);
  char gnssTimestamp[21];
  const bool gnssHasFix = gnssResponded && splitFields(response, gnss, 18) >= 11 &&
                          (gnss[0] == "2" || gnss[0] == "3") &&
                          fixTimestamp(gnss[9], gnss[10], gnssTimestamp);
  const GnssMotion gnssMotion = readGnssMotion(gnss[12].c_str(), gnss[13].c_str());
  const auto matchesGnss = [&](const GpsFix &gps) {
    return gnssHasFix && strcmp(gps.timestamp, gnssTimestamp) == 0 &&
           sameUtcFixTime(gps.utcTime.c_str(), gnss[10].c_str());
  };

  // The commands can straddle a receiver update. Retry once when there is time
  // left in the poll and the GNSS response can supply a missing motion field.
  constexpr unsigned long retryTimeout = 750;
  const bool needsMotion = !fix.motion.speed.valid() || !fix.motion.heading.valid();
  const bool canRecoverMotion = (!fix.motion.speed.valid() && gnssMotion.speed.valid()) ||
                                (!fix.motion.heading.valid() && gnssMotion.heading.valid());
  if (canRecoverMotion && gnssHasFix && strcmp(gnssTimestamp, fix.timestamp) >= 0 &&
      !matchesGnss(fix) && millis() - started <= pollInterval - retryTimeout) {
    GpsFix retry;
    if (!readGpsFix(retry, retryTimeout) && matchesGnss(retry) &&
        (retry.motion.speed.valid() || gnssMotion.speed.valid() || !fix.motion.speed.valid()) &&
        (retry.motion.heading.valid() || gnssMotion.heading.valid() || !fix.motion.heading.valid())) {
      fix = retry;
      syncGpsClock(fix);
    }
  }

  const bool sameFix = matchesGnss(fix);
  const auto speed = selectMotion(fix.motion.speed, gnssMotion.speed, sameFix);
  const auto heading = selectMotion(fix.motion.heading, gnssMotion.heading, sameFix);

  double satellites, hdop;
  const bool satelliteCountAvailable = sameFix && number(gnss[17], satellites) &&
                                       satellites >= 1 && satellites <= 255 && floor(satellites) == satellites;

  JsonDocument batch;
  auto sample = beginSample(batch, fix.timestamp, readBatteryVoltage());
  sample["latitude"] = fix.latitude;
  sample["longitude"] = fix.longitude;
  if (speed.source) sample["speedMps"] = speed.value * knotsToMps;
  else sample["speedMps"] = nullptr;
  if (heading.source) sample["headingDeg"] = heading.value == 360 ? 0 : heading.value;
  else sample["headingDeg"] = nullptr;
  sample["fixValid"] = true;
  if (satelliteCountAvailable) sample["satelliteCount"] = static_cast<int>(satellites);
  else sample["satelliteCount"] = nullptr;
  if (sameFix && number(gnss[15], hdop) && hdop >= 0) sample["hdop"] = hdop;
  serializeJson(batch, payload);
  lastTimestamp = fix.timestamp;
  if (fix.inferredDate) Serial.println("GPS fix accepted with date inferred from UTC clock");
  if (satelliteCountAvailable) {
    Serial.printf("Captured GPS fix at %s with %d satellites\n", fix.timestamp, static_cast<int>(satellites));
  } else {
    Serial.printf("Captured GPS fix at %s (satellite count unavailable)\n", fix.timestamp);
  }
  if (needsMotion) {
    const char *gnssStatus = !gnssResponded ? "command-failed" :
                             !gnssHasFix ? "no-usable-fix" :
                             sameFix ? "matched" : "epoch-mismatch";
    Serial.printf("GPS motion sources at %s: speed=%s heading=%s CGNSSINFO=%s/%s/%s\n",
                  fix.timestamp, speed.source ? speed.source : "none", heading.source ? heading.source : "none",
                  gnssStatus, gnssMotion.speed.status, gnssMotion.heading.status);
  }
  return nullptr;
}

bool queueOnCard(const String &payload) {
  char filename[64];
  // A separate file per fix lets us remove an acknowledged record independently.
  JsonDocument batch;
  if (deserializeJson(batch, payload)) return false;
  const char *sequence = batch["samples"][0]["sequence"];
  if (!sequence || strlen(sequence) != 43) return false;
  snprintf(filename, sizeof(filename), "%s/%.32s-%s.json", queueDir, sequence, sequence + 33);
  const String path = String("/sdcard") + filename;
  const int fd = open(path.c_str(), O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0) {
    Serial.printf("microSD open failed (errno=%d)\n", errno);
    return false;
  }
  const String record = payload + '\n';
  const bool written = write(fd, record.c_str(), record.length()) == static_cast<ssize_t>(record.length());
  const bool synced = written && fsync(fd) == 0;
  const int writeError = synced ? 0 : errno;
  const bool closed = close(fd) == 0;
  if (!synced || !closed) {
    Serial.printf("microSD %s failed (errno=%d)\n",
                  !written ? "write" : !synced ? "sync" : "close", synced ? errno : writeError);
    unlink(path.c_str());
    return false;
  }
  Serial.printf("Saved GPS fix to microSD (%s)\n", filename);
  return true;
}

bool acknowledged(int status, const String &body, const char *sequence, const char *link, bool currentVersion) {
  if (status == 200) {
    JsonDocument ack;
    if (!deserializeJson(ack, body) && ack["version"] == 1 &&
        ack["deviceId"] == deviceId && ack["accepted"][0]["sequence"] == sequence &&
        (ack["accepted"][0]["status"] == "stored" || ack["accepted"][0]["status"] == "duplicate")) {
      Serial.printf("%s acknowledged %s as %s\n", link, sequence,
                    ack["accepted"][0]["status"].as<const char *>());
      if (currentVersion) acceptFirmwareOffer(ack["firmwareUpdate"]);
      return true;
    }
  }
  Serial.printf("%s upload failed (%d). Retaining sample for retry.\n", link, status);
  return false;
}

bool sendWifi(const String &payload, const char *sequence, bool currentVersion) {
  NetworkClient plain;
  NetworkClientSecure secure;
  const bool https = String(EBT_API_URL).startsWith("https://");
  secure.setCACert(telemetryRootCa);
  secure.setHandshakeTimeout(4);
  HTTPClient http;
  http.setConnectTimeout(3000);
  http.setTimeout(3000);
  NetworkClient &client = https ? static_cast<NetworkClient &>(secure) : plain;
  if (!http.begin(client, EBT_API_URL)) return false;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + EBT_DEVICE_KEY);
  const int status = http.POST(payload);
  return acknowledged(status, status == 200 ? http.getString() : String(), sequence, "Wi-Fi", currentVersion);
}

bool modemUpload(const String &request, const char *prompt, const char *bytes, size_t size) {
  modemRequest(request.c_str());
  String response;
  if (!modemReply(nullptr, response, 2000, prompt)) return false;
  return modem.write(reinterpret_cast<const uint8_t *>(bytes), size) == size &&
         modemReply(nullptr, response, 3000);
}

bool configureModemTls() {
  constexpr char caFile[] = "ebt-isrg-x1.pem";
  String response;
  if (!command("AT+CCERTLIST", "+CCERTLIST:", response, 1500) ||
      response.indexOf(caFile) < 0) {
    modemOk(String("AT+CCERTDELE=\"") + caFile + "\"");
    if (!modemUpload(String("AT+CCERTDOWN=\"") + caFile + "\"," + strlen(telemetryRootCa),
                     ">", telemetryRootCa, strlen(telemetryRootCa))) return false;
  }
  const time_t now = time(nullptr);
  tm utc{};
  gmtime_r(&now, &utc);
  char clock[40];
  if (!strftime(clock, sizeof(clock), "AT+CCLK=\"%y/%m/%d,%H:%M:%S+00\"", &utc)) return false;
  return modemOk(clock) &&
         modemOk("AT+CSSLCFG=\"sslversion\",0,3") &&
         modemOk("AT+CSSLCFG=\"authmode\",0,1") &&
         modemOk("AT+CSSLCFG=\"ignorelocaltime\",0,0") &&
         modemOk("AT+CSSLCFG=\"enableSNI\",0,1") &&
         modemOk("AT+CSSLCFG=\"negotiatetime\",0,10") &&
         modemOk(String("AT+CSSLCFG=\"cacert\",0,\"") + caFile + "\"");
}

bool cellularConfigured = false;
bool modemTlsReady = false;
bool modemHttpReady = false;

bool cellularReady() {
  String response;
  if (!command("AT+CPIN?", "+CPIN:", response, 1500) || response != "READY") return false;
  if (!cellularConfigured) {
    if (*EBT_CELLULAR_APN &&
        !modemOk(String("AT+CGDCONT=1,\"IP\",\"") + EBT_CELLULAR_APN + "\"")) return false;
    if ((*EBT_CELLULAR_USERNAME || *EBT_CELLULAR_PASSWORD) &&
        !modemOk(String("AT+CGAUTH=1,1,\"") + EBT_CELLULAR_PASSWORD + "\",\"" +
                 EBT_CELLULAR_USERNAME + "\"")) return false;
    cellularConfigured = true;
  }
  int mode, registration;
  return command("AT+CEREG?", "+CEREG:", response, 1500) &&
         sscanf(response.c_str(), "%d,%d", &mode, &registration) == 2 &&
         (registration == 1 || registration == 5);
}

bool startModemHttp() {
  if (modemHttpReady) return true;
  if (!cellularReady()) {
    Serial.println("Waiting for LTE registration");
    return false;
  }
  if (!modemTlsReady) {
    modemTlsReady = configureModemTls();
    if (!modemTlsReady) {
      Serial.println("Could not configure LTE certificate verification");
      return false;
    }
  }
  modemOk("AT+HTTPTERM", 1000);  // Recover a session left open across an ESP reset.
  modemHttpReady = modemOk("AT+HTTPINIT", 4000) &&
      modemOk(String("AT+HTTPPARA=\"URL\",\"") + EBT_API_URL + "\"") &&
      modemOk("AT+HTTPPARA=\"SSLCFG\",0") &&
      modemOk("AT+HTTPPARA=\"CONNECTTO\",20") &&
      modemOk("AT+HTTPPARA=\"RECVTO\",5") &&
      modemOk("AT+HTTPPARA=\"CONTENT\",\"application/json\"") &&
      modemOk(String("AT+HTTPPARA=\"USERDATA\",\"Authorization: Bearer ") + EBT_DEVICE_KEY + "\"");
  return modemHttpReady;
}

bool sendCellular(const String &payload, const char *sequence, bool currentVersion) {
  if (!startModemHttp() ||
      !modemUpload(String("AT+HTTPDATA=") + payload.length() + ",3000",
                   "DOWNLOAD", payload.c_str(), payload.length())) return false;
  String response;
  if (!command("AT+HTTPACTION=1", "+HTTPACTION:", response, 1500) ||
      (response.isEmpty() && !modemReply("+HTTPACTION:", response, 8000, nullptr))) return false;
  int method, status, length;
  if (sscanf(response.c_str(), "%d,%d,%d", &method, &status, &length) != 3 || method != 1) return false;
  if (status != 200 || length <= 0 || length > 1024) return acknowledged(status, "", sequence, "LTE", currentVersion);
  if (!command("AT+HTTPREAD=0,1024", nullptr, response, 1500) ||
      !modemReply("+HTTPREAD:", response, 1500, nullptr) || response.toInt() != length) return false;
  String body;
  body.reserve(length);
  const auto started = millis();
  while (body.length() < static_cast<size_t>(length) && millis() - started < 1500) {
    const int byte = modem.read();
    if (byte < 0) delay(1);
    else body += static_cast<char>(byte);
  }
  return body.length() == static_cast<size_t>(length) && acknowledged(status, body, sequence, "LTE", currentVersion);
}

constexpr unsigned long lteRetryInterval = 60000;
constexpr unsigned long wifiWindow = 30000;
unsigned long lastLteFailure = 0;
unsigned long wifiStarted = 0;
unsigned long lastWifiAttempt = 0;
unsigned int lteFailures = 0;
bool wifiOn = false;
bool wifiTried = false;
bool wifiOnly = false;

void stopWifi() {
  if (!wifiOn) return;
  WiFi.mode(WIFI_OFF);
  wifiOn = false;
}

void serviceWifi() {
  const auto now = millis();
  if (wifiOn && WiFi.status() == WL_CONNECTED) {
    wifiStarted = now;
    return;
  }
  if (wifiOn && !wifiOnly && WiFi.status() != WL_CONNECTED &&
      now - wifiStarted >= wifiWindow) {
    lastWifiAttempt = now;
    stopWifi();
  }
  if (wifiOn || (!wifiOnly && wifiTried && now - lastWifiAttempt < lteRetryInterval) ||
      !*EBT_WIFI_SSID) return;
  wifiTried = true;
  wifiStarted = lastWifiAttempt = now;
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(true);
  WiFi.setAutoReconnect(true);
  WiFi.begin(EBT_WIFI_SSID, EBT_WIFI_PASSWORD);
  wifiOn = true;
  if (!clockReady()) configTime(0, 0, "pool.ntp.org");
  Serial.println("Wi-Fi enabled");
}

bool sendPayload(JsonDocument &batch) {
  const char *sequence = batch["samples"][0]["sequence"];
  const bool currentVersion = batch["firmwareVersion"] == EBT_FIRMWARE_VERSION;
  String payload;
  if (!wifiOnly && (lteFailures < 3 || millis() - lastLteFailure >= lteRetryInterval)) {
    batch["transport"] = "4g";
    bool sent = false;
    auto upload = [&] {
      // Measure the upload link, including when replaying queued positions.
      static unsigned long lastSignalQuery = 0;
      static int signal = 99;
      if (lastSignalQuery == 0 || millis() - lastSignalQuery >= 15000) {
        lastSignalQuery = millis();
        String response;
        int rssi, ber;
        signal = command("AT+CSQ", "+CSQ:", response, 1000) &&
                 sscanf(response.c_str(), "%d,%d", &rssi, &ber) == 2 && rssi >= 0 && rssi <= 31
                   ? rssi : 99;
      }
      if (signal != 99) batch["cellularSignal"]["rssiDbm"] = -113 + 2 * signal;
      serializeJson(batch, payload);
      sent = sendCellular(payload, sequence, currentVersion);
      if (!sent) modemHttpReady = false;
    };
    onModem("LTE upload", upload);
    if (sent) {
      lteFailures = 0;
      wifiTried = false;
      if (!firmwareWifiNeeded()) stopWifi();
      return true;
    }
    lastLteFailure = millis();
    if (lteFailures < 3) ++lteFailures;
    Serial.println("LTE upload unavailable");
  }
  if (!wifiOnly && lteFailures < 3) return false;
  serviceWifi();
  if (!wifiOn || WiFi.status() != WL_CONNECTED) return false;
  batch["transport"] = "wifi";
  batch.remove("cellularSignal");
  payload = "";
  serializeJson(batch, payload);
  return sendWifi(payload, sequence, currentVersion);
}

// Status reports are useful only while fresh, so never queue them on microSD.
void sendNoGpsStatus(const char *reason) {
  constexpr unsigned long interval = 24000;
  static unsigned long lastSent = 0;
  static bool sent = false;
  const auto now = millis();
  if (!clockReady() || (sent && now - lastSent < interval)) return;
  JsonDocument batch;
  auto buildStatus = [&] {
    const char *currentReason = nullptr;
    if (xQueuePeek(gpsStatus, &currentReason, 0) != pdTRUE || currentReason != reason) return;
    const time_t currentTime = time(nullptr);
    tm utc{};
    gmtime_r(&currentTime, &utc);
    char timestamp[21];
    if (!strftime(timestamp, sizeof(timestamp), "%Y-%m-%dT%H:%M:%SZ", &utc)) return;
    auto sample = beginSample(batch, timestamp, readBatteryVoltage());
    sample["fixValid"] = false;
    sample["gpsStatusReason"] = reason;
    sample["satelliteCount"] = 0;
    sample["latitude"] = nullptr;
    sample["longitude"] = nullptr;
    sample["speedMps"] = nullptr;
    sample["headingDeg"] = nullptr;
  };
  onModem("GPS status", buildStatus);
  if (batch.isNull()) return;

  if (sendPayload(batch)) {
    sent = true;
    lastSent = now;
  }
}

bool readSequence(const String &payload, JsonDocument &batch) {
  if (deserializeJson(batch, payload) || batch["version"] != 1 || batch["deviceId"] != deviceId ||
      batch["samples"].size() != 1) return false;
  const char *sequence = batch["samples"][0]["sequence"];
  return sequence && strlen(sequence) == 43;
}

bool sendQueuedFile(const String &path) {
  String payload;
  auto load = [&] {
    File file = SD_MMC.open(path);
    if (file && file.size() <= maxRecordSize) payload = file.readString();
  };
  onStorage(load);

  JsonDocument batch;
  if (!payload.endsWith("\n") || !readSequence(payload, batch) || !sendPayload(batch)) return false;

  bool removed = false;
  auto remove = [&] { removed = SD_MMC.remove(path); };
  onStorage(remove);
  if (!removed) Serial.println("Could not remove acknowledged microSD record");
  return removed;
}

void sendQueued(unsigned long pollStarted) {
  String latestPath;
  String latestTimestamp;
  JsonDocument pendingBatch;
  const bool hasPending = !pending.isEmpty() && readSequence(pending, pendingBatch);
  if (hasPending) latestTimestamp = pendingBatch["samples"][0]["timestamp"].as<String>();

  // Scan by capture time, since directory order and boot IDs do not give
  // chronological order. Keep only enough paths for one pass of backfill.
  String historyPaths[uploadsPerPoll - 1];
  int count = 0;
  if (cardReady) {
    auto scan = [&] {
      File directory = SD_MMC.open(queueDir);
      while (directory && directory.isDirectory()) {
        File file = directory.openNextFile();
        if (!file) break;
        if (file.isDirectory() || !String(file.name()).endsWith(".json") || file.size() > maxRecordSize) continue;
        const String payload = file.readString();
        JsonDocument batch;
        if (!payload.endsWith("\n") || !readSequence(payload, batch)) continue;
        const String timestamp = batch["samples"][0]["timestamp"].as<String>();
        if (timestamp.length() != 20) continue;
        String path = file.path();
        if (timestamp > latestTimestamp) {
          latestTimestamp = timestamp;
          const String previousPath = latestPath;
          latestPath = path;
          path = previousPath;
        }
        if (!path.isEmpty() && count < uploadsPerPoll - 1) historyPaths[count++] = path;
      }
      directory.close();
    };
    onStorage(scan);
  }

  if (!latestPath.isEmpty() && !sendQueuedFile(latestPath)) return;
  if (hasPending && (latestPath.isEmpty() || millis() - pollStarted < pollInterval)) {
    if (!sendPayload(pendingBatch)) return;
    pending = "";
  }
  const int historyLimit = uploadsPerPoll - (hasPending ? 1 : 0) - (latestPath.isEmpty() ? 0 : 1);
  for (int i = 0; i < count && i < historyLimit && !uxQueueMessagesWaiting(captures) &&
       millis() - pollStarted < pollInterval; ++i) {
    if (!sendQueuedFile(historyPaths[i])) break;
  }
}
void storageTask(void *) {
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    // Bound each pass so the uploader can read and acknowledge card records.
    unsigned int waiting = uxQueueMessagesWaiting(captures);
    while (waiting--) {
      CaptureRecord record;
      if (xQueuePeek(captures, &record, 0) != pdTRUE) break;
      // Keep a capture queued if both the card and RAM fallback are unavailable.
      if ((!cardReady || !queueOnCard(record.payload)) &&
          xQueueSend(ramDelivery, &record, 0) != pdTRUE) break;
      xQueueReceive(captures, &record, 0);
    }
    DeviceJob job;
    if (xQueueReceive(storageJobs, &job, 0) == pdTRUE) {
      job.run(job.context);
      xTaskNotifyGive(job.caller);
    }
  }
}

void deliveryTask(void *) {
  for (;;) {
    const auto started = millis();
    checkFirmwareTrial();
    if (pending.isEmpty()) {
      CaptureRecord record;
      if (xQueueReceive(ramDelivery, &record, 0) == pdTRUE) {
        pending = record.payload;
        xTaskNotifyGive(storageOwner);
      }
    }
    if (wifiOnly || lteFailures >= 3 || firmwareWifiNeeded() ||
        (!clockReady() && millis() >= 24000)) serviceWifi();
    if (wifiOnly || clockReady()) sendQueued(started);
    const char *reason = nullptr;
    if (xQueuePeek(gpsStatus, &reason, 0) == pdTRUE && reason) sendNoGpsStatus(reason);
    serviceFirmwareUpdate(!wifiOnly && clockReady());
    const auto elapsed = millis() - started;
    if (elapsed < pollInterval) delay(pollInterval - elapsed);
    else delay(1);
  }
}
}  // namespace

static bool readCellularFirmwareChunkOnModem(const String &url, uint8_t *data, size_t length) {
  const auto started = millis();
  const bool configured = startModemHttp() &&
      modemOk(String("AT+HTTPPARA=\"URL\",\"") + url + "\"");
  const auto httpStarted = millis();
  String response;
  int method, status, bytes;
  const bool httpReady = configured && command("AT+HTTPACTION=0", "+HTTPACTION:", response, 1500) &&
      (!response.isEmpty() || modemReply("+HTTPACTION:", response, 8000, nullptr)) &&
      sscanf(response.c_str(), "%d,%d,%d", &method, &status, &bytes) == 3 &&
      method == 0 && status == 200 && bytes == static_cast<int>(length);
  const auto uartStarted = millis();
  const bool ready = httpReady &&
      command((String("AT+HTTPREAD=0,") + length).c_str(), nullptr, response, 1500) &&
      modemReply("+HTTPREAD:", response, 1500, nullptr) && response.toInt() == static_cast<int>(length);
  size_t received = 0;
  if (ready) {
    const auto readStarted = millis();
    while (received < length && millis() - readStarted < 2500) {
      const int byte = modem.read();
      if (byte < 0) delay(1);
      else data[received++] = static_cast<uint8_t>(byte);
    }
  }
  const bool complete = received == length &&
      modemReply("+HTTPREAD:", response, 1000, nullptr) && response == "0";
  const auto restoreStarted = millis();
  const bool restored = complete && modemOk(String("AT+HTTPPARA=\"URL\",\"") + EBT_API_URL + "\"");
  const auto finished = millis();
  if (!restored) modemHttpReady = false;
  Serial.printf("OTA 4G read: %u/%u bytes, setup=%lu ms, HTTP=%lu ms, UART=%lu ms, restore=%lu ms, result=%s\n",
                static_cast<unsigned>(received), static_cast<unsigned>(length), httpStarted - started,
                uartStarted - httpStarted, restoreStarted - uartStarted, finished - restoreStarted,
                restored ? "ok" : "failed");
  return restored;
}

bool readCellularFirmwareChunk(const String &url, uint8_t *data, size_t length) {
  bool received = false;
  auto download = [&] { received = readCellularFirmwareChunkOnModem(url, data, length); };
  onModem("LTE OTA chunk", download);
  return received;
}

void setup() {
  Serial.begin(baud);
  beginFirmwareTrial();
  Wire.begin(15, 16);
  modem.begin(baud, SERIAL_8N1, modemRx, modemTx);
  SD_MMC.setPins(5, 4, 6);
  cardReady = SD_MMC.begin("/sdcard", true) &&
              (SD_MMC.exists(queueDir) || SD_MMC.mkdir(queueDir));
  WiFi.persistent(false);
  WiFi.setHostname(deviceId);
  WiFi.mode(WIFI_OFF);
  wifiOnly = !EBT_LTE_ENABLED || !String(EBT_API_URL).startsWith("https://");
  if (wifiOnly) serviceWifi();

  randomId(bootId);
  randomId(sessionId);
  delay(1500);
  Serial.printf("EBT %s · %s · %s\n", EBT_FIRMWARE_VERSION, deviceId, wifiOnly ? "Wi-Fi only" : "LTE first");
  Serial.println(cardReady ? "microSD queue ready" : "microSD unavailable. Using RAM for retries.");
  String response;
  while (!command("AT", nullptr, response, 1500)) {
    checkFirmwareTrial();
    delay(1000);
  }
  while (!command("AT+CGNSSPWR=1", nullptr, response, 10000)) {
    if (command("AT+CGNSSPWR?", "+CGNSSPWR:", response, 2000) && response == "1") break;
    checkFirmwareTrial();
    delay(2000);
  }
  Serial.println("GNSS enabled");
  if (!wifiOnly) modemOk("AT+CTZU=1");
  captures = xQueueCreate(cardReady ? cardCaptureQueueCapacity : 1, sizeof(CaptureRecord));
  gpsStatus = xQueueCreate(1, sizeof(const char *));
  modemJobs = xQueueCreate(1, sizeof(DeviceJob));
  storageJobs = xQueueCreate(1, sizeof(DeviceJob));
  ramDelivery = xQueueCreate(1, sizeof(CaptureRecord));
  if (!captures || !gpsStatus || !modemJobs || !storageJobs || !ramDelivery ||
      xTaskCreate(storageTask, "ebt-storage", 8192, nullptr, 1, &storageOwner) != pdPASS ||
      xTaskCreate(deliveryTask, "ebt-delivery", 12288, nullptr, 1, nullptr) != pdPASS) {
    Serial.println("Could not start telemetry tasks. Restarting.");
    delay(1000);
    ESP.restart();
  }
}

void loop() {
  static unsigned long lastPoll = millis() - pollInterval;
  static unsigned long lastFreshFixAt = millis();
  static unsigned long lastTimingReport = millis();
  static unsigned long maxPollGap = 0, maxModemTime = 0;
  static unsigned int peakQueue = 0, fullPolls = 0;

  const auto now = millis();
  if (now - lastPoll >= pollInterval) {
    maxPollGap = max(maxPollGap, now - lastPoll);
    lastPoll = now;
    if (uxQueueSpacesAvailable(captures)) {
      String payload;
      const char *reason = capture(payload);
      const auto finished = millis();
      if (reason) {
        Serial.printf("GPS skipped: %s\n", reason);
      } else {
        CaptureRecord record;
        if (payload.length() < sizeof(record.payload)) {
          payload.toCharArray(record.payload, sizeof(record.payload));
          xQueueSend(captures, &record, 0);
          xTaskNotifyGive(storageOwner);
          peakQueue = max(peakQueue, static_cast<unsigned int>(uxQueueMessagesWaiting(captures)));
        } else {
          Serial.println("GPS capture exceeded the queue record size");
        }
        lastFreshFixAt = finished;
      }
      const char *status = finished - lastFreshFixAt >= gpsLossInterval ? reason : nullptr;
      xQueueOverwrite(gpsStatus, &status);
    } else {
      ++fullPolls;
      // Storage backpressure gives no evidence about current GNSS health.
      const char *status = nullptr;
      xQueueOverwrite(gpsStatus, &status);
    }
    if (!wifiOnly && !clockReady()) syncModemTime();
    if (now - lastTimingReport >= 30000) {
      Serial.printf("GPS timing: max poll gap=%lu ms, max modem job=%lu ms, queue peak=%u/%u, full polls=%u\n",
                    maxPollGap, maxModemTime, peakQueue, cardReady ? cardCaptureQueueCapacity : 1U, fullPolls);
      lastTimingReport = now;
      maxPollGap = maxModemTime = 0;
      peakQueue = uxQueueMessagesWaiting(captures);
      fullPolls = 0;
    }
  }

  const auto elapsed = millis() - lastPoll;
  // Let one waiting transaction through even if this GPS poll overran.
  const auto wait = elapsed < pollInterval ? pdMS_TO_TICKS(pollInterval - elapsed) : 0;
  DeviceJob job;
  if (xQueueReceive(modemJobs, &job, wait) == pdTRUE) {
    const auto started = millis();
    job.run(job.context);
    const auto duration = millis() - started;
    maxModemTime = max(maxModemTime, duration);
    if (duration >= pollInterval) Serial.printf("%s took %lu ms\n", job.label, duration);
    xTaskNotifyGive(job.caller);
  }
}
