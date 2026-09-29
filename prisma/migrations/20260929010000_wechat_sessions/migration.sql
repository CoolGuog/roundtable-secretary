-- Preserve existing demo users and arrangements. No automatic identity merge.
ALTER TABLE "users" ADD COLUMN "wx_app_id" VARCHAR(18);
DROP INDEX "users_wx_open_id_key";
CREATE UNIQUE INDEX "users_wx_app_id_wx_open_id_key" ON "users"("wx_app_id", "wx_open_id");
CREATE TABLE "wechat_sessions" (
  "token_hash" VARCHAR(64) NOT NULL,
  "user_id" UUID NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wechat_sessions_pkey" PRIMARY KEY ("token_hash")
);
CREATE INDEX "wechat_sessions_user_id_created_at_idx" ON "wechat_sessions"("user_id", "created_at");
CREATE INDEX "wechat_sessions_expires_at_idx" ON "wechat_sessions"("expires_at");
ALTER TABLE "wechat_sessions" ADD CONSTRAINT "wechat_sessions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
