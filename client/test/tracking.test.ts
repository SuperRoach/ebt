import assert from "node:assert/strict";
import { test } from "node:test";
import type { StoredSample } from "../src/api.js";
import { cartStatus, isDemo, lastPositionSample, mergeSamples, trailSegments } from "../src/tracking.js";

const now = Date.parse("2026-11-13T06:00:00.000Z");
function sample(sequence: string, age: number, overrides: Partial<StoredSample> = {}): StoredSample {
  return {
    deviceId: "lps-ebt-01",
    protocolVersion: 1,
    firmwareVersion: "sim-1.0.0",
    recordingSessionId: "session",
    recordingState: "recording",
    transport: "wifi",
    batteryVoltage: 4.12,
    receivedAt: new Date(now).toISOString(),
    timestamp: new Date(now - age).toISOString(),
    sequence,
    latitude: -37.0442,
    longitude: 143.7422,
    speedMps: 3.5,
    headingDeg: 90,
    fixValid: true,
    satelliteCount: 11,
    hdop: null,
    ...overrides,
  };
}

test("freshness uses GPS capture time and the connection, including no-fix and future samples", () => {
  assert.equal(cartStatus(sample("1", 29_999), now, true), "Live");
  assert.equal(cartStatus(sample("1", 0), now, false), "Delayed");
  assert.equal(cartStatus(sample("1", 30_000), now, true), "Delayed");
  assert.equal(cartStatus(sample("1", 90_000), now, true), "Offline");
  assert.equal(cartStatus(sample("1", -60_000), now, true), "Delayed");
  assert.equal(cartStatus(sample("1", 0, { fixValid: false }), now, true), "No GPS Fix");
  assert.equal(cartStatus(undefined, now, true), "Offline");
});

test("REST recovery and replay deduplicate by sequence without replacing newer coordinates", () => {
  const current = sample("03", 1000);
  const equalTime = sample("02", 1000);
  const old = sample("01", 10_000);
  const expired = sample("00", 301_000);
  assert.deepEqual(mergeSamples([current, equalTime], [old, equalTime, expired], now), [current, equalTime, old, expired]);
  assert.deepEqual(mergeSamples([], [expired], now), [expired]);
});

test("stored positions keep a last known fix and a short trail after the live window expires", () => {
  const lastFix = sample("02", 360_000);
  const earlierFix = sample("01", 365_000);
  const noFix = sample("03", 355_000, { fixValid: false });
  const stored = mergeSamples([], [noFix, lastFix, earlierFix], now);
  assert.equal(lastPositionSample(stored, now), lastFix);
  assert.equal(cartStatus(lastFix, now, false), "Offline");
  assert.equal(trailSegments(stored.slice(1), Date.parse(lastFix.timestamp)).length, 1);
  assert.equal(lastPositionSample([noFix], now), undefined);
});

test("trails break at lost fixes, time gaps, sessions and source changes", () => {
  const newest = sample("08", 0);
  const recent = sample("07", 5000);
  const noFix = sample("06", 10_000, { fixValid: false });
  const earlier = sample("05", 15_000);
  const start = sample("04", 20_000);
  const otherSession = sample("03", 24_000, { recordingSessionId: "previous" });
  const otherSource = sample("02", 28_000, { firmwareVersion: "1.0.0" });
  const beforeGap = sample("01", 70_000);
  assert.equal(isDemo(newest), true);
  assert.equal(isDemo(otherSource), false);
  const point = [-37.0442, 143.7422];
  assert.deepEqual(trailSegments([newest, recent, noFix, earlier, start, otherSession, otherSource, beforeGap], now),
    [[point, point], [point, point]]);
});
