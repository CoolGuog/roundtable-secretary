CREATE TABLE "recurring_arrangements" (
  "id" UUID PRIMARY KEY,
  "owner_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "document" JSONB NOT NULL,
  "request_key" VARCHAR(36),
  "fingerprint" TEXT NOT NULL
);
CREATE UNIQUE INDEX "recurring_arrangements_owner_id_request_key_key" ON "recurring_arrangements"("owner_id", "request_key");
