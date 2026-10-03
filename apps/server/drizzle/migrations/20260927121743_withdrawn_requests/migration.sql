CREATE TABLE "withdrawn_requests" (
	"user_id" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withdrawn_requests_pkey" PRIMARY KEY("user_id","request_id")
);
--> statement-breakpoint
CREATE INDEX "withdrawn_requests_created_at_idx" ON "withdrawn_requests" ("created_at");--> statement-breakpoint
ALTER TABLE "withdrawn_requests" ADD CONSTRAINT "withdrawn_requests_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");