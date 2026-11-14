#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <NetworkClientSecure.h>
#include <SD_MMC.h>
#include <WiFi.h>
#include <Wire.h>
#include <esp_random.h>
#include <fcntl.h>
#include <sys/time.h>
#include <unistd.h>

#include "../include/secrets.h"
#include "build_config.h"
#include "ota.h"
#include "telemetry_ca.h"

namespace {
constexpr int modemRx = 17;
constexpr int modemTx = 18;
constexpr unsigned long baud = 115200;
constexpr unsigned long pollInterval = 8000;
HardwareSerial modem(1);

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
constexpr size_t maxRecordSize = 1024;
constexpr int uploadsPerPoll = 8;
char bootId[33], sessionId[33];
uint32_t counter = 0;
bool cardReady = false;
String pending;
String lastTimestamp;

void randomId(char (&id)[33]) {
  for (int i = 0; i < 4; ++i) snprintf(id + 8 * i, 9, "%08lx", (unsigned long)esp_random());
}

bool splitFields(const String &data, String *fields, size_t count) {
  int start = 0;
  for (size_t i = 0; i < count; ++i) {
    const int end = data.indexOf(',', start);
    fields[i] = end < 0 ? data.substring(start) : data.substring(start, end);
    fields[i].trim();
    if (end < 0) return i + 1 == count;
    start = end + 1;
  }
  return true;
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
  batch["batteryVoltage"] = battery;
  auto sample = batch["samples"].to<JsonArray>().add<JsonObject>();
  sample["sequence"] = sequence;
  sample["timestamp"] = timestamp;
  return sample;
}

bool clockReady() {
  return time(nullptr) >= 1735689600;  // Reject the unset clock at startup.
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

void capture() {
  String response;
  String gps[9];
  if (!command("AT+CGPSINFO", "+CGPSINFO:", response, 10000) ||
      !splitFields(response, gps, 9) || gps[0].isEmpty()) {
    Serial.println("Waiting for GPS fix");
    return;
  }

  char timestamp[21];
  double latitude, longitude, knots, heading;
  if (!coordinate(gps[0], gps[1], 'N', 'S', 90, latitude) ||
      !coordinate(gps[2], gps[3], 'E', 'W', 180, longitude) ||
      !utcTimestamp(gps[4], gps[5], timestamp) ||
      !number(gps[7], knots) || knots < 0 || !number(gps[8], heading) || heading < 0 || heading > 360) {
    Serial.println("Waiting for complete GPS data");
    return;
  }
  if (lastTimestamp == timestamp) return;
  // A valid GNSS fix gives TLS a clock even with neither uplink available.
  tm utc{};
  if (strptime(timestamp, "%Y-%m-%dT%H:%M:%SZ", &utc)) {
    const timeval now{mktime(&utc), 0};  // ESP32 boots with the UTC timezone.
    settimeofday(&now, nullptr);
  }

  String gnss[18];
  double satellites, hdop;
  if (!command("AT+CGNSSINFO", "+CGNSSINFO:", response, 10000) ||
      !splitFields(response, gnss, 18) || !number(gnss[17], satellites) ||
      satellites < 1 || satellites > 255 || floor(satellites) != satellites) {
    Serial.printf("GPS fix received. Waiting for satellite count (%s)\n", response.isEmpty() ? "empty GNSS response" : "incomplete GNSS response");
    return;
  }

  const double battery = readBatteryVoltage();
  if (!isfinite(battery)) {
    Serial.println("Could not read the battery voltage");
    return;
  }

  JsonDocument batch;
  auto sample = beginSample(batch, timestamp, battery);
  sample["latitude"] = latitude;
  sample["longitude"] = longitude;
  sample["speedMps"] = knots * 0.514444;
  sample["headingDeg"] = heading == 360 ? 0 : heading;
  sample["fixValid"] = true;
  sample["satelliteCount"] = static_cast<int>(satellites);
  if (number(gnss[15], hdop) && hdop >= 0) sample["hdop"] = hdop;
  serializeJson(batch, pending);
  lastTimestamp = timestamp;
  Serial.printf("Captured GPS fix at %s with %d satellites\n", timestamp, static_cast<int>(satellites));
}

bool queueOnCard(const String &payload) {
  char filename[64];
  // A separate file per fix lets us remove an acknowledged record independently.
  snprintf(filename, sizeof(filename), "%s/%s-%010lu.json", queueDir, bootId, (unsigned long)counter);
  const String path = String("/sdcard") + filename;
  const int fd = open(path.c_str(), O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0) return false;
  const String record = payload + '\n';
  const bool synced = write(fd, record.c_str(), record.length()) == static_cast<ssize_t>(record.length()) &&
                      fsync(fd) == 0;
  const bool closed = close(fd) == 0;
  if (!synced || !closed) {
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
    if (sendCellular(payload, sequence, currentVersion)) {
      lteFailures = 0;
      wifiTried = false;
      if (!firmwareWifiNeeded()) stopWifi();
      return true;
    }
    modemHttpReady = false;
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
void sendNoGpsStatus() {
  constexpr unsigned long interval = 24000;
  static unsigned long lastSent = 0;
  static bool sent = false;
  const auto now = millis();
  if (!clockReady() || (sent && now - lastSent < interval)) return;
  const double battery = readBatteryVoltage();
  if (!isfinite(battery)) return;

  const time_t currentTime = time(nullptr);
  tm utc{};
  gmtime_r(&currentTime, &utc);
  char timestamp[21];
  if (!strftime(timestamp, sizeof(timestamp), "%Y-%m-%dT%H:%M:%SZ", &utc)) return;
  JsonDocument batch;
  auto sample = beginSample(batch, timestamp, battery);
  sample["fixValid"] = false;
  sample["satelliteCount"] = 0;
  sample["latitude"] = nullptr;
  sample["longitude"] = nullptr;
  sample["speedMps"] = nullptr;
  sample["headingDeg"] = nullptr;

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

void sendQueued(unsigned long pollStarted) {
  File directory = SD_MMC.open(queueDir);
  if (!directory || !directory.isDirectory()) return;
  // Close the directory before deleting any file. FAT directory iteration
  // is then independent of whether the upload removed an entry.
  String paths[uploadsPerPoll];
  int count = 0;
  while (count < uploadsPerPoll) {
    File file = directory.openNextFile();
    if (!file) break;
    if (file.isDirectory() || !String(file.name()).endsWith(".json")) continue;
    if (file.size() > maxRecordSize) continue;
    const String payload = file.readString();
    JsonDocument batch;
    if (!payload.endsWith("\n") || !readSequence(payload, batch)) {
      Serial.println("Skipping an incomplete microSD record");
      continue;
    }
    paths[count++] = file.path();
  }
  directory.close();

  for (int i = 0; i < count; ++i) {
    File file = SD_MMC.open(paths[i]);
    if (!file || file.size() > maxRecordSize) continue;
    const String payload = file.readString();
    file.close();
    JsonDocument batch;
    if (!payload.endsWith("\n") || !readSequence(payload, batch)) continue;
    if (!sendPayload(batch)) break;
    const bool pollDue = millis() - pollStarted >= pollInterval;
    if (!SD_MMC.remove(paths[i])) {
      Serial.println("Could not remove acknowledged microSD record");
      break;
    }
    if (pollDue) break;
  }
}
}  // namespace

void setup() {
  Serial.begin(baud);
  beginFirmwareTrial();
  Wire.begin(15, 16);
  modem.begin(baud, SERIAL_8N1, modemRx, modemTx);
  SD_MMC.setPins(5, 4, 6);
  cardReady = SD_MMC.begin("/sdcard", true) &&
              (SD_MMC.exists(queueDir) || SD_MMC.mkdir(queueDir));
  WiFi.persistent(false);
  WiFi.mode(WIFI_OFF);
  wifiOnly = !EBT_LTE_ENABLED || !String(EBT_API_URL).startsWith("https://");
  if (wifiOnly) serviceWifi();

  randomId(bootId);
  randomId(sessionId);
  delay(1500);
  Serial.printf("EBT %s · %s · %s\n", EBT_FIRMWARE_VERSION, deviceId, wifiOnly ? "Wi-Fi only" : "LTE first");
  Serial.println(cardReady ? "microSD queue ready" : "microSD unavailable. Using one RAM retry slot.");
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
}

void loop() {
  checkFirmwareTrial();
  const auto pollStarted = millis();
  bool capturedFix = false;
  if (pending.isEmpty()) {
    capture();
    capturedFix = !pending.isEmpty();
  }
  if (!clockReady() && !wifiOnly) {
    syncModemTime();
    if (!clockReady() && millis() >= 24000) serviceWifi();
  }
  if (cardReady && !pending.isEmpty()) {
    if (queueOnCard(pending)) pending = "";
    else Serial.println("microSD write failed. Holding current fix in RAM.");
  }
  if (wifiOnly || lteFailures >= 3 || firmwareWifiNeeded()) serviceWifi();
  if (wifiOnly || clockReady()) {
    if (cardReady) sendQueued(pollStarted);
    if (!pending.isEmpty() && millis() - pollStarted < pollInterval) {
      JsonDocument batch;
      if (readSequence(pending, batch) && sendPayload(batch)) pending = "";
    }
  }
  // Require two missed polls before reporting GPS loss to avoid flashing
  // the status on and off when one reading is incomplete.
  static unsigned int missedPolls = 0;
  if (capturedFix) missedPolls = 0;
  else if (pending.isEmpty() && missedPolls < 2) ++missedPolls;
  if (missedPolls == 2 && millis() - pollStarted < pollInterval) sendNoGpsStatus();
  serviceFirmwareUpdate();
  const auto elapsed = millis() - pollStarted;
  if (elapsed < pollInterval) delay(pollInterval - elapsed);
}
