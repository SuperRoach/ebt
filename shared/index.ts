import telemetrySchema from "./telemetry-v1.schema.json" with { type: "json" };

export { telemetrySchema };

export interface GpsSample {
  sequence: string;
  timestamp: string;
  latitude: number | null;
  longitude: number | null;
  speedMps: number | null;
  headingDeg: number | null;
  fixValid: boolean;
  satelliteCount: number;
  hdop?: number;
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
  batteryVoltage: number;
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
