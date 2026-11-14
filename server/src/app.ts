import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import websocket from "@fastify/websocket";
import { telemetrySchema, type TelemetryBatch } from "@ebt/shared";
import Fastify from "fastify";
import { WebSocket } from "ws";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { hashKey } from "./devices.js";
import { ingest, SequenceConflict } from "./ingest.js";

const deviceSelect = { id: true, displayName: true, colour: true } as const;
const sampleOrder: Prisma.GpsSampleOrderByWithRelationInput[] = [{ timestamp: "desc" }, { sequence: "desc" }];
const sampleOmit = { captureHash: true } as const;
const params = {
  type: "object",
  required: ["id"],
  properties: { id: telemetrySchema.properties.deviceId },
};

interface HistoryQuery {
  from?: string;
  to?: string;
  limit?: string;
  offset?: string;
}

export async function buildApp(db: PrismaClient, logger = false, adminToken = process.env.EBT_ADMIN_TOKEN) {
  const firmwareDirectory = resolve(process.env.FIRMWARE_STORAGE_DIR ?? "./firmware-releases");
  const app = Fastify({
    logger,
    bodyLimit: 8 * 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });
  await app.register(websocket, { options: { maxPayload: 1024 } });
  app.addSchema(telemetrySchema);

  app.get("/health", async (request, reply) => {
    try {
      await db.$queryRaw`SELECT 1 FROM "Device" UNION ALL SELECT 1 FROM "GpsSample" LIMIT 1`;
      return { status: "ok" };
    } catch (error) {
      request.log.error({ err: error }, "Database health check failed");
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  app.post<{ Body: TelemetryBatch }>("/api/v1/telemetry", {
    schema: { body: { $ref: "urn:ebt:telemetry:v1#" } },
  }, async (request, reply) => {
    const key = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{16,128})$/i)?.[1];
    if (!key) return reply.code(401).send({ error: "Invalid device credentials" });

    const batch = request.body;
    if (new Set(batch.samples.map(({ sequence }) => sequence)).size !== batch.samples.length) {
      return reply.code(400).send({ error: "Batch sequences must be unique" });
    }

    let result: Awaited<ReturnType<typeof ingest>>;
    try {
      const device = await db.device.findUnique({
        where: { id: batch.deviceId },
        select: { apiKeyHash: true },
      });
      if (!device || !timingSafeEqual(Buffer.from(device.apiKeyHash, "hex"), Buffer.from(hashKey(key), "hex"))) {
        return reply.code(401).send({ error: "Invalid device credentials" });
      }
      result = await ingest(db, batch);
    } catch (error) {
      if (error instanceof SequenceConflict) {
        return reply.code(409).send({ error: error.message, sequence: error.sequence });
      }
      request.log.error({ err: error }, "Telemetry write failed");
      return reply.code(503).send({ error: "Telemetry could not be stored. Retry the batch." });
    }

    if (result.newSamples.length) {
      const event = JSON.stringify({
        type: "telemetry",
        receivedAt: result.receivedAt,
        ...batch,
        samples: result.newSamples.map((sample) => ({
          ...sample,
          timestamp: new Date(sample.timestamp).toISOString(),
        })),
      });
      for (const socket of app.websocketServer.clients) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        if (socket.bufferedAmount > 1024 * 1024) {
          socket.terminate();
          continue;
        }
        socket.send(event, (error) => {
          if (error) socket.terminate();
        });
      }
    }
    const assignment = await db.firmwareAssignment.findUnique({
      where: { deviceId: batch.deviceId },
      include: { release: true },
    });
    if (assignment) {
      if (assignment.release.version === batch.firmwareVersion) {
        if (assignment.status !== "succeeded") {
          await db.firmwareAssignment.update({
            where: { deviceId: batch.deviceId },
            data: { status: "succeeded", message: null },
          });
        }
      } else if (["assigned", "downloading", "installing"].includes(assignment.status)) {
        result.ack.firmwareUpdate = {
          releaseId: assignment.release.id,
          version: assignment.release.version,
          sha256: assignment.release.sha256,
          sizeBytes: assignment.release.sizeBytes,
          downloadUrl: `${process.env.PUBLIC_API_BASE_URL ?? "https://ebt.fly.dev"}/api/v1/firmware/releases/${assignment.release.id}`,
        };
      }
    }
    return result.ack;
  });

  app.post<{ Params: { id: string }; Body: Buffer }>("/api/v1/admin/devices/:id/firmware", {
    schema: { params },
  }, async (request, reply) => {
    if (!adminToken) return reply.code(503).send({ error: "Firmware updates are disabled on the server" });
    const token = request.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token || !timingSafeEqual(Buffer.from(hashKey(token), "hex"), Buffer.from(hashKey(adminToken), "hex"))) {
      return reply.code(401).send({ error: "Invalid admin token" });
    }
    if (request.headers["content-type"]?.split(";")[0].trim() !== "application/octet-stream") {
      return reply.code(415).send({ error: "Upload a firmware binary as application/octet-stream" });
    }
    const version = request.headers["x-firmware-version"];
    if (typeof version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(version)) {
      return reply.code(400).send({ error: "Provide a valid X-Firmware-Version header" });
    }
    const binary = request.body;
    if (!Buffer.isBuffer(binary) || binary.length < 1024) {
      return reply.code(400).send({ error: "Firmware binary is empty or too small" });
    }
    const device = await db.device.findUnique({ where: { id: request.params.id }, select: deviceSelect });
    if (!device) return reply.code(404).send({ error: "Unknown device" });
    const sha256 = createHash("sha256").update(binary).digest("hex");
    const id = randomUUID();
    const path = join(firmwareDirectory, `${id}.bin`);
    await mkdir(firmwareDirectory, { recursive: true });
    await writeFile(path, binary, { flag: "wx", mode: 0o600 });
    try {
      const release = await db.$transaction(async (tx) => {
        const created = await tx.firmwareRelease.create({
          data: { id, targetDeviceId: device.id, version, sha256, sizeBytes: binary.length },
          select: { id: true, targetDeviceId: true, version: true, sha256: true, sizeBytes: true, createdAt: true },
        });
        await tx.firmwareAssignment.upsert({
          where: { deviceId: device.id },
          create: { deviceId: device.id, releaseId: created.id, status: "assigned" },
          update: { releaseId: created.id, status: "assigned", message: null, assignedAt: new Date() },
        });
        return created;
      });
      return reply.code(201).send({ release, assignedTo: device.id });
    } catch (error) {
      await unlink(path).catch(() => undefined);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.code(409).send({ error: "That firmware version is already registered for this tracker" });
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/firmware/releases/:id", {
    schema: { params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } } },
  }, async (request, reply) => {
    const key = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{16,128})$/i)?.[1];
    if (!key) return reply.code(401).send({ error: "Invalid device credentials" });
    const assignment = await db.firmwareAssignment.findFirst({
      where: { releaseId: request.params.id, status: { in: ["assigned", "downloading", "installing"] } },
      include: { release: true, device: { select: { id: true, apiKeyHash: true } } },
    });
    if (!assignment || assignment.release.id !== request.params.id ||
        !timingSafeEqual(Buffer.from(assignment.device.apiKeyHash, "hex"), Buffer.from(hashKey(key), "hex"))) {
      return reply.code(404).send({ error: "Firmware update not available for this device" });
    }
    reply.header("Content-Type", "application/octet-stream");
    reply.header("Content-Length", assignment.release.sizeBytes);
    reply.header("Content-SHA256", assignment.release.sha256);
    reply.header("Cache-Control", "no-store");
    return reply.send(createReadStream(join(firmwareDirectory, `${assignment.release.id}.bin`)));
  });

  app.post<{ Params: { id: string }; Body: { releaseId: string; status: string; message?: string } }>("/api/v1/devices/:id/firmware-status", {
    schema: {
      params,
      body: {
        type: "object", additionalProperties: false, required: ["releaseId", "status"],
        properties: {
          releaseId: { type: "string", format: "uuid" },
          status: { enum: ["downloading", "installing", "failed"] },
          message: { type: "string", maxLength: 160 },
        },
      },
    },
  }, async (request, reply) => {
    const key = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{16,128})$/i)?.[1];
    if (!key) return reply.code(401).send({ error: "Invalid device credentials" });
    const device = await db.device.findUnique({ where: { id: request.params.id }, select: { id: true, apiKeyHash: true } });
    if (!device || !timingSafeEqual(Buffer.from(device.apiKeyHash, "hex"), Buffer.from(hashKey(key), "hex"))) {
      return reply.code(401).send({ error: "Invalid device credentials" });
    }
    const assignment = await db.firmwareAssignment.findUnique({ where: { deviceId: device.id } });
    if (!assignment || assignment.releaseId !== request.body.releaseId) {
      return reply.code(404).send({ error: "No matching firmware update is assigned" });
    }
    return db.firmwareAssignment.update({
      where: { deviceId: device.id },
      data: { status: request.body.status, message: request.body.message?.slice(0, 160) ?? null },
      select: { deviceId: true, releaseId: true, status: true, message: true, updatedAt: true },
    });
  });

  app.get("/api/v1/devices", async () => ({
    message: process.env.EBT_DASHBOARD_MESSAGE?.trim() || undefined,
    devices: await db.device.findMany({ select: deviceSelect, orderBy: { id: "asc" } }),
  }));

  app.patch<{ Params: { id: string }; Body: { displayName?: string; colour?: string | null } }>("/api/v1/devices/:id", {
    schema: {
      params,
      body: {
        type: "object",
        minProperties: 1,
        additionalProperties: false,
        properties: {
          displayName: { type: "string", minLength: 1, maxLength: 100 },
          colour: { anyOf: [{ type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, { type: "null" }] },
        },
      },
    },
  }, async (request, reply) => {
    if (!adminToken) return reply.code(503).send({ error: "Device editing is disabled on the server" });
    const token = request.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token || !timingSafeEqual(Buffer.from(hashKey(token), "hex"), Buffer.from(hashKey(adminToken), "hex"))) {
      return reply.code(401).send({ error: "Invalid admin token" });
    }
    const { colour } = request.body;
    const displayName = request.body.displayName?.trim();
    if (displayName === "") return reply.code(400).send({ error: "Enter a device name" });
    try {
      const device = await db.device.update({
        where: { id: request.params.id },
        data: { displayName, colour: typeof colour === "string" ? colour.toLowerCase() : colour },
        select: deviceSelect,
      });
      return { device };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        return reply.code(404).send({ error: "Unknown device" });
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/devices/:id/latest", {
    schema: { params },
  }, async (request, reply) => {
    const { id } = request.params;
    const device = await db.device.findUnique({ where: { id }, select: deviceSelect });
    if (!device) return reply.code(404).send({ error: "Unknown device" });
    const sample = await db.gpsSample.findFirst({
      where: { deviceId: id },
      orderBy: sampleOrder,
      omit: sampleOmit,
    });
    return { device, sample };
  });

  app.get<{ Params: { id: string }; Querystring: HistoryQuery }>("/api/v1/devices/:id/history", {
    schema: {
      params,
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {
          from: { $ref: "urn:ebt:telemetry:v1#/definitions/timestamp" },
          to: { $ref: "urn:ebt:telemetry:v1#/definitions/timestamp" },
          limit: { type: "string", pattern: "^(?:[1-9][0-9]{0,2}|1000)$" },
          offset: { type: "string", pattern: "^(?:0|[1-9][0-9]{0,8})$" },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const from = request.query.from ? new Date(request.query.from) : undefined;
    const to = request.query.to ? new Date(request.query.to) : undefined;
    const limit = Number(request.query.limit ?? 100);
    const offset = Number(request.query.offset ?? 0);
    if (from && to && from > to) return reply.code(400).send({ error: "from must be at or before to" });

    const device = await db.device.findUnique({ where: { id }, select: deviceSelect });
    if (!device) return reply.code(404).send({ error: "Unknown device" });
    const samples = await db.gpsSample.findMany({
      where: { deviceId: id, timestamp: { gte: from, lte: to } },
      orderBy: sampleOrder,
      skip: offset,
      take: limit + 1,
      omit: sampleOmit,
    });
    return { device, samples: samples.slice(0, limit), nextOffset: samples.length > limit ? offset + limit : null };
  });

  app.get("/api/v1/ws", { websocket: true }, (socket) => {
    socket.on("error", (error) => app.log.debug({ err: error }, "WebSocket client error"));
  });

  return app;
}
