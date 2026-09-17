CREATE TABLE "extraction_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "extraction_settings" jsonb;