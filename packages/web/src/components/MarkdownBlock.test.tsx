import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownBlock } from "./MarkdownBlock.tsx";

function render(markdown: string) {
  return parseHTML(renderToStaticMarkup(<MarkdownBlock>{markdown}</MarkdownBlock>)).document;
}

describe("MarkdownBlock tables", () => {
  it("renders the Bulgarian answer as a table with formatted cells and surrounding prose", () => {
    const document = render(`Правилникът позволява отсъствия [1]:

| Група | Допустими отсъствия |
|---|---|
| **Ясла и I група** | общо до **30 работни дни** в учебното време (15.09. на текущата година – 31.05. на следващата) |
| **II, III и IV група** (деца, подлежащи на задължителна предучилищна подготовка) | до **15 работни дни** с писмена молба, **но не повече от 10 дни последователно** |

### Как се заявява`);

    expect(Array.from(document.querySelectorAll("thead th"), (cell) => cell.textContent))
      .toEqual(["Група", "Допустими отсъствия"]);
    expect(document.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(document.querySelectorAll("tbody td")).toHaveLength(4);
    expect(document.querySelector("tbody td strong")?.textContent).toBe("Ясла и I група");
    expect(document.querySelector("p")?.textContent).toBe("Правилникът позволява отсъствия [1]:");
    expect(document.querySelector("h3")?.textContent).toBe("Как се заявява");
    expect(document.querySelector("table")?.textContent).not.toContain("|---|---|");
  });

  it("preserves column alignment, escaped pipes, links and inline code", () => {
    const document = render(String.raw`Left | Center | Right
:--- | :---: | ---:
a\|b | [Source](https://example.com) | ` + "`30`");

    expect(Array.from(document.querySelectorAll("thead th"), (cell) => cell.getAttribute("style")))
      .toEqual(["text-align:left", "text-align:center", "text-align:right"]);
    expect(document.querySelector("tbody td")?.textContent).toBe("a|b");
    expect(document.querySelector("td a")?.getAttribute("href")).toBe("https://example.com");
    expect(document.querySelector("td code")?.textContent).toBe("30");
  });

  it("gives tables a focusable scroll container for narrow reading panes", () => {
    const document = render("| Column |\n| --- |\n| Value |");
    const container = document.querySelector("table")?.parentElement;
    expect(container?.classList.contains("overflow-x-auto")).toBe(true);
    expect(container?.getAttribute("tabindex")).toBe("0");
    expect(container?.getAttribute("aria-label")).toBe("Table");
  });

  it("leaves pipe text and fenced table examples as text", () => {
    const document = render("A | B\n\n```text\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```");
    expect(document.querySelector("table")).toBeNull();
    expect(document.querySelector("p")?.textContent).toBe("A | B");
    expect(document.querySelector("pre code")?.textContent).toContain("| --- | --- |");
  });
});
