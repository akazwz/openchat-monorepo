CREATE TABLE "devices" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"name" text NOT NULL,
	"platform" text DEFAULT 'macos' NOT NULL,
	"os_version" text NOT NULL,
	"workspace_path" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "devices_user_client_unique" UNIQUE("user_id","client_id")
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_device_id_devices_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id");