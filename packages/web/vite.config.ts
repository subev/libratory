import { createRequire } from "node:module";
import { createReadStream } from "node:fs";
import { cp, stat } from "node:fs/promises";
import path from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";

const PDFJS_ASSET_DIRS = ["wasm", "cmaps", "standard_fonts", "iccs"];
const CONTENT_TYPES: Record<string, string> = {
  ".wasm": "application/wasm",
  ".js": "text/javascript",
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".icc": "application/vnd.iccprofile",
};

// pdf.js fetches these at runtime, not through the bundler — without them a scanned page is blank
function pdfjsAssets(): Plugin {
  const root = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

  return {
    name: "pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs", (request, response, next) => {
        const relative = decodeURIComponent((request.url ?? "").split("?")[0]).replace(/^\/+/, "");
        const file = path.join(root, relative);
        if (!PDFJS_ASSET_DIRS.some((dir) => file.startsWith(path.join(root, dir)))) return next();

        stat(file)
          .then((entry) => {
            if (!entry.isFile()) return next();
            response.setHeader("content-type", CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream");
            createReadStream(file).pipe(response);
          })
          .catch(next);
      });
    },
    async writeBundle(options) {
      const out = options.dir ?? "dist";
      for (const dir of PDFJS_ASSET_DIRS) {
        await cp(path.join(root, dir), path.join(out, "pdfjs", dir), { recursive: true });
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  // vite runs from packages/web; the ports live in the repo-root .env the server also reads.
  const rootEnv = loadEnv(mode, path.resolve(import.meta.dirname, "../.."), "");
  // Not "localhost": the API binds 127.0.0.1 only, so a localhost target can resolve to ::1 —
  // where a stray vite may be listening — and proxy this server into itself.
  const API = `http://127.0.0.1:${rootEnv.PORT ?? 3034}`;

  return {
    plugins: [tailwindcss(), pdfjsAssets()],
    server: {
      port: Number(rootEnv.WEB_PORT ?? 3033),
      strictPort: true, // sliding onto the next free port lands on the API's
      proxy: {
        "/trpc": API,
        // /chat is both the SPA page (GET, browser refresh) and the streaming API (POST)
        "/chat": {
          target: API,
          bypass: (req) => (req.method === "POST" ? undefined : "/index.html"),
        },
        "/translations": API,
        "/scripts": API,
        "/pdf": API,
        "/upload": API,
        "/download": API,
        "/audio": API,
        "/files": API,
        "/preview": API,
        "/read": API,
      },
    },
  };
});
