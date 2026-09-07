ALTER TABLE "book_files" ADD COLUMN "searchable_pdf_path" text;--> statement-breakpoint
ALTER TABLE "book_files" ADD COLUMN "ocr_engine" text;--> statement-breakpoint
ALTER TABLE "book_files" ADD COLUMN "ocr_confidence" real;--> statement-breakpoint
ALTER TABLE "book_files" ADD COLUMN "ocr_low_confidence_fraction" real;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "ocr_engine" text;--> statement-breakpoint
-- force_ocr meant "hand the pages to Marker and let it re-read them", which is now a text-layer
-- step with a named engine. Every book that asked for OCR asked for the only engine there is.
UPDATE "books" SET "ocr_engine" = 'tesseract' WHERE "force_ocr";--> statement-breakpoint
ALTER TABLE "books" DROP COLUMN "force_ocr";
