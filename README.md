# EBT GPS tracking

Energy Breakthrough GPS tracking for Lucas Primary School. Two ESP32 trackers send GPS and connection data to a Fastify API, which stores samples in SQLite and streams new ones to a React and Leaflet dashboard. A simulator exercises the same API without hardware.

## Repository layout

This is one Git repository. Install and run the npm commands from the root.

| Component | Purpose |
| --- | --- |
| [`client/`](client/) | React and Leaflet dashboard for cart positions, trails, connection status and device administration. |
| [`server/`](server/) | Fastify API, WebSocket feed, Prisma migrations, device provisioning and telemetry simulator. |
| [`shared/`](shared/) | Telemetry v1 JSON Schema and TypeScript types used by the server, simulator and dashboard. |
| [`firmware/`](firmware/) | Arduino sketches for the Waveshare ESP32-S3 SIM7670G V2.0, including a GPS diagnostic and the tracker firmware. |

See the [agent guide](AGENTS.md) for entry points, ownership and cross-component checks.

## Run locally

Install Node.js 24 LTS and run these commands from the workspace root.

```sh
cp -n .env.example .env
cp -n server/.env.example server/.env
openssl rand -hex 32
openssl rand -hex 32
```

Uncomment `EBT_01_API_KEY` and `EBT_02_API_KEY` in `server/.env` and replace the empty values with the two generated keys. Then install dependencies and start the server:

```sh
npm ci
npm run db:migrate
npm run db:seed
npm start
```

The server listens on `http://127.0.0.1:3000` by default. SQLite creates `ebt.db` at the workspace root. `DATABASE_URL` can point to another local file, and relative paths are resolved from the directory where you run the commands. No database service or Docker is required.

For server and simulator commands, exported variables override both files, and `server/.env` overrides the root `.env`. Existing root-only configuration still works; move any server credentials to `server/.env` when convenient.

Run `npm run dev:client` in a second terminal and open [the local dashboard](http://localhost:5173). Vite proxies REST and WebSocket traffic to `http://127.0.0.1:3000`. For a different local API port, copy `client/.env.example` to `client/.env` and set `EBT_PROXY_TARGET` there. To enable admin actions, generate a separate token with `openssl rand -hex 32`, set `EBT_ADMIN_TOKEN` in `server/.env`, and restart the server.

In another terminal, start the simulator. It immediately sends a position for each tracker, then repeats every 10 seconds. The trackers start on opposite sides of a circular track and move at different speeds. Set `SIM_CENTER_LAT`, `SIM_CENTER_LON`, `SIM_RADIUS_M`, `SIM_INTERVAL_MS`, and `SIM_BASE_URL` in `.env` to configure it.

```sh
SIM_CENTER_LAT=-37.0442 SIM_CENTER_LON=143.7422 SIM_RADIUS_M=170 npm run simulate
# Or send one round and exit.
npm run simulate -- --once
```

```sh
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/api/v1/devices
curl -fsS http://127.0.0.1:3000/api/v1/devices/lps-ebt-01/latest
curl -fsS 'http://127.0.0.1:3000/api/v1/devices/lps-ebt-02/history?limit=10'
npm run device:rename -- lps-ebt-01 "Lucas Tracker A"
npm run typecheck
npm test
npm run build
```

The tests migrate a temporary database and use an ephemeral local port. `npm run build` writes the dashboard to `client/dist/`. Re-running the seed updates device key hashes and preserves device settings and recorded samples. Use `npm run dev` in place of `npm start` to watch server files during development.

## Use the dashboard

- Use **Follow** to track a live cart, **Fit all carts** to frame visible positions, and the cart controls to show or hide individual carts. The map keeps the last known fix when a cart goes offline or loses GPS. **Live** requires a recent valid fix received through the connected feed. Simulator positions are labelled **Demo**.
- Street tiles use OpenStreetMap. Satellite imagery uses Esri World Imagery and requires a browser-facing `VITE_ARCGIS_API_KEY` at dev-server startup or build time. Both layers fetch tiles over the internet.
- Open **Device admin** and enter the admin token to save a cart's display name or colour. The hardware IDs stay `lps-ebt-01` and `lps-ebt-02`.
- Select **Cart tracking** and use the same admin token as Device admin to publish a notice. Clear the editor and save to remove it. The API stores the message in SQLite and broadcasts changes to connected dashboards. `EBT_DASHBOARD_MESSAGE` supplies a fallback until an admin first saves or clears the notice.

## Provision and test a physical tracker

1. Use [the firmware guide](firmware/README.md) to run the GNSS diagnostic, prepare the SIM and FAT32 microSD card, and compile the telemetry sketch for the target board.
2. Select the matching `tracker-01` or `tracker-02` profile and use the key seeded on the API the board will call. For a local Wi-Fi bench test, set `TELEMETRY_HOST` to the computer's LAN IPv4 address in `server/.env`, restart the API, and set the board's `EBT_API_URL` to `http://<LAN-IP>:3001/api/v1/telemetry`. The dashboard can still use the loopback API on port 3000.
3. Flash over USB and watch the 115200 baud serial monitor for the correct device ID and `LTE acknowledged` or `Wi-Fi acknowledged`. Confirm the matching cart updates in the dashboard. Keep the simulator stopped when using the same API and device IDs as physical boards.

The API can store a firmware `.bin` and offer it to one authenticated tracker. The current sketch requires USB flashing and does not install OTA offers. The separate-origin Netlify dashboard also cannot upload binaries directly to Fly with the current CORS configuration. The upload route works through the local Vite proxy or a same-origin deployment. Binaries can embed device credentials. When testing uploads locally, set `FIRMWARE_STORAGE_DIR` to a private directory outside the checkout or inside the ignored `build/` directory.

## Deploy the API and dashboard

The checked-in configuration targets the [Fly API](https://ebt.fly.dev) and the [Netlify dashboard](https://lps-ebt-tracking.netlify.app).

1. Set `EBT_01_API_KEY`, `EBT_02_API_KEY` and optionally `EBT_ADMIN_TOKEN` through Fly secrets. From the root, run `fly deploy`. [fly.toml](fly.toml) configures HTTPS, the `/health` check and the `/data` volume for SQLite and firmware binaries. The [Docker image](server/Dockerfile) runs migrations at startup. On a fresh volume or after rotating device credentials, connect with `fly ssh console` and run `cd /app && npm run db:seed` to seed the deployed database using the machine's environment.
2. Build the dashboard from the repository root on Netlify. [netlify.toml](netlify.toml) runs `npm run build` and publishes `client/dist`. Set `VITE_API_BASE_URL=https://ebt.fly.dev` in Netlify's build environment. The dashboard derives its `wss://` URL from that origin. Use `VITE_WS_URL` only for a different WebSocket endpoint. If the dashboard origin changes, set `EBT_DASHBOARD_ORIGIN` to the new origin on the API and redeploy. If the API hostname changes, update the tracker profiles and set `PUBLIC_API_BASE_URL` on the API for firmware download offers.
3. Check `/health` and `/api/v1/devices` on the deployed API, then confirm the dashboard loads both devices and receives a fresh sample from the intended tracker.

The device read endpoints and WebSocket are accessible without a token. `EBT_DASHBOARD_ORIGIN` enables selected cross-origin browser requests. Deploy behind access control when GPS positions or history need to stay private.

## Credentials and recordings

Keep actual credentials in ignored local files or inject them from a secrets manager. Use distinct random keys for each tracker and a separate admin token. To rotate a device key, update it in `server/.env`, re-run `npm run db:seed`, and update and reflash that tracker using [the firmware setup](firmware/README.md). Restart the simulator if it is running. Replace any keys copied from older examples before provisioning trackers outside your local test setup. Never store secrets in `VITE_*` settings; Vite exposes them in the browser bundle.

Keep local databases, database dumps, GPS recordings, and microSD queue copies private. For example, put GPS exports in an ignored `recordings/` directory, and database dumps in `db-dumps/`. Commit only synthetic telemetry fixtures and placeholder configuration templates. If a credential is ever committed, rotate it promptly: removing the working file does not remove the secret from Git history.

## API

| Method | Path | Result |
| --- | --- | --- |
| POST | `/api/v1/telemetry` | Accepts 1–200 GPS samples with `Authorization: Bearer <device-key>`. |
| GET | `/health` | Returns `200` when the database is reachable and migrated, or `503` if unavailable. |
| GET | `/api/v1/devices` | Lists device IDs, display names and colours, plus the dashboard message and revision when present. |
| PATCH | `/api/v1/devices/:id` | Updates `displayName` and/or `colour` (`#rrggbb` or `null`) and returns `{ device }`. Requires the admin token. |
| PUT | `/api/v1/dashboard-message` | Saves `{ "message": "…" }` (up to 500 characters) and returns the message and revision. An empty string clears it. Requires the admin token. |
| GET | `/api/v1/devices/:id/latest` | Returns the newest sample by capture timestamp, including fix validity. Returns `sample: null` for a known device with no data. |
| GET | `/api/v1/devices/:id/history` | Returns newest-first samples. Optional `from` and `to` are inclusive UTC timestamps. `limit` defaults to 100 and supports 1–1000. Start at `offset=0` and use the returned `nextOffset` for the next page. Use a fixed `to` when paging a live track. |
| WS | `/api/v1/ws` | Broadcasts committed samples as `telemetry` events with server UTC `receivedAt`, and notice changes as `dashboard-message` events. Catch up with the read API after reconnecting. |
| POST | `/api/v1/admin/devices/:id/firmware` | Stores an `application/octet-stream` binary, using `X-Firmware-Version`, and assigns it to one tracker. Requires the admin token. |
| GET | `/api/v1/firmware/releases/:id` | Downloads an active firmware release with the assigned device's key. |
| POST | `/api/v1/devices/:id/firmware-status` | Reports `downloading`, `installing` or `failed` for the assigned release. Requires the device key. |

Device read routes return `404` for unknown IDs where applicable. The `latest` and `history` routes order by capture time, with sequence as the tie-breaker.

See the [Phase 2 completion notes](docs/phase-2-completion.md) for historical implementation and verification details.

## Telemetry v1

The [JSON Schema](shared/telemetry-v1.schema.json) defines the wire format. Coordinates use decimal degrees, speed uses metres per second, and heading uses degrees clockwise from true north in `[0, 360)`. Use UTC timestamps ending in `Z` with at most three fractional digits. When `fixValid` is false, use `null` for unavailable coordinates, speed or heading. Omit HDOP when unknown.

Send JSON such as the following with `Content-Type: application/json` and the key assigned to `lps-ebt-01`.

```json
{
  "version": 1,
  "deviceId": "lps-ebt-01",
  "firmwareVersion": "1.0.0",
  "recordingSessionId": "6c4a0d3f8e2b47c99112a507dd3e94b7",
  "recordingState": "recording",
  "transport": "wifi",
  "batteryVoltage": 4.08,
  "samples": [
    {
      "sequence": "77de4fd034ba4c479f83fd72b516d2a1:0000000001",
      "timestamp": "2026-11-13T06:00:00.000Z",
      "latitude": -37.8136,
      "longitude": 144.9631,
      "speedMps": 3.4,
      "headingDeg": 93.2,
      "fixValid": true,
      "satelliteCount": 11,
      "hdop": 0.9
    }
  ]
}
```

A successful response identifies each durable sample by sequence.

```json
{
  "version": 1,
  "deviceId": "lps-ebt-01",
  "accepted": [
    {"sequence": "77de4fd034ba4c479f83fd72b516d2a1:0000000001", "status": "stored"}
  ]
}
```

### Sequence numbers and microSD recovery

- Generate a fresh random 128-bit boot ID using the device hardware RNG on each boot. Encode it as 32 lowercase hex characters. Append a colon and a zero-padded 10-digit counter to make each sequence string. Increment the counter for every capture. Generate a fresh prefix before the counter overflows. SQLite deduplicates by `(deviceId, sequence)`.
- Generate a separate random 128-bit recording session ID at recording start. Persist it if recording can resume across boots. Store the full sequence and capture metadata with each microSD record. Replay recovered samples with their original sequence, recording session and capture fields. Samples with different batch metadata must be sent in separate batches. The transport field may reflect the current upload link.
- Remove local records only after their sequences appear in a successful acknowledgement as `stored` or `duplicate`. Retain records after a timeout, lost response, or `503` and retry with backoff. Replays of the same data produce `duplicate` and no broadcast. If capture data differs for a stored sequence, the server returns `409` with the offending sequence and rolls back the whole batch. A validation error returns `400` and invalid credentials return `401`.
- The simulator buffers up to 200 pending samples per tracker in memory and stops taking new samples while the buffer is full. It retries with the same sequences until acknowledged. Restarting the simulator clears this in-memory buffer and creates fresh boot and recording IDs.
