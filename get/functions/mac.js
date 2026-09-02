// get.libratory.dev/mac  →  the newest signed DMG, counted on the way past.
//
// The asset name carries no version (artifactName in packages/desktop/package.json) and ship.mjs
// marks the newest tag --latest, so this URL never needs updating.
const DMG = "https://github.com/subev/libratory/releases/latest/download/Libratory-arm64.dmg";

export function onRequestGet({ request, env }) {
  const h = request.headers;

  // Pages answers HEAD out of this same handler, and link unfurlers and scanners send HEAD far more
  // than people click. Counting those would drown the real number at the volumes this sees.
  if (request.method === "GET") {
    env.DOWNLOADS?.writeDataPoint({
      blobs: [
        request.cf?.country ?? "??",
        new URL(request.url).searchParams.get("from") ?? h.get("referer") ?? "",
        h.get("user-agent") ?? "",
      ],
      indexes: ["mac"],
    });
  }

  // no-store, or an edge cache answers the next click and the count silently stops moving.
  return new Response(null, {
    status: 302,
    headers: { Location: DMG, "Cache-Control": "no-store" },
  });
}
