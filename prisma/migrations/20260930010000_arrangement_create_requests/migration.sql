CREATE TABLE "arrangement_create_requests" (
  "user_id" UUID NOT NULL,
  "request_key" UUID NOT NULL,
  "fingerprint" VARCHAR(64) NOT NULL,
  "arrangement_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "arrangement_create_requests_pkey" PRIMARY KEY ("user_id", "request_key")
);
CREATE INDEX "arrangement_create_requests_arrangement_id_idx" ON "arrangement_create_requests"("arrangement_id");
ALTER TABLE "arrangement_create_requests" ADD CONSTRAINT "arrangement_create_requests_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "arrangement_create_requests" ADD CONSTRAINT "arrangement_create_requests_arrangement_id_fkey"
  FOREIGN KEY ("arrangement_id") REFERENCES "arrangements"("id") ON DELETE SET NULL ON UPDATE CASCADE;
