import type { GpsSample, TelemetryBatch } from "@ebt/shared";

export interface Device {
  id: string;
  displayName: string;
  colour?: string | null;
}

export type DeviceSettings = Pick<Device, "displayName" | "colour">;

export interface StoredSample extends Omit<GpsSample, "hdop">,
  Pick<TelemetryBatch, "deviceId" | "firmwareVersion" | "recordingSessionId" | "recordingState" | "transport" | "batteryVoltage"> {
  protocolVersion: number;
  receivedAt: string;
  hdop: number | null;
  cellularRssiDbm: number | null;
  cellularRsrpDbm: number | null;
  cellularRsrqDb: number | null;
  cellularSinrDb: number | null;
}

export interface TelemetryEvent extends TelemetryBatch {
  type: "telemetry";
  receivedAt: string;
}

export interface DashboardMessage {
  message: string;
  revision: number;
}

export const apiOrigin = import.meta.env.VITE_API_BASE_URL || window.location.origin;

export function socketUrl() {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
  const url = new URL("/api/v1/ws", apiOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const timeout = AbortSignal.timeout(10_000);
  const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(new URL(`/api/v1${path}`, apiOrigin), {
    ...options, signal, cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `Tracking API returned HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const listDevices = (signal: AbortSignal) =>
  request<{ devices: Device[]; message?: string; messageRevision?: number }>("/devices", { signal });
export const history = (id: string, signal: AbortSignal) =>
  request<{ samples: StoredSample[] }>(`/devices/${encodeURIComponent(id)}/history?limit=200`, { signal });

export const updateDevice = (id: string, settings: DeviceSettings, token: string) =>
  request<{ device: Device }>(`/devices/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(settings),
  });

export async function uploadFirmware(id: string, version: string, file: File, token: string) {
  const response = await fetch(new URL(`/api/v1/admin/devices/${encodeURIComponent(id)}/firmware`, apiOrigin), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "X-Firmware-Version": version,
    },
    body: file,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `Firmware upload returned HTTP ${response.status}`);
  }
  return response.json() as Promise<{ release: { id: string; version: string }; assignedTo: string }>;
}

export const updateDashboardMessage = (message: string, token: string) =>
  request<DashboardMessage>("/dashboard-message", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message }),
  });
