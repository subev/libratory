import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generateText, tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import { createMcpServer } from "./mcp-server.ts";
import { APP_TARGETS, appUrlFor } from "./assistant-targets.ts";
import { buildChatTools, type ChatSearchScope, type CitationCatalog } from "./chat-tools.ts";
import { buildAskContext } from "./ask-ai.ts";
import { contextExceeded, type LlmModelDef } from "./llm.ts";
import { estimateTokens } from "./token-estimate.ts";
import { saveNote } from "./notes.ts";
import { AUTO_TIERS, isAssistantTool, tierOf, type AssistantToolName } from "./assistant-tiers.ts";

export { AUTO_TIERS, TOOL_TIERS, isAssistantTool, tierOf, type AssistantToolName, type ToolTier } from "./assistant-tiers.ts";

export type AssistantToolSet = {
  // Every tool, described and executable. Which calls wait for a yes is the SDK's toolApproval
  // decision (`needsApproval` below), taken per call — a rename runs, a text replacement waits.
  tools: ToolSet;
  // Runs one tool as the server, outside a model turn: the card's Undo
  run: (name: AssistantToolName, input: Record<string, unknown>) => Promise<unknown>;
  close: () => Promise<void>;
};

// For streamText's toolApproval: a call outside the tiers that run on their own ends the turn as
// a request the panel shows as a card. The server executes it once the person says yes, never the
// browser, because the response only carries the approval and the tool still runs here.
export function needsApproval({ toolCall }: { toolCall: { toolName: string; input: unknown } }): "user-approval" | "not-applicable" {
  const name = toolCall.toolName;
  if (!isAssistantTool(name)) return "user-approval";
  return AUTO_TIERS.has(tierOf(name, (toolCall.input ?? {}) as Record<string, unknown>)) ? "not-applicable" : "user-approval";
}

type ToolResult = { content?: { type: string; text?: string }[]; isError?: boolean };

// The MCP server answers with a text block holding JSON. Handed to the model as it is, that JSON
// arrives once more encoded inside the result object — every book listed twice over. Unwrapped,
// the model sees what the tool said; an error becomes a thrown error, which the SDK reports as one.
function unwrap(result: unknown): unknown {
  const { content, isError } = (result ?? {}) as ToolResult;
  const text = (content ?? []).flatMap((c) => (c.type === "text" && typeof c.text === "string" ? [c.text] : [])).join("\n");
  if (isError) throw new Error(text || "The tool failed");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// The one tool the MCP surface does not have, because an agent has no screen: it names a place
// in the app, the panel follows the call as it arrives, and the answer says where it went.
const showInApp = tool({
  description:
    "Take the person to a place in the app, in the window the panel is open in: the library, a folder, a book (or one of its tabs — source files, chapters, outputs, notes), " +
    "one of the book's dialogs (extract, review-chapters, synthesize, export), one chapter's own view, or the reader at a chapter and a moment of its narration. " +
    "Use it right after you did or found the thing worth looking at — the book just made, the chapter in question, the dialog for the step you recommend — once per answer, and say where you took them. Never as a substitute for an answer.",
  inputSchema: z.object({
    target: z.enum(APP_TARGETS),
    bookId: z.string().uuid().optional().describe("Every target but library and folder"),
    folderId: z.string().uuid().optional().describe("For folder"),
    chapterId: z.string().uuid().optional().describe("For chapter"),
    chapterIndex: z.number().int().min(0).optional().describe("For reader: which chapter, 0-based"),
    atMs: z.number().min(0).optional().describe("For reader: the moment of the narration to start at"),
  }),
  execute: async (input) => ({ shown: input, url: appUrlFor(input) }),
});

// Ask AI as a tool: the whole text of a book, or of chosen chapters, goes to the model with one
// prompt and the answer is kept as a note on the book — the same pipeline as the Ask AI dialog,
// run by the assistant's own model. Not the search: this reads everything and cites nothing.
function analyzeText(llm: { model: LanguageModel; def: LlmModelDef }) {
  return tool({
    description:
      "Read a book's whole text, or chosen chapters, and answer one prompt over all of it — a summary, a list of themes, questions to think about, a 'did you know' — where a search would miss the shape of the whole. " +
      "The answer is saved as a note on the book and shown to the person; do not repeat it, introduce it in a line. Costs the whole text in tokens, so it is confirmed first. Use bookId for the whole book (its raw text), chapterIds for parts.",
    inputSchema: z.object({
      prompt: z.string().trim().min(1).max(4000).describe("What to do with the text, as the person would ask it"),
      bookId: z.string().uuid().optional().describe("The whole book's text"),
      chapterIds: z.array(z.string().uuid()).min(1).max(500).optional().describe("Only these chapters' text"),
    }),
    execute: async ({ prompt, bookId, chapterIds }, { abortSignal }) => {
      const scope = chapterIds ? { kind: "chapters" as const, chapterIds } : bookId ? { kind: "book-raw" as const, bookId } : null;
      if (!scope) throw new Error("Name a bookId or chapterIds");
      const context = await buildAskContext(scope);
      const tokens = estimateTokens(context.corpus) + estimateTokens(prompt);
      if (contextExceeded(llm.def, tokens)) throw new Error(`The text (~${Math.round(tokens / 1000)}k tokens) does not fit ${llm.def.label} — ask about fewer chapters, or pick a model with more room`);
      const { text } = await generateText({
        model: llm.model,
        system: context.system,
        prompt: `${prompt}\n\n---\n${context.corpus}`,
        ...(llm.def.supportsTemperature ? { temperature: 0.7 } : {}),
        // Stop on the thread ends this read too, not only the ten-minute ceiling
        abortSignal: abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000),
      });
      if (!text.trim()) throw new Error("The model answered with nothing");
      const noteId = await saveNote({ bookId: context.bookId, prompt, model: llm.def.key, result: text, scope: context.noteScope });
      return { noteId, bookId: context.bookId, answer: text, wordsRead: context.corpus.split(/\s+/).length };
    },
  });
}

// The MCP tools over an in-memory transport, one server and client per request, plus the panel's
// own: show_in_app, analyze_text (with the model the answer runs on), and the library chat's
// search — its search_library replaces the MCP one, because it registers every passage in the
// catalog the answer's citations are verified against, and read_passage comes with it. `search`
// is the scope — the book on screen when there is one, else the profile.
export async function assistantTools(profileId: string, search?: { scope: ChatSearchScope; catalog: CitationCatalog; llm: { model: LanguageModel; def: LlmModelDef } }): Promise<AssistantToolSet> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(profileId);
  await server.connect(serverTransport);
  let client: MCPClient;
  try {
    client = await createMCPClient({ transport: clientTransport });
  } catch (err) {
    await server.close().catch(() => {});
    throw err;
  }
  const close = async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  };
  try {
    const all = await client.tools();
    const run = async (name: AssistantToolName, input: Record<string, unknown>) => {
      const execute = all[name]?.execute;
      if (!execute) throw new Error(`No tool ${name}`);
      return unwrap(await execute(input as never, { toolCallId: `run-${Date.now()}`, messages: [], context: undefined }));
    };
    const tools: ToolSet = { show_in_app: showInApp };
    for (const [name, mcpTool] of Object.entries(all)) {
      if (!isAssistantTool(name)) throw new Error(`MCP tool "${name}" has no assistant tier`);
      const execute = mcpTool.execute;
      if (!execute) continue;
      tools[name] = { ...mcpTool, execute: async (args, options) => unwrap(await execute(args, options)) };
    }
    if (search) {
      const chat = buildChatTools({ ...search.scope, catalog: search.catalog });
      if (chat.search_library) tools.search_library = chat.search_library;
      if (chat.read_passage) tools.read_passage = chat.read_passage;
      tools.analyze_text = analyzeText(search.llm);
    }
    return { tools, run, close };
  } catch (err) {
    await close();
    throw err;
  }
}
