import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GpsSample, TelemetryAck, TelemetryBatch } from "@ebt/shared";
import WebSocket from "ws";
import { buildApp } from "../src/app.js";
import { createDatabase } from "../src/db.js";
import { seedDevices } from "../src/devices.js";

const keys = {
  "lps-ebt-01": "test-first-device-key",
  "lps-ebt-02": "test-second-device-key",
};
const bootId = randomBytes(16).toString("hex");
const sessionId = randomBytes(16).toString("hex");
function sample(counter: number, timestamp = "2026-11-13T06:00:00.000Z"): GpsSample {
  return {
    sequence: `${bootId}:${String(counter).padStart(10, "0")}`,
    timestamp,
    latitude: -37.8136,
    longitude: 144.9631,
    speedMps: 3.5,
    headingDeg: 90,
    fixValid: true,
    satelliteCount: 11,
    hdop: 0.9,
  };
}

test("firmware upload CORS allows the configured dashboard origin", async (t) => {
  const dashboardOrigin = "https://dashboard.example";
  const previous = process.env.EBT_DASHBOARD_ORIGIN;
  process.env.EBT_DASHBOARD_ORIGIN = dashboardOrigin;
  t.after(() => {
    if (previous === undefined) delete process.env.EBT_DASHBOARD_ORIGIN;
    else process.env.EBT_DASHBOARD_ORIGIN = previous;
  });
  const db = createDatabase("file::memory:");
  const app = await buildApp(db, false, "test-admin");
  t.after(async () => {
    await app.close();
    await db.$disconnect();
  });
  const url = "/api/v1/admin/devices/lps-ebt-01/firmware";
  const options = await app.inject({
    method: "OPTIONS", url, headers: {
      origin: dashboardOrigin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type,x-firmware-version",
    },
  });
  assert.equal(options.statusCode, 204);
  assert.equal(options.headers["access-control-allow-origin"], dashboardOrigin);
  assert.match(String(options.headers["access-control-allow-methods"]), /\bPOST\b/);
  assert.match(String(options.headers["access-control-allow-headers"]), /\bX-Firmware-Version\b/i);

  const denied = await app.inject({ method: "OPTIONS", url, headers: { origin: "https://other.example" } });
  assert.equal(denied.headers["access-control-allow-origin"], undefined);

  const upload = await app.inject({
    method: "POST", url, payload: Buffer.alloc(1024),
    headers: { origin: dashboardOrigin, "content-type": "application/octet-stream", "x-firmware-version": "test-1" },
  });
  assert.equal(upload.statusCode, 401);
  assert.equal(upload.headers["access-control-allow-origin"], dashboardOrigin);
});

test("SQLite telemetry API", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ebt-test-"));
  const url = `file:${join(dir, "test.db")}`;
  const db = createDatabase(url);
  const adminToken = "verification-admin-token";
  const app = await buildApp(db, false, adminToken);
  t.after(async () => {
    await app.close();
    await db.$disconnect();
    await rm(dir, { recursive: true, force: true });
  });
  execFileSync(process.execPath, ["--import", "tsx", "server/src/migrate.ts"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });
  await seedDevices(db, keys);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });

  const batch: TelemetryBatch = {
    version: 1,
    deviceId: "lps-ebt-01",
    firmwareVersion: "test-1.0.0",
    recordingSessionId: sessionId,
    recordingState: "recording",
    transport: "wifi",
    batteryVoltage: 4.05,
    samples: [sample(1), sample(2, "2026-11-13T06:00:10.000Z")],
  };
  const post = (payload: unknown, key: string | null = keys["lps-ebt-01"]) => app.inject({
    method: "POST",
    url: "/api/v1/telemetry",
    headers: key ? { authorization: `Bearer ${key}` } : {},
    payload: payload as object,
  });

  await t.test("health, seeded devices, and rename surviving reseeding", async () => {
    assert.equal((await app.inject("/health")).statusCode, 200);
    await db.device.update({ where: { id: "lps-ebt-02" }, data: { displayName: "Second tracker" } });
    await seedDevices(db, keys);
    assert.deepEqual((await app.inject("/api/v1/devices")).json(), {
      devices: [{ id: "lps-ebt-01", displayName: "Tracker 1", colour: null }, { id: "lps-ebt-02", displayName: "Second tracker", colour: null }],
    });
    assert.equal((await app.inject("/api/v1/devices/lps-ebt-01/latest")).json().sample, null);
    assert.equal((await app.inject("/api/v1/devices/missing/latest")).statusCode, 404);
  });

  await t.test("rejects malformed payloads and keys for the wrong device", async () => {
    assert.equal((await post(batch, null)).statusCode, 401);
    assert.equal((await post(batch, keys["lps-ebt-02"])).statusCode, 401);
    assert.equal((await post({ ...batch, deviceId: "unknown" })).statusCode, 401);
    for (const malformed of [
      { ...batch, version: 2 },
      { ...batch, extra: true },
      { ...batch, batteryVoltage: "4.05" },
      { ...batch, samples: [] },
      { ...batch, samples: [sample(1), sample(1)] },
      { ...batch, samples: [{ ...sample(1), latitude: 91 }] },
      { ...batch, samples: [{ ...sample(1), latitude: null }] },
      { ...batch, samples: [sample(1, "2026-02-30T06:00:00Z")] },
      { ...batch, samples: [sample(1, "2026-11-13T17:00:00+11:00")] },
    ]) {
      assert.equal((await post(malformed)).statusCode, 400, JSON.stringify(malformed));
    }
    assert.equal(await db.gpsSample.count(), 0);
  });

  await t.test("authenticates dashboard writes and broadcasts the saved message and clear", async (t) => {
    const previous = process.env.EBT_DASHBOARD_MESSAGE;
    process.env.EBT_DASHBOARD_MESSAGE = "Configured fallback";
    t.after(() => {
      if (previous === undefined) delete process.env.EBT_DASHBOARD_MESSAGE;
      else process.env.EBT_DASHBOARD_MESSAGE = previous;
    });
    assert.equal((await app.inject("/api/v1/devices")).json().message, "Configured fallback");
    const write = (message: string, token?: string) => app.inject({
      method: "PUT",
      url: "/api/v1/dashboard-message",
      payload: { message },
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    assert.equal((await write("Unauthorised")).statusCode, 401);
    assert.equal((await write("x".repeat(501), adminToken)).statusCode, 400);

    const socket = new WebSocket(address.replace("http:", "ws:") + "/api/v1/ws");
    t.after(() => socket.terminate());
    await once(socket, "open");
    for (const [input, message, revision] of [["  Racing at noon  ", "Racing at noon", 1], ["  ", "", 2]] as const) {
      const event = once(socket, "message", { signal: AbortSignal.timeout(2000) });
      const response = await write(input, adminToken);
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { message, revision });
      const [data] = await event;
      assert.deepEqual(JSON.parse(data.toString()), { type: "dashboard-message", message, revision });
      const roster = (await app.inject("/api/v1/devices")).json();
      assert.equal(roster.message, message);
      assert.equal(roster.messageRevision, revision);
    }
    assert.equal((await db.dashboardMessage.findUnique({ where: { id: 1 } }))?.message, "");
  });

  await t.test("requires admin authorization and persists device settings", async () => {
    const update = (id: string, payload: { displayName?: string; colour?: string | null }, token = adminToken) => app.inject({
      method: "PATCH",
      url: `/api/v1/devices/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    assert.equal((await update("lps-ebt-01", { colour: "#123abc" }, keys["lps-ebt-01"])).statusCode, 401);
    assert.equal((await update("lps-ebt-01", { displayName: " " })).statusCode, 400);
    assert.equal((await update("lps-ebt-01", { displayName: "a".repeat(101) })).statusCode, 400);
    assert.equal((await update("lps-ebt-01", { colour: "red" })).statusCode, 400);
    assert.equal((await update("lps-ebt-01", {})).statusCode, 400);
    assert.equal((await update("missing", { displayName: "Cart A" })).statusCode, 404);
    const device = { id: "lps-ebt-01", displayName: "Cart A", colour: "#123abc" };
    assert.deepEqual((await update(device.id, { colour: "#123ABC" })).json().device.colour, device.colour);
    assert.deepEqual((await update(device.id, { displayName: "  Cart A  " })).json(), { device });
    assert.deepEqual((await app.inject(`/api/v1/devices/${device.id}/latest`)).json(), { device, sample: null });
    await seedDevices(db, keys);
    assert.deepEqual((await app.inject("/api/v1/devices")).json().devices[0], device);
    assert.deepEqual((await update(device.id, { colour: null })).json(), { device: { ...device, colour: null } });
  });

  await t.test("broadcasts committed new samples, acknowledges replay, and supports both trackers", async () => {
    const socket = new WebSocket(address.replace("http:", "ws:") + "/api/v1/ws");
    try {
      await once(socket, "open", { signal: AbortSignal.timeout(3000) });
      const messages: unknown[] = [];
      socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
      const next = () => once(socket, "message", { signal: AbortSignal.timeout(3000) });
      const firstEvent = next();
      const first = await post(batch);
      assert.equal(first.statusCode, 200, first.body);
      assert.deepEqual(first.json<TelemetryAck>().accepted, batch.samples.map(({ sequence }) => ({ sequence, status: "stored" })));
      await firstEvent;
      assert.equal(await db.gpsSample.count(), 2);

      const replay = await post({ ...batch, transport: "4g" });
      assert.equal(replay.statusCode, 200, replay.body);
      assert.deepEqual(replay.json<TelemetryAck>().accepted.map(({ status }) => status), ["duplicate", "duplicate"]);

      const secondEvent = next();
      const second = await post({ ...batch, deviceId: "lps-ebt-02" }, keys["lps-ebt-02"]);
      assert.equal(second.statusCode, 200, second.body);
      await secondEvent;
      assert.deepEqual(messages.map((message) => {
        const event = message as TelemetryBatch & { type: string; receivedAt: string };
        assert.equal(event.type, "telemetry");
        assert.ok(Date.parse(event.receivedAt));
        assert.deepEqual(event.samples, batch.samples);
        return event.deviceId;
      }), ["lps-ebt-01", "lps-ebt-02"]);
      assert.equal(await db.gpsSample.count(), 4);

      for (const id of ["lps-ebt-01", "lps-ebt-02"]) {
        const latest = await app.inject(`/api/v1/devices/${id}/latest`);
        assert.equal(latest.statusCode, 200, latest.body);
        assert.equal(latest.json().sample.sequence, sample(2).sequence);
      }
    } finally {
      socket.terminate();
    }
  });

  await t.test("handles mixed retries and concurrent overlapping submissions", async () => {
    const newer = sample(3, "2026-11-13T06:00:20.000Z");
    const mixed = { ...batch, samples: [sample(1), newer] };
    const results = await Promise.all([post(mixed), post(mixed)]);
    for (const result of results) assert.equal(result.statusCode, 200, result.body);
    const statuses = results.map((result) => result.json<TelemetryAck>().accepted.map(({ status }) => status));
    assert.deepEqual(statuses.sort(), [["duplicate", "duplicate"], ["duplicate", "stored"]]);
    assert.equal(await db.gpsSample.count(), 5);

    const history = await app.inject("/api/v1/devices/lps-ebt-01/history?limit=1&from=2026-11-13T06:00:10Z");
    assert.equal(history.statusCode, 200, history.body);
    assert.equal(history.json().samples[0].sequence, newer.sequence);
    assert.equal(history.json().nextOffset, 1);
    const page = await app.inject("/api/v1/devices/lps-ebt-01/history?limit=1&offset=1&from=2026-11-13T06:00:10Z");
    assert.equal(page.json().samples[0].sequence, sample(2).sequence);
    assert.equal(page.json().nextOffset, null);
  });

  await t.test("rolls back a batch that reuses a sequence for different capture data", async () => {
    const response = await post({ ...batch, samples: [sample(4), { ...sample(1), latitude: 0 }] });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().accepted, undefined);
    assert.equal(await db.gpsSample.count(), 5);
  });

  await t.test("returns no acknowledgement or event when SQLite rejects a write", async () => {
    await db.$executeRawUnsafe(`CREATE TRIGGER fail_write BEFORE INSERT ON "GpsSample"
      WHEN NEW."satelliteCount" = 99 BEGIN SELECT RAISE(ABORT, 'test write failure'); END`);
    const socket = new WebSocket(address.replace("http:", "ws:") + "/api/v1/ws");
    try {
      await once(socket, "open", { signal: AbortSignal.timeout(3000) });
      const events: TelemetryBatch[] = [];
      socket.on("message", (data) => events.push(JSON.parse(data.toString())));
      const response = await post({ ...batch, samples: [sample(4), { ...sample(5), satelliteCount: 99 }] });
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(response.json().accepted, undefined);
      assert.equal(await db.gpsSample.count(), 5);

      const next = once(socket, "message", { signal: AbortSignal.timeout(3000) });
      const retry = await post({ ...batch, samples: [sample(4)] });
      assert.equal(retry.statusCode, 200, retry.body);
      await next;
      assert.deepEqual(events.map(({ samples }) => samples), [[sample(4)]]);
    } finally {
      socket.terminate();
    }
  });
});
