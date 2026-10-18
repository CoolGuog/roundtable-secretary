-- Existing open demo rooms adopt membership-based secretary participation.
UPDATE "roundtables" SET "version" = "version" + 1 WHERE "status" = 'OPEN';
UPDATE "roundtable_members" AS m SET "share_busy" = true, "consent_updated_at" = NOW()
FROM "roundtables" AS r WHERE m."room_id" = r."id" AND r."status" = 'OPEN';
