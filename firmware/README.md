# EBT GPS diagnostic

This Arduino sketch reads the onboard SIM7670G over UART1 and logs GPS fix status, UTC time, and decimal coordinates. It targets the Waveshare ESP32-S3 SIM7670G V2.0 and runs locally over USB.

Use the board's UART download mode and turn on the 4G power switch. Connect the ceramic antenna to the GNSS connector and give it a clear view of the sky. Open the serial monitor at 115200 baud.

With Arduino CLI and Espressif's ESP32 board index configured:

```sh
arduino-cli core install esp32:esp32@3.3.4
arduino-cli compile --fqbn esp32:esp32:esp32s3:FlashSize=16M,FlashMode=qio,PSRAM=opi,CDCOnBoot=default --output-dir /tmp/ebt-gps-build firmware/GpsDiagnostic
arduino-cli upload --fqbn esp32:esp32:esp32s3:FlashSize=16M,FlashMode=qio,PSRAM=opi,CDCOnBoot=default --input-dir /tmp/ebt-gps-build --port /dev/cu.usbmodemYOURPORT firmware/GpsDiagnostic
arduino-cli monitor --port /dev/cu.usbmodemYOURPORT --config baudrate=115200
```

On Apple Silicon, if Arduino CLI reports `bad CPU type in executable` for
`ctags`, add `--build-property tools.ctags.pattern=/usr/bin/true` to the compile
command. The diagnostic is in a C++ source file and needs no generated prototypes.

The [Waveshare V2 examples](https://docs.waveshare.com/ESP32-S3-SIM7670G-4G/ESP-IDF) map modem RX and TX to GPIO17 and GPIO18 on the ESP32-S3. The [SIM767XX AT command manual](https://files.waveshare.com/wiki/ESP32-S3-SIM7670G-4G/SIM767XX_Series_AT_Command_Manual_V1.01.pdf) describes the GNSS commands and coordinate format.

## Tracker telemetry

From the repository root, create a private local config from the profile for the tracker being
built. The two profiles share the same sketch but have distinct device IDs and API keys:

```sh
cp -n firmware/profiles/tracker-01/secrets.h.example firmware/profiles/tracker-01/secrets.h
```

For Tracker 02, create `firmware/profiles/tracker-02/secrets.h` from its matching example instead.
In each private local profile, set the Wi-Fi credentials and the matching `EBT_DEVICE_KEY` from
`server/.env`. Do not use Tracker 01's key for Tracker 02. Before compiling, copy only the target
profile into the include path used by the shared sketch:

```sh
cp firmware/profiles/tracker-01/secrets.h firmware/include/secrets.h
```

For Tracker 02, use its corresponding `secrets.h` in that command. Use
`https://ebt.fly.dev/api/v1/telemetry` for LTE and Wi-Fi uploads. The firmware trusts ISRG Root X1,
which anchors the site's current Let's Encrypt certificate chain. Leave the APN fields empty to use
the modem's existing configuration. If the carrier requires an explicit APN or PAP credentials,
fill them in before compiling.

For Wi-Fi-only bench testing, set `EBT_API_URL` to the Mac's LAN HTTP address ending in `:3001/api/v1/telemetry`. Set `TELEMETRY_HOST` to the Mac's Wi-Fi IPv4 address in `server/.env` and run `npm start` from the root. Use a trusted 2.4 GHz network that lets the tracker reach the Mac.

Install `ArduinoJson@7.4.2` with Arduino CLI. Compile and upload as above using the
`firmware/WifiTelemetry` sketch and add `,PartitionScheme=huge_app` to the board options. Build one
tracker profile at a time, using a separate output directory such as
`/tmp/ebt-build-tracker-01` or `/tmp/ebt-build-tracker-02`. The serial monitor prints the selected
device ID and reports captures and server acknowledgements. Check the stored fix on the dashboard
for the API you configured.

The tracker targets one GPS poll every 8 seconds. If a modem command or queue upload runs long, the next poll starts as soon as the work finishes. Wi-Fi automatically reconnects to the configured network after a dropout.

## OTA rollout groundwork

The API now supports uploading a `.bin` from Device admin and assigning that release to exactly one selected tracker. It stores artifacts under `FIRMWARE_STORAGE_DIR` (the Fly deployment uses `/data/firmware` on the persistent volume), returns an update offer only to that tracker's authenticated telemetry requests, and requires the same device key to download the artifact. Upload a distinct version for each tracker profile because each image currently contains that tracker's device ID and API key.

The current tracker firmware does not yet consume the update offer or install the binary. Do not rely on the upload action to update a board yet. The next firmware step is adding an OTA-capable partition layout and a verified download/install path; the first USB flash will need to install that layout and OTA-enabled firmware before remote updates can run. Keep using the documented USB compile/upload procedure until that firmware step is complete.

Insert a FAT32 microSD card before powering on the tracker. The firmware saves each fix in `/ebt-queue` and deletes the file after the server acknowledges its sequence. The tracker scans that directory again after a reboot and retries queued fixes with their original sequences. Without a usable card the tracker can retry one sample in RAM.

The local header and firmware build outputs are ignored; both can contain credentials. Keep them private and save any microSD queue copies or serial GPS exports under an ignored directory such as `recordings/`.

## Preparing a SIM for field testing

With the board powered off, insert an activated data SIM and connect the LTE antenna. Keep the GNSS antenna connected and enable the 4G power switch. Follow the [Waveshare modem AT test](https://docs.waveshare.com/ESP32-S3-SIM7670G-4G/Windows) using the modem's own USB connection. The ESP telemetry serial monitor prints logs; it does not forward typed AT commands.

- `AT+CPIN?` should report `READY`. This firmware has no SIM PIN entry.
- `AT+CEREG?` should report registration status 1 (home) or 5 (roaming).
- `AT+CGPADDR=1` should show an assigned data address if the carrier uses context 1. If it does not, check the plan and the carrier's APN, then try a public HTTPS request using the vendor example.

With an HTTPS URL, the tracker starts with Wi-Fi off. After three failed LTE upload attempts it enables Wi-Fi and automatically reconnects when the network returns. It retries LTE about once a minute, then turns Wi-Fi off after an LTE upload is acknowledged. If Wi-Fi cannot connect for 30 seconds, it pauses Wi-Fi attempts for a minute. The microSD queue retains unacknowledged fixes with their original sequence IDs.

After two missed GPS polls, the tracker can send a status update about every 24 seconds while GPS is unavailable. The dashboard shows the connection and keeps the last known position. Status updates are sent live and skipped when offline. GPS, cellular network time, or Wi-Fi time sync can set the clock for HTTPS and status timestamps. Watch the serial monitor for `LTE acknowledged` or `Wi-Fi acknowledged` to confirm delivery.
