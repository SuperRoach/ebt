-- Renaming the primary keys cascades to the GPS samples.
BEGIN;
UPDATE "Device"
SET "id" = 'lps-' || "id"
WHERE "id" IN ('ebt-01', 'ebt-02');
COMMIT;
