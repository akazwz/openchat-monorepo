CREATE TABLE "message_part_chunks" (
	"message_id" text,
	"part_id" text,
	"index" integer,
	"data" text NOT NULL,
	CONSTRAINT "message_part_chunks_pkey" PRIMARY KEY("message_id","part_id","index"),
	CONSTRAINT "message_part_chunks_index_check" CHECK ("index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "message_parts" (
	"message_id" text,
	"id" text,
	"ordinal" integer NOT NULL,
	"meta" jsonb NOT NULL,
	"chunks" integer NOT NULL,
	"chars" integer NOT NULL,
	"model_chars" integer NOT NULL,
	"step_index" integer,
	CONSTRAINT "message_parts_pkey" PRIMARY KEY("message_id","id"),
	CONSTRAINT "message_parts_ordinal_unique" UNIQUE("message_id","ordinal"),
	CONSTRAINT "message_parts_position_check" CHECK ("ordinal" >= 0 and "chunks" >= 0 and "chars" >= 0 and "model_chars" >= 0)
);
--> statement-breakpoint
CREATE TABLE "run_archive_pages" (
	"run_id" text,
	"index" integer,
	"digest" text NOT NULL,
	CONSTRAINT "run_archive_pages_pkey" PRIMARY KEY("run_id","index")
);
--> statement-breakpoint
CREATE TABLE "run_archives" (
	"run_id" text PRIMARY KEY,
	"seal_id" text NOT NULL,
	"pages" integer DEFAULT 0 NOT NULL,
	"records" integer DEFAULT 0 NOT NULL,
	"digest" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
DROP TABLE "run_checkpoints";--> statement-breakpoint
ALTER TABLE "steps" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "steps" ALTER COLUMN "started_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message_part_chunks" ADD CONSTRAINT "message_part_chunks_9lIwPDbtqkJ9_fkey" FOREIGN KEY ("message_id","part_id") REFERENCES "message_parts"("message_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message_parts" ADD CONSTRAINT "message_parts_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "run_archive_pages" ADD CONSTRAINT "run_archive_pages_run_id_run_archives_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run_archives"("run_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "run_archives" ADD CONSTRAINT "run_archives_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "steps_pending_not_started" CHECK ("status" <> 7 or "started_at" is null);--> statement-breakpoint
ALTER TABLE "steps" DROP CONSTRAINT "steps_status_valid", ADD CONSTRAINT "steps_status_valid" CHECK ("status" between 1 and 5 or "status" = 7);--> statement-breakpoint
ALTER TABLE "steps" DROP CONSTRAINT "steps_lifecycle_check", ADD CONSTRAINT "steps_lifecycle_check" CHECK (("status" in (1, 7) and "finished_at" is null) or ("status" not in (1, 7) and "finished_at" is not null));