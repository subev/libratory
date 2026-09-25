import type { UIMessage } from "ai";
import type { ChatSource } from "../components/chat/SourceList.tsx";

export function messageText(message: UIMessage): string {
  return (message.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
}

export function messageSources(message: UIMessage): ChatSource[] {
  for (const part of [...(message.parts ?? [])].reverse()) {
    if (part.type === "data-sources" && Array.isArray((part as { data?: unknown }).data)) {
      return (part as { data: ChatSource[] }).data;
    }
  }
  return [];
}

// Rewrites verified [c_N] markers to reader-facing [n] numbering; unverified ids vanish
export function renderText(text: string, sources: ChatSource[]): string {
  const order = new Map(sources.map((s, i) => [s.id, i + 1]));
  return text.replace(/\s?\[(c_\d+)\]/g, (_, id: string) => (order.has(id) ? ` [${order.get(id)}]` : ""));
}
