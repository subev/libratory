# A command-line client over the MCP tools

Scripts and agents drive a CLI more easily than a web page, and an agent without MCP support can
still run a shell command. Libratory already has the surface a CLI needs: the MCP tools in
`lib/mcp-server.ts`, which `/mcp` serves to outside agents and the assistant panel runs in-process.
A CLI is a third client of those tools, not a fourth place where behaviour lives.

```
web UI ──tRPC──▶ router + lib  (behaviour, validation)
                     ▲
          createMcpServer  (agent shaping: summaries, waits, names, refusals naming the fixing tool)
            ▲         ▲            ▲
      /mcp (agents)  assistant   CLI  (an MCP client over HTTP)
                    (in-memory)
```

## Decisions

- **Over HTTP, never in-process.** The workers and several in-memory registries live in the server
  process: `lib/extract-registry.ts` (cancel kills marker through it), the chat run registry,
  `lib/translate-live.ts`. A CLI that imported the lib and opened its own database connection would
  see the rows but cancel nothing and stream nothing.
- **Through MCP, not tRPC.** tRPC is the web UI's contract and changes with it. The agent-facing
  parts — summaries instead of every chapter, `wait_for_book`, profiles and folders by name,
  `dryRun` estimates, warnings about recordings without word times, refusals that name the tool
  that fixes them — exist only in the MCP layer.
- **Commands are generated from `tools/list`.** `libratory <tool> --flag value` maps flags onto the
  tool's JSON Schema; `--json '{…}'` passes an input as is. A new tool is a new command with no CLI
  change. Output is the tool's JSON (`--pretty` to indent); a tool error exits non-zero with its
  message on stderr.
- **No approval step.** The assistant's tiers (`lib/assistant-tiers.ts`) decide which calls wait for
  a yes in the panel. On the CLI the person typing is the one who would say yes, as on `/mcp`.

## What the CLI adds on its own side

- `libratory tools` lists the tools with their descriptions; `libratory <tool> --help` prints one
  tool's parameters from its schema.
- `libratory wait <id> --until <stage> [--language …] [--timeout 30m]` calls `wait_for_book` in a
  loop. The 50 s default exists for MCP clients that time out a call at 60 s; a CLI has no such limit.
- `--save <dir>` on `export_book` and `assemble_book`: wait for the output, then fetch its
  `downloadUrl` (absolute since 2026-09-30) into the directory under the name from
  `Content-Disposition` (dogfood finding 18).
- Local files for a server that cannot see them (the Docker install, a remote Mac):
  `upload_book` / `inspect_pdf` paths are first sent to `POST /upload/staged` and replaced by the
  `staged:<id>` the server answers with. On the same machine the path is passed as is.
- `--profile <name>` fills each tool's `profile` argument, and `x-profile-id` when set by id;
  `LIBRATORY_URL` (default `http://127.0.0.1:3034`) says where the server is. `isTrustedHost` in
  `mcp-routes.ts` already admits loopback and IP literals, so nothing server-side changes.

## Open questions

- **Shipping.** Either a subcommand of the compiled server binary (the desktop app already carries
  it, and `BUN_BE_BUN=1` shows the binary can be re-entered as a different program), linked onto the
  PATH by the Homebrew cask's `binary` stanza, or a separate small script in `packages/cli`. The
  first costs nothing to install; the second is easier to run from a checkout.
- **Human-friendly aliases.** Generated commands are snake_case agent verbs (`get_book`,
  `wait_for_book`). That fits scripts and agents; a few aliases (`libratory book <id>`) can come
  later if the CLI gets used by hand.
- **`/api/books`.** `libratory create_book` does what the JSON API does. Freeze the API — keep it
  for `scripts/hn-top10.mjs` and anyone who wired it up — and add nothing to it.

## Before it, on the server

1. Keep behaviour out of the MCP layer: the router and `lib/` decide, `mcp-server.ts` only shapes,
   resolves names, waits and rewords. Current exceptions: `extract_book` writes `skipSynthesis`
   itself, `translate_book` carries its own skip logic, and `export_book` repeats the router's
   untranslated/unpaired checks to word them for an agent — a structured error from the router
   (the chapter rows as data) would let the MCP layer reword without re-checking.
2. Split `lib/mcp-server.ts` (1,300+ lines): the book as an agent sees it (`loadBook`,
   `compactBook`, `summarizeBook`, `queuedWork`, `stageReached`) into its own module, the tool
   registrations staying where they are.
3. Not yet: a transport-neutral tool table that the MCP server, the assistant and the CLI each
   read. The assistant's in-memory MCP hop (`lib/assistant-tools.ts`) works and is tested; revisit
   only if a fourth in-process consumer appears.

Size: about 200 lines of client, no server change for the first version. The MCP client SDK is
already a dependency.
