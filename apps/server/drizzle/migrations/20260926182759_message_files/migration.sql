CREATE TABLE "message_files" (
	"message_id" text,
	"file_id" text,
	CONSTRAINT "message_files_pkey" PRIMARY KEY("message_id","file_id")
);
--> statement-breakpoint
DROP INDEX "files_expires_at_idx";--> statement-breakpoint
DROP INDEX "messages_parts_idx";--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "status" text DEFAULT 'uploading' NOT NULL;--> statement-breakpoint
-- Hand-written: the status the dropped columns meant, and the references
-- the messages' parts hold (attachments, files shown, tool result images).
UPDATE "files" SET "status" = CASE WHEN NOT "upload_ready" THEN 'uploading' WHEN "expires_at" IS NOT NULL AND "expires_at" <= now() THEN 'deleting' ELSE 'stored' END;--> statement-breakpoint
INSERT INTO "message_files" ("message_id", "file_id")
SELECT DISTINCT m."id", f."id"
FROM "messages" m
CROSS JOIN LATERAL jsonb_array_elements(m."parts") AS p(part)
CROSS JOIN LATERAL (
	SELECT p.part->'content'->'value'->>'id' AS id
	WHERE p.part->'content'->>'case' = 'file'
	UNION ALL
	SELECT image->>'id'
	FROM jsonb_array_elements(
		CASE WHEN p.part->'content'->>'case' = 'toolResult'
		THEN coalesce(p.part->'content'->'value'->'images', '[]'::jsonb)
		ELSE '[]'::jsonb END
	) AS image
) AS ref
JOIN "files" f ON f."id" = ref.id AND f."user_id" = m."user_id";--> statement-breakpoint
ALTER TABLE "files" DROP COLUMN "url";--> statement-breakpoint
ALTER TABLE "files" DROP COLUMN "upload_ready";--> statement-breakpoint
ALTER TABLE "files" DROP COLUMN "expires_at";--> statement-breakpoint
CREATE INDEX "files_created_at_idx" ON "files" ("created_at");--> statement-breakpoint
CREATE INDEX "message_files_file_idx" ON "message_files" ("file_id");--> statement-breakpoint
ALTER TABLE "message_files" ADD CONSTRAINT "message_files_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message_files" ADD CONSTRAINT "message_files_file_id_files_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id");