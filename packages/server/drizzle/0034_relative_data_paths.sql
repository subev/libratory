-- These columns held absolute paths, which are only true of the machine that wrote them. Renaming
-- this checkout left 2547 rows pointing at a directory that no longer existed — every PDF, every
-- chapter's audio, every export — and the container, where DATA_DIR is /data, could never have
-- agreed with any of them. schema.ts now stores them relative to DATA_DIR; this is the same
-- rewrite for the rows already here.
--
-- Everything up to the last data-dir subdirectory goes, whatever prefix a given machine used, so
-- this works for a checkout, a moved checkout and /data alike. A path naming none of them is left
-- alone and stays absolute, which still resolves — fromStoredPath returns an absolute value
-- unchanged. Guarded on a leading slash, so re-running it changes nothing.
UPDATE "books" SET "pdf_path" = regexp_replace("pdf_path", '^.*/(uploads|output|previews|tmp|pocket-voices)/', '\1/') WHERE "pdf_path" LIKE '/%';--> statement-breakpoint
UPDATE "books" SET "output_path" = regexp_replace("output_path", '^.*/(uploads|output|previews|tmp|pocket-voices)/', '\1/') WHERE "output_path" LIKE '/%';--> statement-breakpoint
UPDATE "book_files" SET "pdf_path" = regexp_replace("pdf_path", '^.*/(uploads|output|previews|tmp|pocket-voices)/', '\1/') WHERE "pdf_path" LIKE '/%';--> statement-breakpoint
UPDATE "chapters" SET "audio_path" = regexp_replace("audio_path", '^.*/(uploads|output|previews|tmp|pocket-voices)/', '\1/') WHERE "audio_path" LIKE '/%';--> statement-breakpoint
UPDATE "chapter_translations" SET "audio_path" = regexp_replace("audio_path", '^.*/(uploads|output|previews|tmp|pocket-voices)/', '\1/') WHERE "audio_path" LIKE '/%';--> statement-breakpoint
UPDATE "assemblies" SET "output_path" = regexp_replace("output_path", '^.*/(uploads|output|previews|tmp|pocket-voices)/', '\1/') WHERE "output_path" LIKE '/%';--> statement-breakpoint
UPDATE "documents" SET "output_path" = regexp_replace("output_path", '^.*/(uploads|output|previews|tmp|pocket-voices)/', '\1/') WHERE "output_path" LIKE '/%';
