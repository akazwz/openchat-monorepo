ALTER TABLE "emails" ADD COLUMN "dmarc" text;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
-- Mail kept before reading was tracked has been seen: it starts read.
UPDATE "emails" SET "read_at" = "created_at" WHERE "status" = 'received';
