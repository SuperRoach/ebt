-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "displayName" TEXT NOT NULL,
    "apiKeyHash" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "GpsSample" (
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
    "batteryVoltage" REAL NOT NULL,
    "latitude" REAL,
    "longitude" REAL,
    "speedMps" REAL,
    "headingDeg" REAL,
    "fixValid" BOOLEAN NOT NULL,
    "satelliteCount" INTEGER NOT NULL,
    "hdop" REAL,

    PRIMARY KEY ("deviceId", "sequence"),
    CONSTRAINT "GpsSample_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Device_apiKeyHash_key" ON "Device"("apiKeyHash");

-- CreateIndex
CREATE INDEX "GpsSample_deviceId_timestamp_sequence_idx" ON "GpsSample"("deviceId", "timestamp", "sequence");

