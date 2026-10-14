CREATE TABLE "shared_workspaces" (
    "room_id" UUID NOT NULL,
    "document" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "shared_workspaces_pkey" PRIMARY KEY ("room_id")
);
ALTER TABLE "shared_workspaces" ADD CONSTRAINT "shared_workspaces_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "roundtables"("id") ON DELETE CASCADE ON UPDATE CASCADE;
