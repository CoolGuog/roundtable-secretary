-- 协商方案与确认（第 15、16 步）。Additive：只加表，不动既有用户与日程。
CREATE TYPE "proposal_status" AS ENUM ('OPEN', 'CONFIRMED', 'REJECTED', 'EXPIRED', 'CANCELLED');
CREATE TYPE "proposal_decision" AS ENUM ('PENDING', 'ACCEPT', 'REJECT');

CREATE TABLE "proposals" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "date" VARCHAR(10) NOT NULL,
    "start_time" VARCHAR(5) NOT NULL,
    "end_time" VARCHAR(5) NOT NULL,
    "room_version" INTEGER NOT NULL,
    "status" "proposal_status" NOT NULL DEFAULT 'OPEN',
    "created_by" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "applied_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "proposals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "proposal_votes" (
    "id" UUID NOT NULL,
    "proposal_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "decision" "proposal_decision" NOT NULL DEFAULT 'PENDING',
    "decided_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "proposal_votes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "proposals_room_id_status_idx" ON "proposals"("room_id", "status");
CREATE UNIQUE INDEX "proposal_votes_proposal_id_user_id_key" ON "proposal_votes"("proposal_id", "user_id");
CREATE INDEX "proposal_votes_user_id_idx" ON "proposal_votes"("user_id");

ALTER TABLE "proposals" ADD CONSTRAINT "proposals_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "roundtables"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "proposal_votes" ADD CONSTRAINT "proposal_votes_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "proposal_votes" ADD CONSTRAINT "proposal_votes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
