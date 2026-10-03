ALTER TABLE "workspace_backups" DROP COLUMN "local";--> statement-breakpoint
-- Runs from before a computer could be chosen ran on the cloud computer, the
-- only one there is.
UPDATE "runs" SET "computer_id" = 'cloud' WHERE "computer_id" IS NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "computer_id" SET NOT NULL;