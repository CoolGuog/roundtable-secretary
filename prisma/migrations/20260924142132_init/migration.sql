-- CreateEnum
CREATE TYPE "negotiation_scope" AS ENUM ('PRIVATE', 'BUSY_ONLY', 'TITLE_AND_TIME');

-- CreateEnum
CREATE TYPE "memory_category" AS ENUM ('PREFERENCE', 'CONSTRAINT', 'NOTE');

-- CreateEnum
CREATE TYPE "memory_source" AS ENUM ('USER_INPUT', 'SECRETARY');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "wx_open_id" VARCHAR(64),
    "wx_union_id" VARCHAR(64),
    "display_name" VARCHAR(20) NOT NULL,
    "secretary_name" VARCHAR(20) NOT NULL DEFAULT '小圆',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "arrangements" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "title" VARCHAR(60) NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "timezone" VARCHAR(40) NOT NULL DEFAULT 'Asia/Shanghai',
    "scope" "negotiation_scope" NOT NULL DEFAULT 'PRIVATE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "arrangements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "personal_memories" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "category" "memory_category" NOT NULL DEFAULT 'PREFERENCE',
    "label" VARCHAR(40) NOT NULL,
    "content" VARCHAR(500) NOT NULL,
    "source" "memory_source" NOT NULL DEFAULT 'USER_INPUT',
    "source_ref" VARCHAR(200),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "personal_memories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_wx_open_id_key" ON "users"("wx_open_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_wx_union_id_key" ON "users"("wx_union_id");

-- CreateIndex
CREATE INDEX "arrangements_owner_id_starts_at_idx" ON "arrangements"("owner_id", "starts_at");

-- CreateIndex
CREATE INDEX "personal_memories_user_id_idx" ON "personal_memories"("user_id");

-- AddForeignKey
ALTER TABLE "arrangements" ADD CONSTRAINT "arrangements_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personal_memories" ADD CONSTRAINT "personal_memories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
