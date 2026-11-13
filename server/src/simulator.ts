import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { GpsSample, TelemetryAck, TelemetryBatch } from "@ebt/shared";
import { deviceIds, deviceKeys } from "./devices.js";

function setting(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

const centerLat = setting("SIM_CENTER_LAT", -37.8136, -90, 90);
const centerLon = setting("SIM_CENTER_LON", 144.9631, -180, 180);
const radius = setting("SIM_RADIUS_M", 100, 1, 10000);
const interval = setting("SIM_INTERVAL_MS", 10000, 100, 3600000);
const endpoint = new URL("/api/v1/telemetry", process.env.SIM_BASE_URL ?? "http://127.0.0.1:3000");
const keys = deviceKeys();
const radians = Math.PI / 180;
const earthRadius = 6_371_000;
const distance = radius / earthRadius;
const latitude = centerLat * radians;
const longitude = centerLon * radians;

function position(angle: number) {
  const lat = Math.asin(Math.sin(latitude) * Math.cos(distance)
    + Math.cos(latitude) * Math.sin(distance) * Math.cos(angle));
  const lon = longitude + Math.atan2(Math.sin(angle) * Math.sin(distance) * Math.cos(latitude),
    Math.cos(distance) - Math.sin(latitude) * Math.sin(lat));
  return { lat, lon };
}

function bearing(from: ReturnType<typeof position>, to: ReturnType<typeof position>) {
  const delta = to.lon - from.lon;
  return (Math.atan2(
    Math.sin(delta) * Math.cos(to.lat),
    Math.cos(from.lat) * Math.sin(to.lat) - Math.sin(from.lat) * Math.cos(to.lat) * Math.cos(delta),
  ) / radians + 360) % 360;
}

const start = Date.now();
const trackers = deviceIds.map((deviceId, index) => ({
  deviceId,
  bootId: randomBytes(16).toString("hex"),
  recordingSessionId: randomBytes(16).toString("hex"),
  counter: 0,
  phase: index * Math.PI,
  speed: 3.1 + index * 0.6,
  transport: index === 0 ? "wifi" as const : "4g" as const,
  batteryVoltage: 4.12 - index * 0.13,
  pending: [] as GpsSample[],
}));

async function tick(tracker: typeof trackers[number], now: number) {
  if (tracker.pending.length < 200) {
    const elapsed = (now - start) / 1000;
    const angle = tracker.phase + (tracker.speed * elapsed + 2 * Math.sin(elapsed / 8)) / radius;
    const point = position(angle);
    tracker.pending.push({
      sequence: `${tracker.bootId}:${String(++tracker.counter).padStart(10, "0")}`,
      timestamp: new Date(now).toISOString(),
      latitude: Number((point.lat / radians).toFixed(7)),
      longitude: Number((((point.lon / radians + 540) % 360) - 180).toFixed(7)),
      speedMps: Number((tracker.speed + 0.25 * Math.cos(elapsed / 8)).toFixed(2)),
      headingDeg: Math.floor(bearing(point, position(angle + 0.0001)) * 10) / 10,
      fixValid: true,
      satelliteCount: 9 + Math.floor(Math.random() * 5),
      hdop: Number((0.7 + Math.random() * 0.5).toFixed(1)),
    });
  }

  const { deviceId, recordingSessionId, transport, batteryVoltage } = tracker;
  const batch: TelemetryBatch = {
    version: 1,
    deviceId,
    firmwareVersion: "sim-1.0.0",
    recordingSessionId,
    recordingState: "recording",
    transport,
    batteryVoltage,
    samples: tracker.pending,
  };

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${keys[deviceId]}` },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(Math.min(5000, interval)),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    const ack = await response.json() as TelemetryAck;
    if (ack.version !== 1 || ack.deviceId !== deviceId || !Array.isArray(ack.accepted)) {
      throw new Error("Invalid acknowledgement");
    }
    const accepted = new Set(ack.accepted
      .filter(({ status }) => status === "stored" || status === "duplicate")
      .map(({ sequence }) => sequence));
    const before = tracker.pending.length;
    tracker.pending = tracker.pending.filter(({ sequence }) => !accepted.has(sequence));
    console.log(`${new Date(now).toISOString()} ${deviceId} acknowledged ${before - tracker.pending.length}/${before}`);
  } catch (error) {
    console.error(`${deviceId}: ${error instanceof Error ? error.message : error} (${tracker.pending.length} buffered)`);
  }
}

const once = process.argv.includes("--once");
do {
  const now = Date.now();
  await Promise.all(trackers.map((tracker) => tick(tracker, now)));
  if (!once) await delay(Math.max(0, interval - (Date.now() - now)));
} while (!once);

if (trackers.some(({ pending }) => pending.length)) process.exitCode = 1;
