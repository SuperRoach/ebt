import telemetrySchema from "./telemetry-v1.schema.json" with { type: "json" };

export { telemetrySchema };

export type GpsStatusReason = "modem-no-response" | "no-fix" | "incomplete-response"
  | "invalid-position" | "invalid-latitude" | "invalid-longitude" | "invalid-gps-time"
  | "repeated-timestamp" | "motion-unavailable"
  | "satellite-count-unavailable" | "battery-unavailable";

export interface GpsSample {
  sequence: string;
  timestamp: string;
  latitude: number | null;
  longitude: number | null;
  speedMps: number | null;
  headingDeg: number | null;
  fixValid: boolean;
  satelliteCount: number | null;
  hdop?: number;
  gpsStatusReason?: GpsStatusReason;
}

export interface CellularSignal {
  rssiDbm?: number;
  rsrpDbm?: number;
  rsrqDb?: number;
  sinrDb?: number;
}

export interface TelemetryBatch {
  version: 1;
  deviceId: string;
  firmwareVersion: string;
  recordingSessionId: string;
  recordingState: "idle" | "recording" | "paused" | "stopped";
  transport: "wifi" | "4g";
  cellularSignal?: CellularSignal;
  batteryVoltage: number | null;
  samples: GpsSample[];
}

export interface TelemetryAck {
  version: 1;
  deviceId: string;
  accepted: { sequence: string; status: "stored" | "duplicate" }[];
  firmwareUpdate?: FirmwareUpdateOffer;
}

export interface FirmwareUpdateOffer {
  releaseId: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  downloadUrl: string;
}
