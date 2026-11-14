#pragma once

#ifndef EBT_LTE_ENABLED
#define EBT_LTE_ENABLED 1
#endif

#ifndef EBT_FIRMWARE_VERSION
#if EBT_LTE_ENABLED
#define EBT_FIRMWARE_VERSION "dual-link-0.5.5"
#else
#define EBT_FIRMWARE_VERSION "wifi-only-0.5.1"
#endif
#endif

static_assert(EBT_LTE_ENABLED == 0 || EBT_LTE_ENABLED == 1, "EBT_LTE_ENABLED must be 0 or 1");
