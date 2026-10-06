CREATE TABLE "schedules" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"instructions" text NOT NULL,
	"next_at" timestamp with time zone NOT NULL,
	"every_count" integer,
	"every_unit" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "scheduled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "schedules_user_next_idx" ON "schedules" ("user_id","next_at");--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_thread_owner_fk" FOREIGN KEY ("thread_id","user_id") REFERENCES "threads"("id","user_id") ON DELETE CASCADE;