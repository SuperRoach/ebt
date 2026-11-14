CREATE TABLE "FirmwareRelease" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetDeviceId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FirmwareRelease_targetDeviceId_fkey" FOREIGN KEY ("targetDeviceId") REFERENCES "Device" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "FirmwareRelease_targetDeviceId_version_key" ON "FirmwareRelease"("targetDeviceId", "version");
CREATE INDEX "FirmwareRelease_targetDeviceId_createdAt_idx" ON "FirmwareRelease"("targetDeviceId", "createdAt");

CREATE TABLE "FirmwareAssignment" (
    "deviceId" TEXT NOT NULL PRIMARY KEY,
    "releaseId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'assigned',
    "message" TEXT,
    "assignedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FirmwareAssignment_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FirmwareAssignment_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "FirmwareRelease" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "FirmwareAssignment_releaseId_key" ON "FirmwareAssignment"("releaseId");
