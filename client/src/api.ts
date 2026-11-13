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
}

export interface TelemetryEvent extends TelemetryBatch {
  type: "telemetry";
  receivedAt: string;
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
  const response = await fetch(new URL(`/api/v1/devices${path}`, apiOrigin), {
    ...options, signal, cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `Tracking API returned HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const listDevices = (signal: AbortSignal) => request<{ devices: Device[] }>("", { signal });
export const history = (id: string, signal: AbortSignal) =>
  request<{ samples: StoredSample[] }>(`/${encodeURIComponent(id)}/history?limit=200`, { signal });

export const updateDevice = (id: string, settings: DeviceSettings, token: string) =>
  request<{ device: Device }>(`/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(settings),
  });
