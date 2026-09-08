import { describe, expect, it } from "vitest";
import { stripHtml } from "./marker-html.ts";

describe("Marker reading text", () => {
  it("decodes entities exactly once", () => {
    expect(stripHtml("<p>&amp;lt; &lt; &#39; &nbsp; &#x41;</p>")).toBe("&lt; < '   A");
  });
  it("parses markup and comments without leaking attributes into prose", () => {
    expect(stripHtml('<p title="a > b">Hello <em>reader</em><!-- hidden --></p>')).toBe("Hello reader");
  });
  it("preserves encoded markup as literal reading text", () => {
    expect(stripHtml("<p>Write &lt;script&gt; as text.</p>")).toBe("Write <script> as text.");
  });
});
