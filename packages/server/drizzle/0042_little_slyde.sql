CREATE TABLE "staged_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"conversation_id" uuid,
	"filename" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"sha256" text,
	"path" text NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staged_files" ADD CONSTRAINT "staged_files_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staged_files" ADD CONSTRAINT "staged_files_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staged_files_profile_status_idx" ON "staged_files" USING btree ("profile_id","status");