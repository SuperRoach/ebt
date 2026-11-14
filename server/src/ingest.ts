import type { TelemetryAck, TelemetryBatch } from "@ebt/shared";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { hashKey } from "./devices.js";

export class SequenceConflict extends Error {
  constructor(readonly sequence: string) {
    super("Sequence already belongs to a different sample");
  }
}

export async function ingest(db: PrismaClient, batch: TelemetryBatch) {
  const { deviceId, version, firmwareVersion, recordingSessionId, recordingState, transport, batteryVoltage, cellularSignal } = batch;
  const receivedAt = new Date().toISOString();
  const captures = batch.samples.map((sample) => {
    const { sequence, latitude, longitude, speedMps, headingDeg, fixValid, satelliteCount } = sample;
    const timestamp = new Date(sample.timestamp).toISOString();
    const hdop = sample.hdop ?? null;
    // Transport can change when an offline batch is retried over another link.
    const captureHash = hashKey(JSON.stringify([
      version, firmwareVersion, recordingSessionId, recordingState, batteryVoltage,
      timestamp, latitude, longitude, speedMps, headingDeg, fixValid, satelliteCount, hdop,
    ]));
    return {
      sequence,
      captureHash,
      row: Prisma.sql`(
        ${deviceId}, ${sequence}, ${captureHash}, ${timestamp}, ${receivedAt}, ${version},
        ${firmwareVersion}, ${recordingSessionId}, ${recordingState}, ${transport}, ${batteryVoltage},
        ${cellularSignal?.rssiDbm ?? null}, ${cellularSignal?.rsrpDbm ?? null},
        ${cellularSignal?.rsrqDb ?? null}, ${cellularSignal?.sinrDb ?? null},
        ${latitude}, ${longitude}, ${speedMps}, ${headingDeg}, ${fixValid}, ${satelliteCount}, ${hdop}
      )`,
    };
  });

  return db.$transaction(async (tx) => {
    // Acquire the SQLite write lock before reading existing rows. Target the
    // primary key so other constraints still abort the batch.
    const inserted = await tx.$queryRaw<{ sequence: string }[]>`
      INSERT INTO "GpsSample" (
        "deviceId", "sequence", "captureHash", "timestamp", "receivedAt", "protocolVersion",
        "firmwareVersion", "recordingSessionId", "recordingState", "transport", "batteryVoltage",
        "cellularRssiDbm", "cellularRsrpDbm", "cellularRsrqDb", "cellularSinrDb",
        "latitude", "longitude", "speedMps", "headingDeg", "fixValid", "satelliteCount", "hdop"
      ) VALUES ${Prisma.join(captures.map(({ row }) => row))}
      ON CONFLICT ("deviceId", "sequence") DO NOTHING
      RETURNING "sequence"
    `;
    const newSequences = new Set(inserted.map(({ sequence }) => sequence));
    const duplicates = captures.filter(({ sequence }) => !newSequences.has(sequence));
    if (duplicates.length) {
      const existing = await tx.gpsSample.findMany({
        where: { deviceId, sequence: { in: duplicates.map(({ sequence }) => sequence) } },
        select: { sequence: true, captureHash: true },
      });
      const hashes = new Map(existing.map(({ sequence, captureHash }) => [sequence, captureHash]));
      for (const { sequence, captureHash } of duplicates) {
        if (hashes.get(sequence) !== captureHash) throw new SequenceConflict(sequence);
      }
    }

    const ack: TelemetryAck = {
      version,
      deviceId,
      accepted: captures.map(({ sequence }) => ({
        sequence,
        status: newSequences.has(sequence) ? "stored" : "duplicate",
      })),
    };
    return { ack, newSamples: batch.samples.filter(({ sequence }) => newSequences.has(sequence)), receivedAt };
  });
}
