-- The transcript moves out of the checkpoint into a column of its own; a
-- checkpoint saved before this carries its transcript to it, so a run in
-- flight resumes as it was.
ALTER TABLE "run_checkpoints" ADD COLUMN "messages" jsonb;--> statement-breakpoint
UPDATE "run_checkpoints" SET "messages" = "checkpoint"->'messages', "checkpoint" = "checkpoint" - 'messages';--> statement-breakpoint
ALTER TABLE "run_checkpoints" ALTER COLUMN "messages" SET NOT NULL;
