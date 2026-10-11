CREATE TABLE "meeting_reviews" (
    "room_id" UUID NOT NULL,
    "document" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "meeting_reviews_pkey" PRIMARY KEY ("room_id")
);
ALTER TABLE "meeting_reviews" ADD CONSTRAINT "meeting_reviews_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "roundtables"("id") ON DELETE CASCADE ON UPDATE CASCADE;
