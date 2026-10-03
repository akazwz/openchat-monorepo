CREATE SEQUENCE "public"."workspace_backup_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "workspace_backups" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"dir" text NOT NULL,
	"local" boolean NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "workspace_backups_user_seq_idx" ON "workspace_backups" ("user_id","seq");--> statement-breakpoint
ALTER TABLE "workspace_backups" ADD CONSTRAINT "workspace_backups_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");