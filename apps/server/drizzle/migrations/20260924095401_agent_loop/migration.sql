CREATE TABLE "memories" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"content" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "steps" DROP CONSTRAINT "steps_model_kind";--> statement-breakpoint
ALTER TABLE "steps" ADD COLUMN "tool_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "memories_user_updated_idx" ON "memories" ("user_id","updated_at");--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "steps_kind_valid" CHECK (("kind" = 1 and "tool_name" = '') or ("kind" = 2 and "tool_name" <> ''));--> statement-breakpoint
-- Runs have no step, token, or time budget any more. Rows that ended on one
-- become ordinary failures (status/stop reason values 6 and 2–4 are retired).
UPDATE "steps" SET "status" = 3 WHERE "status" = 6;--> statement-breakpoint
UPDATE "runs" SET "status" = 5, "stop_reason" = 6 WHERE "status" = 6;--> statement-breakpoint
UPDATE "runs" SET "stop_reason" = 6 WHERE "stop_reason" IN (2, 3, 4);--> statement-breakpoint
ALTER TABLE "steps" DROP CONSTRAINT "steps_status_valid", ADD CONSTRAINT "steps_status_valid" CHECK ("status" between 1 and 5);