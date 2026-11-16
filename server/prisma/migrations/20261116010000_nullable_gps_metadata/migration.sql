BEGIN;

CREATE TABLE "new_GpsSample" (
    "deviceId" TEXT NOT NULL,
    "sequence" TEXT NOT NULL,
    "captureHash" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "receivedAt" DATETIME NOT NULL,
    "protocolVersion" INTEGER NOT NULL,
    "firmwareVersion" TEXT NOT NULL,
    "recordingSessionId" TEXT NOT NULL,
    "recordingState" TEXT NOT NULL,
    "transport" TEXT NOT NULL,
    "cellularRssiDbm" REAL,
    "cellularRsrpDbm" REAL,
    "cellularRsrqDb" REAL,
    "cellularSinrDb" REAL,
    "batteryVoltage" REAL,
    "latitude" REAL,
    "longitude" REAL,
    "speedMps" REAL,
    "headingDeg" REAL,
    "fixValid" BOOLEAN NOT NULL,
    "satelliteCount" INTEGER,
    "hdop" REAL,
    "gpsStatusReason" TEXT,
    PRIMARY KEY ("deviceId", "sequence"),
    CONSTRAINT "GpsSample_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "new_GpsSample" (
    "deviceId", "sequence", "captureHash", "timestamp", "receivedAt", "protocolVersion",
    "firmwareVersion", "recordingSessionId", "recordingState", "transport",
    "cellularRssiDbm", "cellularRsrpDbm", "cellularRsrqDb", "cellularSinrDb",
    "batteryVoltage", "latitude", "longitude", "speedMps", "headingDeg",
    "fixValid", "satelliteCount", "hdop", "gpsStatusReason"
)
SELECT
    "deviceId", "sequence", "captureHash", "timestamp", "receivedAt", "protocolVersion",
    "firmwareVersion", "recordingSessionId", "recordingState", "transport",
    "cellularRssiDbm", "cellularRsrpDbm", "cellularRsrqDb", "cellularSinrDb",
    "batteryVoltage", "latitude", "longitude", "speedMps", "headingDeg",
    "fixValid", "satelliteCount", "hdop", "gpsStatusReason"
FROM "GpsSample";

DROP TABLE "GpsSample";
ALTER TABLE "new_GpsSample" RENAME TO "GpsSample";
CREATE INDEX "GpsSample_deviceId_timestamp_sequence_idx" ON "GpsSample"("deviceId", "timestamp", "sequence");

COMMIT;
