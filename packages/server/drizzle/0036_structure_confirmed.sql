ALTER TABLE "books" ADD COLUMN "structure_confirmed_at" timestamp with time zone;
UPDATE "books" SET "structure_confirmed_at" = "updated_at" WHERE EXISTS (SELECT 1 FROM "chapters" WHERE "chapters"."book_id" = "books"."id");
