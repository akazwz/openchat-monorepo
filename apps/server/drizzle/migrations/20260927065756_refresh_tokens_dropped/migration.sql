ALTER TABLE "retired_refresh_tokens" DROP CONSTRAINT "retired_refresh_tokens_session_id_refresh_tokens_id_fkey";--> statement-breakpoint
DROP TABLE "refresh_tokens";--> statement-breakpoint
DROP TABLE "retired_refresh_tokens";