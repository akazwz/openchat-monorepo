DROP INDEX "threads_user_id_idx";--> statement-breakpoint
ALTER TABLE "threads" ALTER COLUMN "updated_at" SET DATA TYPE timestamp(3) with time zone USING "updated_at"::timestamp(3) with time zone;--> statement-breakpoint
CREATE INDEX "threads_user_active_idx" ON "threads" ("user_id","updated_at","id");