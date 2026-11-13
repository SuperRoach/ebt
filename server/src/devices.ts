import { createHash } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";

export const deviceIds = ["lps-ebt-01", "lps-ebt-02"] as const;
export type DeviceId = typeof deviceIds[number];

export function hashKey(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function deviceKeys(): Record<DeviceId, string> {
  const first = process.env.EBT_01_API_KEY;
  const second = process.env.EBT_02_API_KEY;
  if (!first || !second || first === second || [first, second].some((key) => !/^[A-Za-z0-9_-]{16,128}$/.test(key))) {
    throw new Error("Set two distinct 16–128 character API keys using letters, digits, underscores or hyphens.");
  }
  return { "lps-ebt-01": first, "lps-ebt-02": second };
}

export async function seedDevices(db: PrismaClient, keys: Record<DeviceId, string>) {
  await db.$transaction(deviceIds.map((id, index) =>
    db.device.upsert({
      where: { id },
      update: { apiKeyHash: hashKey(keys[id]) },
      create: { id, displayName: `Tracker ${index + 1}`, apiKeyHash: hashKey(keys[id]) },
    }),
  ));
}
