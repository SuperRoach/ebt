#pragma once

#include <ArduinoJson.h>

void beginFirmwareTrial();
void checkFirmwareTrial();
void acceptFirmwareOffer(JsonVariantConst offer);
bool firmwareWifiNeeded();
void serviceFirmwareUpdate();
