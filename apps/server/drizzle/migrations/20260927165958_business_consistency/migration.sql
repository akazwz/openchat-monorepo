CREATE TABLE "avatar_garbage" (
	"key" text PRIMARY KEY,
	"delete_after" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "avatar_garbage_delete_after_idx" ON "avatar_garbage" ("delete_after");