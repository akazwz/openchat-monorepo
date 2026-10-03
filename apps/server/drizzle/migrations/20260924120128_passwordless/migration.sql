-- Codes of the retired kinds (sign-up, password reset) must not become sign-in
-- codes once their kind is dropped; codes are short-lived anyway.
DELETE FROM "verification_codes";--> statement-breakpoint
DROP INDEX "verification_codes_email_type_idx";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "password";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "email_verified_at";--> statement-breakpoint
ALTER TABLE "verification_codes" DROP COLUMN "type";--> statement-breakpoint
CREATE INDEX "verification_codes_email_idx" ON "verification_codes" ("email","id");