CREATE TABLE "DashboardMessage" (
    "id" INTEGER NOT NULL PRIMARY KEY CHECK ("id" = 1),
    "message" TEXT NOT NULL,
    "revision" INTEGER NOT NULL
);
