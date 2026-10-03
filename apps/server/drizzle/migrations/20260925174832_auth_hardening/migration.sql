CREATE TABLE "retired_refresh_tokens" (
	"token_hash" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"retired_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP CONSTRAINT "refresh_tokens_previous_token_hash_key";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_username_key";--> statement-breakpoint
-- Codes live ten minutes and none records who asked for it; pending ones are
-- dropped, and their addresses request new ones.
DELETE FROM "verification_codes";--> statement-breakpoint
ALTER TABLE "verification_codes" ADD COLUMN "requester_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP COLUMN "previous_token_hash";--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP COLUMN "rotated_at";--> statement-breakpoint
CREATE INDEX "retired_refresh_tokens_session_id_idx" ON "retired_refresh_tokens" ("session_id");--> statement-breakpoint
ALTER TABLE "retired_refresh_tokens" ADD CONSTRAINT "retired_refresh_tokens_session_id_refresh_tokens_id_fkey" FOREIGN KEY ("session_id") REFERENCES "refresh_tokens"("id") ON DELETE CASCADE;