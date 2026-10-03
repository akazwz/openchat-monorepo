CREATE TABLE "email_files" (
	"email_id" text,
	"file_id" text,
	CONSTRAINT "email_files_pkey" PRIMARY KEY("email_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "emails" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"status" text NOT NULL,
	"from_address" text NOT NULL,
	"from_name" text DEFAULT '' NOT NULL,
	"to" jsonb NOT NULL,
	"cc" jsonb NOT NULL,
	"bcc" jsonb NOT NULL,
	"reply_to" jsonb NOT NULL,
	"subject" text NOT NULL,
	"text" text NOT NULL,
	"message_id" text,
	"in_reply_to" text,
	"references" text,
	"run_id" text,
	"call_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"user_id" text PRIMARY KEY,
	"name" text NOT NULL UNIQUE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "email_files_file_idx" ON "email_files" ("file_id");--> statement-breakpoint
CREATE INDEX "emails_user_folder_idx" ON "emails" ("user_id","status","id");--> statement-breakpoint
CREATE UNIQUE INDEX "emails_received_message_unique" ON "emails" ("user_id","message_id") WHERE "status" = 'received';--> statement-breakpoint
CREATE UNIQUE INDEX "emails_call_unique" ON "emails" ("run_id","call_id");--> statement-breakpoint
ALTER TABLE "email_files" ADD CONSTRAINT "email_files_email_id_emails_id_fkey" FOREIGN KEY ("email_id") REFERENCES "emails"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "email_files" ADD CONSTRAINT "email_files_file_id_files_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id");--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");