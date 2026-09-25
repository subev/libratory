// OpenAI-compatible stub for deterministic, offline AI-flow tests.
// Serves /v1/models + /v1/chat/completions (SSE and non-stream), and mimics
// LM Studio (/api/v0/models) and Ollama (/api/tags, /api/show, /api/ps)
// discovery shapes so the auto-discovery filters can be tested against fixtures.

import http from "node:http";

export const FAKE_MODEL_ID = "fake-model";
export const FAKE_REPLY = "This is the fake model speaking: all seams intact.";
// Scripted tool-calling round: when handed tools and no tool results yet, the stub
// searches the library; once results are in the transcript it answers citing [c_1]
const FAKE_SEARCH_QUERY = "voyage harbor dawn";
export const FAKE_CITED_REPLY = "The ship left the harbor at dawn [c_1].";

const SSE_HEADERS = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" };

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

function sseChunk(id, delta, finish = null) {
  const payload = {
    id,
    object: "chat.completion.chunk",
    model: FAKE_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : "";
}

function pinnedRead(messages) {
  const last = [...(messages ?? [])].reverse().find((m) => m.role === "user");
  const text = messageText(last);
  const book = /\(bookId ([0-9a-f-]{36})\)/.exec(text);
  if (!book) return null;
  const prompt = text.split("\n\nRead the whole text")[0]?.trim() || "Summarize";
  return { prompt, bookId: book[1] };
}

export function startFakeLlm(port = 3111) {
  let calls = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (url.pathname === "/v1/models") {
      return json(res, 200, { object: "list", data: [{ id: FAKE_MODEL_ID, object: "model" }] });
    }

    // LM Studio v0 shape — includes an embedding and a vlm entry so discovery
    // filter behavior (drop embeddings, keep vlm) is testable
    if (url.pathname === "/api/v0/models") {
      return json(res, 200, {
        data: [
          { id: FAKE_MODEL_ID, type: "llm", state: "loaded", max_context_length: 8192, loaded_context_length: 4096, capabilities: ["tool_use"] },
          { id: "fake-vision", type: "vlm", state: "not-loaded", max_context_length: 8192 },
          { id: "fake-embed", type: "embeddings", max_context_length: 512 },
        ],
      });
    }

    if (url.pathname === "/api/tags") {
      return json(res, 200, { models: [{ name: FAKE_MODEL_ID }] });
    }
    if (url.pathname === "/api/ps") {
      return json(res, 200, { models: [] });
    }
    if (url.pathname === "/api/show") {
      return json(res, 200, {
        capabilities: ["completion", "tools"],
        model_info: { "general.architecture": "llama", "llama.context_length": 8192 },
      });
    }

    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const body = await readBody(req);
      const id = `chatcmpl-fake-${++calls}`;

      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const hasToolResults = (body.messages ?? []).some((m) => m.role === "tool");
      // The assistant's Ask AI hand-off: a question ending "Read the whole text of … (bookId …)."
      // is answered by reading it whole, with the words before that line as the prompt
      const pinned = hasTools && !hasToolResults && body.tools.some((t) => t.function?.name === "analyze_text") ? pinnedRead(body.messages) : null;
      if (body.stream && pinned) {
        res.writeHead(200, SSE_HEADERS);
        res.write(sseChunk(id, { role: "assistant" }));
        res.write(sseChunk(id, {
          tool_calls: [{ index: 0, id: "call_fake_read", type: "function", function: { name: "analyze_text", arguments: JSON.stringify(pinned) } }],
        }));
        res.write(sseChunk(id, {}, "tool_calls"));
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      if (body.stream && hasTools && !hasToolResults) {
        res.writeHead(200, SSE_HEADERS);
        res.write(sseChunk(id, { role: "assistant" }));
        res.write(sseChunk(id, {
          tool_calls: [{
            index: 0,
            id: "call_fake_search",
            type: "function",
            function: { name: "search_library", arguments: JSON.stringify({ query: FAKE_SEARCH_QUERY }) },
          }],
        }));
        res.write(sseChunk(id, {}, "tool_calls"));
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      const reply = hasToolResults ? FAKE_CITED_REPLY : FAKE_REPLY;

      if (body.stream) {
        res.writeHead(200, SSE_HEADERS);
        res.write(sseChunk(id, { role: "assistant" }));
        for (const word of reply.split(" ")) {
          res.write(sseChunk(id, { content: word + " " }));
        }
        res.write(sseChunk(id, {}, "stop"));
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            model: FAKE_MODEL_ID,
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        return res.end();
      }

      return json(res, 200, {
        id,
        object: "chat.completion",
        model: FAKE_MODEL_ID,
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      });
    }

    json(res, 404, { error: `no fake route for ${req.method} ${url.pathname}` });
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
