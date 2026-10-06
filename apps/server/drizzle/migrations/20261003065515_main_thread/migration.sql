ALTER TABLE "threads" ADD COLUMN "main" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "threads_user_main_idx" ON "threads" ("user_id") WHERE "main";