#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <SD_MMC.h>
#include <WiFi.h>
#include <Wire.h>
#include <esp_random.h>
#include <fcntl.h>
#include <unistd.h>

#include "../include/secrets.h"

namespace {
constexpr int modemRx = 17;
constexpr int modemTx = 18;
constexpr unsigned long baud = 115200;
constexpr unsigned long pollInterval = 10000;
HardwareSerial modem(1);

bool command(const char *request, const char *prefix, String &data, unsigned long timeout) {
  while (modem.available()) modem.read();
  modem.print(request);
  modem.print("\r\n");
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
    if (byte == '\r') continue;
    if (byte != '\n') {
      if (line.length() < 200 && !discard) line += static_cast<char>(byte);
      else discard = true;
      continue;
    }
    if (!discard) {
      line.trim();
      if (line == "OK") return true;
      if (line == "ERROR" || line.startsWith("+CME ERROR:")) {
        Serial.printf("%s returned %s\n", request, line.c_str());
        return false;
      }
      if (prefix && line.startsWith(prefix)) {
        data = line.substring(strlen(prefix));
        data.trim();
      }
    }
    line = "";
    discard = false;
  }
  Serial.printf("%s timed out\n", request);
  return false;
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

constexpr char deviceId[] = "lps-ebt-01";
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

  if (counter == UINT32_MAX) {
    randomId(bootId);
    counter = 0;
  }
  char sequence[44];
  snprintf(sequence, sizeof(sequence), "%s:%010lu", bootId, (unsigned long)++counter);
  JsonDocument batch;
  batch["version"] = 1;
  batch["deviceId"] = deviceId;
  batch["firmwareVersion"] = "wifi-test-0.2.0";
  batch["recordingSessionId"] = sessionId;
  batch["recordingState"] = "recording";
  batch["transport"] = "wifi";
  batch["batteryVoltage"] = battery;
  auto sample = batch["samples"].to<JsonArray>().add<JsonObject>();
  sample["sequence"] = sequence;
  sample["timestamp"] = timestamp;
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

bool sendPayload(const String &payload, const char *sequence) {
  NetworkClient network;
  HTTPClient http;
  http.setConnectTimeout(3000);
  http.setTimeout(3000);
  if (!http.begin(network, EBT_API_URL)) {
    Serial.println("Could not configure HTTP connection");
    return false;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + EBT_DEVICE_KEY);
  const int status = http.POST(payload);
  bool accepted = false;
  if (status == 200) {
    JsonDocument ack;
    if (!deserializeJson(ack, http.getString()) && ack["version"] == 1 &&
        ack["deviceId"] == deviceId && ack["accepted"][0]["sequence"] == sequence &&
        (ack["accepted"][0]["status"] == "stored" || ack["accepted"][0]["status"] == "duplicate")) {
      Serial.printf("Server acknowledged %s as %s\n", sequence, ack["accepted"][0]["status"].as<const char *>());
      accepted = true;
    } else {
      Serial.println("Server returned an unexpected acknowledgement");
    }
  } else {
    Serial.printf("Upload returned %d. Retaining sample for retry.\n", status);
  }
  http.end();
  return accepted;
}

bool readSequence(const String &payload, JsonDocument &batch) {
  if (deserializeJson(batch, payload) || batch["version"] != 1 || batch["deviceId"] != deviceId ||
      batch["samples"].size() != 1) return false;
  const char *sequence = batch["samples"][0]["sequence"];
  return sequence && strlen(sequence) == 43;
}

void sendQueued() {
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
    if (!sendPayload(payload, batch["samples"][0]["sequence"].as<const char *>())) break;
    if (!SD_MMC.remove(paths[i])) {
      Serial.println("Could not remove acknowledged microSD record");
      break;
    }
  }
}
}  // namespace

void setup() {
  Serial.begin(baud);
  Wire.begin(15, 16);
  modem.begin(baud, SERIAL_8N1, modemRx, modemTx);
  SD_MMC.setPins(5, 4, 6);
  cardReady = SD_MMC.begin("/sdcard", true) &&
              (SD_MMC.exists(queueDir) || SD_MMC.mkdir(queueDir));
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(EBT_WIFI_SSID, EBT_WIFI_PASSWORD);

  randomId(bootId);
  randomId(sessionId);
  delay(1500);
  Serial.println("EBT Wi-Fi telemetry · lps-ebt-01");
  Serial.println(cardReady ? "microSD queue ready" : "microSD unavailable. Using one RAM retry slot.");
  String response;
  while (!command("AT", nullptr, response, 1500)) delay(1000);
  while (!command("AT+CGNSSPWR=1", nullptr, response, 10000)) {
    if (command("AT+CGNSSPWR?", "+CGNSSPWR:", response, 2000) && response == "1") break;
    delay(2000);
  }
  Serial.println("GNSS enabled");
}

void loop() {
  if (pending.isEmpty()) capture();
  if (cardReady && !pending.isEmpty()) {
    if (queueOnCard(pending)) pending = "";
    else Serial.println("microSD write failed. Holding current fix in RAM.");
  }
  if (WiFi.status() == WL_CONNECTED) {
    if (cardReady) sendQueued();
    if (!pending.isEmpty()) {
      JsonDocument batch;
      if (readSequence(pending, batch) &&
          sendPayload(pending, batch["samples"][0]["sequence"].as<const char *>())) pending = "";
    }
  }
  delay(pollInterval);
}
