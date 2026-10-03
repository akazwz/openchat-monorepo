-- Hand-written: the baseline's circular DEFERRABLE references (turn → input
-- message, turn → selected run, run → output message) are not in snapshot.json;
-- they go first, before the unique constraints they point at.
ALTER TABLE "turns" DROP CONSTRAINT "turns_input_message_fk";--> statement-breakpoint
ALTER TABLE "turns" DROP CONSTRAINT "turns_selected_run_fk";--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_output_message_fk";--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_previous_run_fk";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_id_turn_thread_user_unique";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_id_run_turn_thread_user_unique";--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_output_message_unique";--> statement-breakpoint
ALTER TABLE "turns" DROP CONSTRAINT "turns_input_message_unique";--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_previous_attempt_check";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "previous_run_id";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "output_message_id";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "computer_id";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "stop_reason";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "model_steps";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "output_tokens";--> statement-breakpoint
ALTER TABLE "steps" DROP COLUMN "model";--> statement-breakpoint
ALTER TABLE "turns" DROP COLUMN "input_message_id";--> statement-breakpoint
ALTER TABLE "turns" DROP COLUMN "selected_run_id";--> statement-breakpoint
ALTER TABLE "turns" DROP COLUMN "revision";--> statement-breakpoint
ALTER TABLE "turns" DROP COLUMN "updated_at";