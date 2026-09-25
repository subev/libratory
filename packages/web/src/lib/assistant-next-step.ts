// The "Next step for this book" card: one primary action and two questions, read off the book the
// way the chapter tray reads its one orange button. Pure, so each state is a line in a test.
export type NextStepBook = {
  id: string;
  kind: "pdf" | "digest" | "api";
  status: string;
  structureConfirmedAt: string | Date | null;
  outputPath: string | null;
  assembleQueued: boolean;
  files: { status: string; hasRawText: boolean }[];
  chapters: { selected: boolean; status: string; audioPath: string | null }[];
};

export type NextStep = {
  step: "text" | "extract" | "review" | "narrate" | "output" | "done";
  title: string;
  body: string;
  // Where the control is; null while the book is working and there is nothing to press
  action: { label: string; to: string } | null;
  questions: [string, string];
};

const IN_FLIGHT = new Set(["pending", "normalizing", "synthesizing"]);

export function nextStep(book: NextStepBook): NextStep {
  const page = `/books/${book.id}`;
  const extracting = book.status === "extracting" || book.files.some((f) => f.status === "extracting" || f.status === "pending");
  if (book.kind === "pdf" && book.files.length > 0 && !book.files.some((f) => f.hasRawText)) {
    return {
      step: "text",
      title: extracting ? "Reading the pages" : "No text yet",
      body: extracting
        ? "The text is being read. Scanned pages take longer: they go through OCR first."
        : "No file has given any text. The PDFs may be scans still waiting for OCR, or encrypted.",
      action: extracting ? null : { label: "Look at the source files", to: `${page}?tab=files` },
      questions: ["Why is there no text?", "What does OCR do here?"],
    };
  }
  if (book.chapters.length === 0) {
    return {
      step: "extract",
      title: extracting ? "Finding the chapters" : "Extract the chapters",
      body: extracting
        ? "The pages are being read thoroughly and split into chapters. This can take a while for a long book."
        : "The text is in. Extraction splits it into chapters, each of which gets its own voice and marker.",
      action: extracting ? null : { label: "Extract chapters", to: `${page}?extract=1` },
      questions: ["How long does extraction take?", "Should I let an AI read the table of contents?"],
    };
  }
  if (book.kind === "pdf" && !book.structureConfirmedAt) {
    return {
      step: "review",
      title: "Review the chapters",
      body: "The chapters were found automatically. Look them over, fix a boundary if one is wrong, then confirm them.",
      action: { label: "Open the chapters", to: `${page}?tab=chapters` },
      questions: ["What if a chapter boundary is wrong?", "Can the AI propose the chapters?"],
    };
  }
  const selected = book.chapters.filter((c) => c.selected);
  const inFlight = selected.filter((c) => IN_FLIGHT.has(c.status)).length;
  const withAudio = selected.filter((c) => c.audioPath !== null).length;
  if (inFlight > 0) {
    return {
      step: "narrate",
      title: "Narrating",
      body: `${inFlight} of ${selected.length} selected chapter${selected.length === 1 ? "" : "s"} still narrating. The rest can be assembled when they finish.`,
      action: null,
      questions: ["How long will narration take?", "Can I export while it runs?"],
    };
  }
  if (withAudio === 0) {
    return {
      step: "narrate",
      title: "Give the chapters a voice",
      body: "Pick a voice and speed in the Synthesize dialog under the chapter table. A local voice is free; cloud voices are metered.",
      action: { label: "Open the chapters", to: `${page}?tab=chapters` },
      questions: ["Which voice should I use?", "How much would a cloud voice cost?"],
    };
  }
  if (book.outputPath === null && !book.assembleQueued) {
    return {
      step: "output",
      title: "Make the audiobook",
      body: `${withAudio} chapter${withAudio === 1 ? " has" : "s have"} audio. Export… under the chapter table assembles one M4B with chapter markers, or a read-along EPUB.`,
      action: { label: "Open the chapters", to: `${page}?tab=chapters` },
      questions: ["What is a read-along EPUB?", "Where do I listen to it?"],
    };
  }
  return {
    step: "done",
    title: book.assembleQueued ? "Assembling" : "Audiobook ready",
    body: book.assembleQueued
      ? "The chapters are being joined into one file. It appears under Outputs when it is done."
      : "The M4B is under Outputs. Changing a voice, editing a chapter or excluding one and assembling again makes a new one.",
    action: { label: "Open the outputs", to: `${page}?tab=outputs` },
    questions: ["How do I put it on my phone?", "Can I re-narrate one chapter?"],
  };
}
