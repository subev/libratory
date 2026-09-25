// What the assistant panel is told about the page beside it, and whether it belongs there at all.
// Pure, because the routes it hides on are a decision worth asserting: the reader and the OCR
// comparison are full-screen surfaces, /open is a hand-over, /components a gallery.
export type Screen = { route: string; bookId?: string };

const HIDDEN = [/^\/books\/[^/]+\/read$/, /^\/books\/[^/]+\/ocr$/, /^\/open$/, /^\/components$/];

export function panelShownOn(pathname: string): boolean {
  return !HIDDEN.some((pattern) => pattern.test(pathname));
}

export function screenOf(pathname: string): Screen {
  const book = /^\/books\/([^/]+)/.exec(pathname);
  return book?.[1] ? { route: pathname, bookId: book[1] } : { route: pathname };
}
