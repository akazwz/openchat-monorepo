ALTER TABLE "files" ADD COLUMN "placed_at" text;--> statement-breakpoint
-- Attachments with a path were put on the computer when their run started.
UPDATE "files" SET "placed_at" = "updated_at" WHERE "workspace_path" IS NOT NULL;