#pragma once

#include <ArduinoJson.h>

void beginFirmwareTrial();
void checkFirmwareTrial();
void acceptFirmwareOffer(JsonVariantConst offer);
bool firmwareWifiNeeded();
bool readCellularFirmwareChunk(const String &url, uint8_t *data, size_t length);
void serviceFirmwareUpdate(bool cellularEnabled);
