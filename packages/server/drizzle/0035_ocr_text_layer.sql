ALTER TABLE "book_files" ADD COLUMN "searchable_pdf_path" text;--> statement-breakpoint
ALTER TABLE "book_files" ADD COLUMN "ocr_engine" text;--> statement-breakpoint
ALTER TABLE "book_files" ADD COLUMN "ocr_confidence" real;--> statement-breakpoint
ALTER TABLE "book_files" ADD COLUMN "ocr_low_confidence_fraction" real;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "ocr_engine" text;--> statement-breakpoint
-- Tesseract is the only engine with a runner, so every book that asked for OCR asked for it.
UPDATE "books" SET "ocr_engine" = 'tesseract' WHERE "force_ocr";--> statement-breakpoint
ALTER TABLE "books" DROP COLUMN "force_ocr";
