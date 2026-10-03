CREATE TYPE "roundtable_status" AS ENUM ('OPEN', 'CLOSED');
CREATE TABLE "roundtables" (
  "id" UUID NOT NULL,
  "owner_id" UUID NOT NULL,
  "title" VARCHAR(60) NOT NULL,
  "goal" VARCHAR(500) NOT NULL,
  "date_from" VARCHAR(10) NOT NULL,
  "date_to" VARCHAR(10) NOT NULL,
  "start_time" VARCHAR(5) NOT NULL,
  "end_time" VARCHAR(5) NOT NULL,
  "duration_minutes" INTEGER NOT NULL,
  "status" "roundtable_status" NOT NULL DEFAULT 'OPEN',
  "version" INTEGER NOT NULL DEFAULT 1,
  "invite_code" VARCHAR(20) NOT NULL,
  "invite_expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "roundtables_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "roundtable_members" (
  "id" UUID NOT NULL,
  "room_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "share_busy" BOOLEAN NOT NULL DEFAULT false,
  "consent_updated_at" TIMESTAMPTZ(3),
  "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "roundtable_members_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "roundtables_invite_code_key" ON "roundtables"("invite_code");
CREATE INDEX "roundtables_owner_id_idx" ON "roundtables"("owner_id");
CREATE UNIQUE INDEX "roundtable_members_room_id_user_id_key" ON "roundtable_members"("room_id", "user_id");
CREATE INDEX "roundtable_members_user_id_idx" ON "roundtable_members"("user_id");
ALTER TABLE "roundtables" ADD CONSTRAINT "roundtables_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "roundtable_members" ADD CONSTRAINT "roundtable_members_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "roundtables"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "roundtable_members" ADD CONSTRAINT "roundtable_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
