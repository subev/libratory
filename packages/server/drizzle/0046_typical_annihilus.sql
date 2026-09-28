CREATE TABLE "bilingual_preparations" (
	"variant_id" uuid PRIMARY KEY NOT NULL,
	"pairs" jsonb,
	"links" jsonb,
	"pair_job" jsonb,
	"link_job" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bilingual_preparations" ADD CONSTRAINT "bilingual_preparations_variant_id_chapter_translations_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."chapter_translations"("id") ON DELETE cascade ON UPDATE no action;