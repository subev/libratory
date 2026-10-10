// Names what the browser saves from extensionless URLs (e.g. the <audio> player's own download
// menu, which ignores the <a download> attribute); the UTF-8 form carries titles the ASCII fallback
// cannot spell.
export function contentDisposition(type: "inline" | "attachment", filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  const utf8 = encodeURIComponent(filename).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${fallback}"; filename*=UTF-8''${utf8}`;
}
