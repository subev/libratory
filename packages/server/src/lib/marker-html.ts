import { parseHTML } from "linkedom";

const { document } = parseHTML("<html><body></body></html>");

// This produces plain reading text, not sanitized HTML. Using an inert DOM fragment decodes
// entities once and handles quoted '>' characters, comments, and malformed markup correctly.
export function stripHtml(html: string): string {
  const fragment = document.createElement("div");
  fragment.innerHTML = html;
  return (fragment.textContent ?? "").replaceAll("\u00a0", " ").trim();
}
