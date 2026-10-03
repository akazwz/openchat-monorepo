CREATE TABLE "files" (
	"id" text PRIMARY KEY,
	"url" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_name" text NOT NULL,
	"size" bigint NOT NULL,
	"user_id" text NOT NULL,
	"upload_ready" boolean DEFAULT false NOT NULL,
	"expires_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"run_id" text CONSTRAINT "messages_run_unique" UNIQUE,
	"role" text NOT NULL,
	"parts" jsonb DEFAULT '[]' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "messages_id_turn_thread_user_unique" UNIQUE("id","turn_id","thread_id","user_id"),
	CONSTRAINT "messages_id_run_turn_thread_user_unique" UNIQUE("id","run_id","turn_id","thread_id","user_id"),
	CONSTRAINT "messages_role_run_check" CHECK (("role" = 'user' and "run_id" is null) or ("role" = 'assistant' and "run_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"token" text NOT NULL UNIQUE,
	"expires_at" text NOT NULL,
	"device_info" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_checkpoints" (
	"run_id" text PRIMARY KEY,
	"checkpoint" jsonb NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"run_id" text,
	"revision" integer,
	"event" jsonb NOT NULL,
	CONSTRAINT "run_events_pkey" PRIMARY KEY("run_id","revision")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY,
	"thread_id" text NOT NULL,
	"user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"turn_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"previous_run_id" text,
	"output_message_id" text NOT NULL CONSTRAINT "runs_output_message_unique" UNIQUE,
	"model" text NOT NULL,
	"status" integer NOT NULL,
	"stop_reason" integer DEFAULT 0 NOT NULL,
	"model_steps" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL,
	"started_at" text,
	"finished_at" text,
	"deadline_at" text NOT NULL,
	CONSTRAINT "runs_id_turn_thread_user_unique" UNIQUE("id","turn_id","thread_id","user_id"),
	CONSTRAINT "runs_turn_attempt_unique" UNIQUE("turn_id","attempt"),
	CONSTRAINT "runs_attempt_positive" CHECK ("attempt" > 0),
	CONSTRAINT "runs_previous_attempt_check" CHECK (("attempt" = 1 and "previous_run_id" is null) or ("attempt" > 1 and "previous_run_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "steps" (
	"id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"index" integer NOT NULL,
	"kind" integer NOT NULL,
	"status" integer NOT NULL,
	"model" text NOT NULL,
	"response_id" text DEFAULT '' NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"error" text DEFAULT '' NOT NULL,
	"started_at" text NOT NULL,
	"finished_at" text,
	CONSTRAINT "steps_run_index_unique" UNIQUE("run_id","index"),
	CONSTRAINT "steps_index_positive" CHECK ("index" > 0),
	CONSTRAINT "steps_model_kind" CHECK ("kind" = 1),
	CONSTRAINT "steps_status_valid" CHECK ("status" between 1 and 6),
	CONSTRAINT "steps_lifecycle_check" CHECK (("status" = 1 and "finished_at" is null) or ("status" <> 1 and "finished_at" is not null)),
	CONSTRAINT "steps_usage_nonnegative" CHECK (("input_tokens" is null or "input_tokens" >= 0) and ("output_tokens" is null or "output_tokens" >= 0))
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"starred" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "threads_id_user_unique" UNIQUE("id","user_id")
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" text PRIMARY KEY,
	"thread_id" text NOT NULL,
	"user_id" text NOT NULL,
	"input_message_id" text NOT NULL CONSTRAINT "turns_input_message_unique" UNIQUE,
	"selected_run_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "turns_id_thread_user_unique" UNIQUE("id","thread_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY,
	"email" text NOT NULL UNIQUE,
	"username" text NOT NULL UNIQUE,
	"password" text NOT NULL,
	"avatar" text DEFAULT '' NOT NULL,
	"email_verified_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_codes" (
	"id" text PRIMARY KEY,
	"code" text NOT NULL,
	"type" text NOT NULL,
	"email" text NOT NULL,
	"expires_at" text NOT NULL,
	"used_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "files_expires_at_idx" ON "files" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_turn_input_unique" ON "messages" ("turn_id") WHERE "role" = 'user';--> statement-breakpoint
CREATE INDEX "messages_thread_id_idx" ON "messages" ("thread_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_user_request_idx" ON "runs" ("user_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_active_thread_idx" ON "runs" ("thread_id") WHERE "status" in (1, 2);--> statement-breakpoint
CREATE INDEX "runs_recovery_idx" ON "runs" ("id") WHERE "status" in (1, 2);--> statement-breakpoint
CREATE INDEX "turns_thread_id_idx" ON "turns" ("thread_id","id");--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_turn_owner_fk" FOREIGN KEY ("turn_id","thread_id","user_id") REFERENCES "turns"("id","thread_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_run_owner_fk" FOREIGN KEY ("run_id","turn_id","thread_id","user_id") REFERENCES "runs"("id","turn_id","thread_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "run_checkpoints" ADD CONSTRAINT "run_checkpoints_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_turn_owner_fk" FOREIGN KEY ("turn_id","thread_id","user_id") REFERENCES "turns"("id","thread_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_previous_run_fk" FOREIGN KEY ("previous_run_id","turn_id","thread_id","user_id") REFERENCES "runs"("id","turn_id","thread_id","user_id");--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "steps_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_thread_owner_fk" FOREIGN KEY ("thread_id","user_id") REFERENCES "threads"("id","user_id") ON DELETE CASCADE;--> statement-breakpoint
-- Hand-written: Drizzle cannot declare DEFERRABLE constraints, so these are not
-- in snapshot.json. A turn, its first run, and both messages are created in one
-- transaction; these circular identity references are checked at commit.
ALTER TABLE "turns" ADD CONSTRAINT "turns_input_message_fk" FOREIGN KEY ("input_message_id","id","thread_id","user_id") REFERENCES "messages"("id","turn_id","thread_id","user_id") DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_selected_run_fk" FOREIGN KEY ("selected_run_id","id","thread_id","user_id") REFERENCES "runs"("id","turn_id","thread_id","user_id") DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_output_message_fk" FOREIGN KEY ("output_message_id","id","turn_id","thread_id","user_id") REFERENCES "messages"("id","run_id","turn_id","thread_id","user_id") DEFERRABLE INITIALLY DEFERRED;
