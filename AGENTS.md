# Working on EBT GPS tracking

This repository tracks Lucas Primary School's Energy Breakthrough carts. `client/`, `server/` and `shared/` are npm workspaces with one root lockfile. `firmware/` builds separately with Arduino CLI. See the [README](README.md) for setup and operating instructions.

## Component guide

| Component | Start here | Responsibility |
| --- | --- | --- |
| [`client/`](client/) | [`main.tsx`](client/src/main.tsx), [`App.tsx`](client/src/App.tsx), [`useTracking.ts`](client/src/useTracking.ts) | React and Leaflet dashboard. `api.ts` wraps REST, `telemetrySocket.ts` owns the WebSocket connection, and `tracking.ts` owns sample merging, freshness and trail segmentation. `CartMap.tsx`, `Admin.tsx` and `DashboardMessage.tsx` own map rendering, device settings and notices. Behavioral tests live in `client/test/tracking.test.ts`. |
| [`server/`](server/) | [`main.ts`](server/src/main.ts), [`app.ts`](server/src/app.ts), [`ingest.ts`](server/src/ingest.ts) | Fastify entry point and routes, device authentication, transactional ingest, REST reads, WebSocket broadcasts, dashboard messages and targeted firmware assignments. Prisma storage lives under `server/prisma/`. `devices.ts` owns seeded IDs and key hashing, `telemetry-listener.ts` exposes upload-only LAN access, and `simulator.ts` exercises the real ingest route. Integration tests live in `server/test/api.test.ts`. |
| [`shared/`](shared/) | [`telemetry-v1.schema.json`](shared/telemetry-v1.schema.json), [`index.ts`](shared/index.ts) | Runtime JSON Schema for v1 telemetry requests and TypeScript definitions for requests, acknowledgements and firmware offers. The server validates against the schema. Firmware implements the wire contract in C++. |
| [`firmware/`](firmware/) | [`firmware/README.md`](firmware/README.md), [`telemetry.cpp`](firmware/WifiTelemetry/telemetry.cpp), [`diagnostic.cpp`](firmware/GpsDiagnostic/diagnostic.cpp) | Arduino firmware for the Waveshare ESP32-S3 SIM7670G V2.0. `GpsDiagnostic` verifies GNSS over the modem. `WifiTelemetry` handles GNSS capture, LTE-first HTTPS, Wi-Fi fallback, status pings and microSD retry. Each tracker uses its own `secrets.h` profile. The API can offer firmware releases, and USB is the current installation path. |

## Follow a change across components

- **Telemetry fields**. Keep the schema and TypeScript types aligned. Trace changes through the C++ encoder, simulator, API validation, ingest and storage, REST responses, WebSocket events and client conversion. Preserve compatibility with deployed firmware and records already queued on microSD. A retried `(deviceId, sequence)` must identify the same capture. A conflicting capture rolls back the batch. Broadcast only newly committed samples.
- **Dashboard behaviour**. Trace history and WebSocket events into `useTracking.ts`, then `tracking.ts` and the rendering component. Keep old replays from displacing a newer fix. Use capture time for freshness and the connected feed for live status. Preserve the last known position separately from the live state. Dashboard notice revisions keep older REST responses from overwriting newer updates.
- **Storage and deployment**. Review the Prisma schema and SQL migrations together. [`server/Dockerfile`](server/Dockerfile) runs migrations on startup. [`fly.toml`](fly.toml) mounts SQLite and firmware artifacts under `/data`. [`netlify.toml`](netlify.toml) builds the dashboard with public `VITE_*` variables. Check both same-origin development and the configured cross-origin browser paths when changing routes or headers.
- **Device identity and credentials**. Match `lps-ebt-01` to `EBT_01_API_KEY` and `lps-ebt-02` to `EBT_02_API_KEY`. Keep the admin token separate. Use synthetic data and a disposable SQLite database when running manual ingest tests. Keep local headers, environment files, firmware binaries and GPS recordings private.

## Verify changes

From the root, use `npm ci`, `npm run typecheck`, `npm test` and `npm run build`. The test suite migrates a temporary SQLite database and requires loopback networking. Use the README's simulator flow for a dashboard smoke test. For firmware work, use the board settings and Arduino CLI commands in the firmware guide, then check serial acknowledgements and the matching device on the dashboard when a board is available.
