CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"paired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "shelf_downloads" (
	"device_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"downloaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shelf_downloads_device_document" UNIQUE("device_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "shelf_hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelf_downloads" ADD CONSTRAINT "shelf_downloads_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelf_downloads" ADD CONSTRAINT "shelf_downloads_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;