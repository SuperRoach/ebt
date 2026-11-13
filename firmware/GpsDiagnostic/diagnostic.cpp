#include <Arduino.h>
#include <cstdlib>

namespace {
constexpr int modemRx = 17;
constexpr int modemTx = 18;
constexpr unsigned long baud = 115200;
constexpr unsigned long pollInterval = 5000;
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

void showFix(const String &data) {
  String fields[6];
  int start = 0;
  for (auto &field : fields) {
    const int end = data.indexOf(',', start);
    if (end < 0) {
      Serial.println("Unexpected GPS response");
      return;
    }
    field = data.substring(start, end);
    field.trim();
    start = end + 1;
  }
  if (fields[0].isEmpty()) {
    Serial.println("Waiting for GPS fix");
    return;
  }

  double latitude, longitude;
  if (!coordinate(fields[0], fields[1], 'N', 'S', 90, latitude) ||
      !coordinate(fields[2], fields[3], 'E', 'W', 180, longitude) ||
      fields[4].length() != 6 || fields[5].length() < 6) {
    Serial.println("Unexpected GPS coordinates or timestamp");
    return;
  }
  for (int i = 0; i < 6; ++i) {
    if (!isDigit(fields[4][i]) || !isDigit(fields[5][i])) {
      Serial.println("Unexpected GPS timestamp");
      return;
    }
  }
  const String &date = fields[4];
  const String &time = fields[5];
  Serial.printf("GPS fix 20%.2s-%.2s-%.2sT%.2s:%.2s:%.2sZ  lat=%.6f lon=%.6f\n",
                date.c_str() + 4, date.c_str() + 2, date.c_str(),
                time.c_str(), time.c_str() + 2, time.c_str() + 4, latitude, longitude);
}
}  // namespace

void setup() {
  Serial.begin(baud);
  modem.begin(baud, SERIAL_8N1, modemRx, modemTx);
  delay(1500);
  Serial.println("EBT GPS diagnostic · Waveshare ESP32-S3 SIM7670G V2");
  String response;
  while (!command("AT", nullptr, response, 1500)) {
    Serial.println("Waiting for SIM7670G. Check that 4G power is on.");
    delay(1000);
  }
  Serial.println("SIM7670G responded");
  while (!command("AT+CGNSSPWR=1", nullptr, response, 10000)) {
    // Some modem firmware reports an error if GNSS is already on.
    if (command("AT+CGNSSPWR?", "+CGNSSPWR:", response, 2000) && response == "1") break;
    delay(2000);
  }
  Serial.println("GNSS enabled. Searching for satellites.");
}

void loop() {
  String response;
  if (command("AT+CGPSINFO", "+CGPSINFO:", response, 10000)) {
    if (response.isEmpty()) Serial.println("Waiting for GPS fix");
    else showFix(response);
  }
  delay(pollInterval);
}
