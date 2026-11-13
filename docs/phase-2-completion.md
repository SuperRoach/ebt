# Phase 2 completion

Verified 13 November 2026 (Australia/Melbourne).

## Implementation

The Lucas Primary School dashboard lives in `client/` and uses React, TypeScript, Vite and Leaflet. The map opens at Princes Park near Lake Victoria, centred at `-37.0442, 143.7422`. The [official event map](https://www.eb.org.au/guide/maps/) identifies Lake Victoria as the event site. Cart cards show speed in km/h, recording status, GPS fix, satellite count, battery voltage, transport and the capture time in Victoria. Numbered markers, cart names and colour-coded trails distinguish the carts. Each cart can be hidden. Follow pans to the selected cart while it has a current fix, and Fit all carts frames visible current positions or returns to the circuit when there are none.

- `api.ts` calls Phase 1 device listing, latest and history routes. `telemetrySocket.ts` manages `/api/v1/ws` and reconnects with exponential backoff capped at 15 seconds. `useTracking.ts` starts the REST load and WebSocket together, refreshes the roster and samples on connection and reconnection, and retries REST while disconnected or after an API failure.
- REST and WebSocket samples merge by sequence and use the server's capture-time and sequence ordering. An older replay cannot replace a newer sample. The most recent 200 samples within five minutes feed each trail. Trails break across lost fixes, gaps of 30 seconds or more, recording sessions and simulator-to-hardware changes.
- **Live** means a valid fix less than 30 seconds old with an open feed and a successful latest-position refresh for that cart on the current connection. **Delayed** covers samples 30–89 seconds old, unconfirmed fixes after a disconnect, and timestamps too far in the future. **Offline** means no sample or a sample at least 90 seconds old. **No GPS Fix** means the latest recent sample explicitly lacks a usable fix. Freshness uses GPS capture time, with a five-second clock tolerance. Current markers and speed are visible only while Live. Dashed lines show past positions separately from the current markers.
- A `sim-` firmware version identifies simulator telemetry using Phase 1's existing convention. A banner, cart badges and map labels identify demo positions. Demo trails follow the same freshness rules.
- `PATCH /api/v1/devices/:id` validates and trims the display name, updates the existing SQLite device row and returns `{ device }`. It requires a separate `EBT_ADMIN_TOKEN` and is disabled when that variable is absent. The dashboard keeps the entered token in memory while the admin dialog is open. The Phase 1 telemetry schema, ingest, acknowledgements and broadcast payload are unchanged.

## Running locally

Follow the [local setup](../README.md#run-locally) to copy the templates and generate the two device keys in `server/.env`. Set a separate random `EBT_ADMIN_TOKEN` there if device editing is needed. Run these commands from the workspace root with Node.js 24 LTS.

```sh
npm ci
npm run db:migrate
npm run db:seed
npm start
```

Run the client and simulator in separate terminals. Open [the local dashboard](http://localhost:5173).

```sh
npm run dev:client
SIM_CENTER_LAT=-37.0442 SIM_CENTER_LON=143.7422 SIM_RADIUS_M=170 npm run simulate
```

The development and preview proxies send `/api/v1` and WebSocket upgrades to `EBT_PROXY_TARGET`, which defaults to `http://127.0.0.1:3000`. Set it in the environment or in `client/.env` for a different local target. `VITE_API_BASE_URL` and `VITE_WS_URL` override browser connection URLs at build time. For a production build, serve `client/dist/` and proxy `/api/v1` and WebSocket upgrades under the same origin. A separate browser-facing API origin requires CORS configuration at the gateway.

## Map attribution

- Street uses standard OpenStreetMap raster tiles with visible contributor attribution. [OpenStreetMap tile policy](https://operations.osmfoundation.org/policies/tiles/)
- Satellite uses EOX's Sentinel-2 cloudless 2016 Web Mercator layer, listed as `s2cloudless_3857`, under CC BY 4.0. The map displays attribution and links to the licence. Imagery is overzoomed above level 14 and shows an archival satellite view. [EOX WMTS capabilities](https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml) · [EOX licensing](https://cloudless.eox.at/documentation/license)

## Verification

| Command or check | Result |
| --- | --- |
| `npm run typecheck` | Passed for the server, shared types and client. |
| `npm test` | 11 passed, including Phase 1 SQLite and WebSocket integration, rename authorization and persistence, and client freshness, replay and trail tests. |
| `npm run build` | Passed. Vite emitted the production dashboard to `client/dist/`. |
| Phase 1 simulator against isolated SQLite | Both devices acknowledged samples, moved their respective markers over the WebSocket and drew separate trails. Both were labelled Demo. |
| Chrome against the production build with Vite preview | Verified initial empty telemetry, REST loads for both devices, per-cart visibility, follow and fit, and successful tile rendering with attribution in both layers. |
| Admin and reconnect in Chrome | Rejected an invalid token. Updated the marker label after saving a valid rename. The rename survived browser reload and server restart. Stopping Fastify removed both current markers. Restarting it triggered WebSocket reconnect and restored both positions via REST. |
| Freshness and layout in Chrome | Posted a no-fix sample through the existing ingest route and verified its marker disappeared. Advanced the browser clock through Delayed and Offline and verified stale markers stayed off the map. Checked 1440 px desktop, 768 px tablet, and 390 px and 320 px mobile layouts. |

The browser run used a fresh migrated and seeded SQLite database, Fastify and Vite preview on loopback ports, the existing simulator at one-second intervals, and headless Chrome driven by Playwright. The workspace database was left untouched.

## Outstanding

- `docs/phase-1-completion.md` was absent from this checkout. Phase 1 behaviour was verified against the README, server source, shared schema and tests.
- Verification used simulator telemetry and desktop Chrome's mobile viewport emulation. Live hardware and physical mobile devices were outside this phase.
- Public map tiles require internet access. Production hosting and access control for the Phase 1 read routes remain deployment work.
