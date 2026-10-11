-- Legacy arrangements have no reliable provenance; retain them unchanged.
ALTER TABLE "arrangements" ADD COLUMN "source_room_id" UUID;
CREATE UNIQUE INDEX "arrangements_owner_id_source_room_id_key" ON "arrangements"("owner_id", "source_room_id");
ALTER TABLE "arrangements" ADD CONSTRAINT "arrangements_source_room_id_fkey" FOREIGN KEY ("source_room_id") REFERENCES "roundtables"("id") ON DELETE SET NULL ON UPDATE CASCADE;
