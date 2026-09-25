-- Every conversation is the assistant's now: the library chat page is the assistant full width,
-- so the threads it kept join the same history
UPDATE "chat_conversations" SET "kind" = 'assistant' WHERE "kind" = 'library';
