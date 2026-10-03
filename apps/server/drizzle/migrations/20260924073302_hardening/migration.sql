-- Sessions stored raw tokens; they cannot become hashes, so everyone signs in again.
DELETE FROM "refresh_tokens";--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP CONSTRAINT "refresh_tokens_token_key";--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "token_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "previous_token_hash" text;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "rotated_at" text;--> statement-breakpoint
ALTER TABLE "verification_codes" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP COLUMN "token";--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP COLUMN "device_info";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "text";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "avatar";--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_token_hash_key" UNIQUE("token_hash");--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_previous_token_hash_key" UNIQUE("previous_token_hash");--> statement-breakpoint
CREATE INDEX "files_user_id_idx" ON "files" ("user_id","id");--> statement-breakpoint
CREATE INDEX "messages_parts_idx" ON "messages" USING gin ("parts" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens" ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens" ("expires_at");--> statement-breakpoint
CREATE INDEX "threads_user_id_idx" ON "threads" ("user_id","id");--> statement-breakpoint
CREATE INDEX "verification_codes_email_type_idx" ON "verification_codes" ("email","type","id");--> statement-breakpoint
CREATE INDEX "verification_codes_expires_at_idx" ON "verification_codes" ("expires_at");