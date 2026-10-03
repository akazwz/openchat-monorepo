ALTER TABLE "files" ADD COLUMN "workspace_path" text;--> statement-breakpoint
CREATE UNIQUE INDEX "files_workspace_path_idx" ON "files" ("user_id","workspace_path");