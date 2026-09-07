import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { router } from "./trpc.ts";
import { booksRouter } from "./routes/books.ts";
import { chaptersRouter } from "./routes/chapters.ts";
import { bookFilesRouter } from "./routes/bookFiles.ts";
import { variantsRouter } from "./routes/variants.ts";
import { notesRouter } from "./routes/notes.ts";
import { foldersRouter } from "./routes/folders.ts";
import { profilesRouter } from "./routes/profiles.ts";
import { searchRouter } from "./routes/search.ts";
import { sayVoicesRouter } from "./routes/say-voices.ts";
import { cartesiaVoicesRouter } from "./routes/cartesia-voices.ts";
import { elevenlabsVoicesRouter } from "./routes/elevenlabs-voices.ts";
import { pocketVoicesRouter } from "./routes/pocket-voices.ts";
import { llmModelsRouter } from "./routes/llm-models.ts";
import { rendererRouter } from "./routes/renderer.ts";
import { modelsRouter } from "./routes/models.ts";
import { ocrLanguagesRouter } from "./routes/ocr-languages.ts";
import { secretsRouter } from "./routes/secrets.ts";
import { workersRouter } from "./routes/workers.ts";

export const appRouter = router({
  books: booksRouter,
  folders: foldersRouter,
  profiles: profilesRouter,
  chapters: chaptersRouter,
  bookFiles: bookFilesRouter,
  variants: variantsRouter,
  notes: notesRouter,
  search: searchRouter,
  sayVoices: sayVoicesRouter,
  cartesiaVoices: cartesiaVoicesRouter,
  elevenlabsVoices: elevenlabsVoicesRouter,
  pocketVoices: pocketVoicesRouter,
  llmModels: llmModelsRouter,
  renderer: rendererRouter,
  models: modelsRouter,
  ocrLanguages: ocrLanguagesRouter,
  secrets: secretsRouter,
  workers: workersRouter,
});

export type AppRouter = typeof appRouter;

export type RouterOutputs = inferRouterOutputs<AppRouter>;

export type RouterInputs = inferRouterInputs<AppRouter>;
