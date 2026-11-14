import type { StoredSample, TelemetryEvent } from "./api.js";

export const LIVE_MS = 30_000;
export const OFFLINE_MS = 90_000;
export const TRAIL_MS = 5 * 60_000;
const FUTURE_TOLERANCE_MS = 5_000;
const SAMPLE_LIMIT = 200;
const HISTORY_POINTS = 10;

function captureTime(sample: StoredSample) {
  const captured = Date.parse(sample.timestamp);
  return captured <= Date.parse(sample.receivedAt) + FUTURE_TOLERANCE_MS ? captured : NaN;
}

export function fromEvent(event: TelemetryEvent): StoredSample[] {
  const { samples, version, type: _type, ...metadata } = event;
  return samples.map((sample) => ({
    ...sample, ...metadata, protocolVersion: version, hdop: sample.hdop ?? null,
    cellularRssiDbm: metadata.cellularSignal?.rssiDbm ?? null,
    cellularRsrpDbm: metadata.cellularSignal?.rsrpDbm ?? null,
    cellularRsrqDb: metadata.cellularSignal?.rsrqDb ?? null,
    cellularSinrDb: metadata.cellularSignal?.sinrDb ?? null,
  }));
}

export function mergeSamples(existing: StoredSample[], incoming: StoredSample[], now: number) {
  const bySequence = new Map(existing.map((sample) => [sample.sequence, sample]));
  for (const sample of incoming) bySequence.set(sample.sequence, sample);
  const sorted = [...bySequence.values()]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.sequence.localeCompare(a.sequence));
  const retained = sorted
    .filter((sample, index) => index < HISTORY_POINTS || Date.parse(sample.timestamp) >= now - TRAIL_MS)
    .slice(0, SAMPLE_LIMIT);
  const lastFix = lastPositionSample(sorted, now);
  if (lastFix && !retained.includes(lastFix)) {
    if (retained.length === SAMPLE_LIMIT) retained.pop();
    retained.push(lastFix);
  }
  return retained;
}

export function lastPositionSample(samples: StoredSample[], now: number) {
  return samples.find((sample) => captureTime(sample) <= now + FUTURE_TOLERANCE_MS && position(sample));
}

export type CartStatus = "Live" | "Delayed" | "Offline" | "No GPS Fix";

export function cartStatus(sample: StoredSample | undefined, now: number, connected: boolean): CartStatus {
  if (!sample) return "Offline";
  const age = now - captureTime(sample);
  if (age >= OFFLINE_MS) return "Offline";
  if (!Number.isFinite(age) || age < -FUTURE_TOLERANCE_MS || age >= LIVE_MS) return "Delayed";
  if (!sample.fixValid || sample.latitude === null || sample.longitude === null) return "No GPS Fix";
  return connected ? "Live" : "Delayed";
}

export const isDemo = (sample: StoredSample) => sample.firmwareVersion.startsWith("sim-");
type Position = [number, number];

export function position(sample: StoredSample): Position | null {
  if (!sample.fixValid || sample.latitude === null || sample.longitude === null) return null;
  return [sample.latitude, sample.longitude];
}

export function trailSegments(samples: StoredSample[], now: number): Position[][] {
  const latest = samples[0];
  if (!latest) return [];
  const segments: Position[][] = [];
  let segment: Position[] = [];
  let previous: StoredSample | undefined;
  for (const sample of [...samples].reverse()) {
    const captured = captureTime(sample);
    const point = position(sample);
    const usable = point && captured >= now - TRAIL_MS && captured <= now + FUTURE_TOLERANCE_MS
      && isDemo(sample) === isDemo(latest);
    const gap = previous && (captured - Date.parse(previous.timestamp) >= LIVE_MS
      || previous.recordingSessionId !== sample.recordingSessionId);
    if (!usable || gap) {
      if (segment.length > 1) segments.push(segment);
      segment = [];
    }
    if (usable) segment.push(point);
    previous = usable ? sample : undefined;
  }
  if (segment.length > 1) segments.push(segment);
  return segments;
}
