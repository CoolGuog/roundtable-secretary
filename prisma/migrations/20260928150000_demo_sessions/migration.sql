-- Additive migration: existing users, arrangements and memories are preserved.
CREATE TABLE "demo_sessions" (
  "token_hash" VARCHAR(64) NOT NULL,
  "user_id" UUID NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "demo_sessions_pkey" PRIMARY KEY ("token_hash")
);
CREATE INDEX "demo_sessions_user_id_idx" ON "demo_sessions"("user_id");
CREATE INDEX "demo_sessions_expires_at_idx" ON "demo_sessions"("expires_at");
ALTER TABLE "demo_sessions" ADD CONSTRAINT "demo_sessions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
