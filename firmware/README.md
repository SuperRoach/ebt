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

## Wi-Fi telemetry test

From the repository root, copy the template if you do not already have a local header:

```sh
cp -n firmware/include/secrets.h.example firmware/include/secrets.h
```

In `firmware/include/secrets.h`, set the Wi-Fi credentials, the full `EBT_API_URL` (use the Mac's Wi-Fi IPv4 address and keep `/api/v1/telemetry` at the end), and the `EBT_DEVICE_KEY` for `lps-ebt-01` from the server configuration. If upgrading a checkout that used `WifiTelemetry/local_config.h`, copy the old Wi-Fi fields and device key and use the old host and port to construct the URL. The APN, username and password fields are reserved for cellular uploads; the current sketch sends telemetry over Wi-Fi only.

Use a 2.4 GHz network that permits the tracker to reach the Mac. Set `TELEMETRY_HOST` to the Mac's Wi-Fi IPv4 address in `server/.env`, then run `npm start` from the root. This opens port 3001 for authenticated uploads while the read API and WebSocket stay on localhost. Use this HTTP setup on a trusted test network.

Install `ArduinoJson@7.4.2` with Arduino CLI. Compile and upload as above using the `firmware/WifiTelemetry` sketch and add `,PartitionScheme=huge_app` to the board options. The serial monitor reports captures and server acknowledgements. Check the stored fix at `http://127.0.0.1:3000/api/v1/devices/lps-ebt-01/latest`.

Insert a FAT32 microSD card before powering on the tracker. The firmware saves each fix in `/ebt-queue` and deletes the file after the server acknowledges its sequence. The tracker scans that directory again after a reboot and retries queued fixes with their original sequences. Without a usable card the tracker can retry one sample in RAM.

The local header and firmware build outputs are ignored; both can contain credentials. Keep them private and save any microSD queue copies or serial GPS exports under an ignored directory such as `recordings/`.
