# The phone shelf

A profile's finished read-along and bilingual EPUBs, reachable by a paired device over the local
network or a tailnet. The shelf is derived, never curated: every `epub-sync` and `epub-bilingual`
row in `documents` for the profile is on it unless hidden, so there is no second place to publish
to. The server never learns what was read — it counts downloads and nothing else.

Two people on one machine pair to two shelves: a shelf is a profile, and the Phone page mints the
code for the profile it is on.

## Pairing

1. The owner opens **Phone** in the library header. The page mints a pairing token for the current
   profile: ten minutes, one use, bound to that profile (`lib/pairing.ts`, in memory).
2. The QR encodes a link:

   ```
   <PAIR_LINK_BASE>#s=<server origin>&t=<token>
   ```

   `PAIR_LINK_BASE` defaults to `https://libratory.dev/pair`. `s` is where the server can be
   reached: `PUBLIC_ORIGIN` when one is configured (a server behind a proxy, `https://…`), else a
   Tailscale MagicDNS name when the CLI reports one, else the tailnet address, else the first LAN
   address with the port over plain `http` (`lib/shelf-address.ts`, `lib/reachable-address.ts`).
   `t` is the token. Both ride in the fragment so the site the link names never sees the token.
3. The reader scans the code. It may **peek** at the shelf before adding it, then **pair**, which
   spends the token and answers with a device key. The key is shown once; only its SHA-256 is kept
   (`devices.key_hash`).
4. From then on the reader sends the key as a bearer token on every `/shelf` call.

A code photographed off a screen is worth nothing a moment later: the token dies on first use and
at ten minutes regardless, and a server restart forgets every unused one (the page mints a fresh
code on every load and replaces one that has expired).

## Endpoints

Every answer is JSON unless it is a file. No cookie is read anywhere under `/shelf`: the device key
is the whole credential, so a page in a browser cannot ride a session into it, and the destructive
tRPC API stays exactly as unexposed as before.

| Method and path | Auth | Answer |
| --- | --- | --- |
| `GET /shelf/pair/:token` | none | `200 { machine, profile:{id,name}, bookCount, via:"tailscale"\|"lan", expiresAt }`. `404` unknown, `410` spent or expired. Does **not** spend the token. |
| `POST /shelf/pair` body `{ token, name }` | none | `200 { deviceId, deviceKey, machine, profile:{id,name}, bookCount }`. Spends the token. `400` without a name, `404` unknown, `410` gone. `name` is what the device is called on the owner's page. |
| `GET /shelf` | `Authorization: Bearer <deviceKey>`, or nothing on a public shelf | `200 { machine, profile:{id,name}, public, device:{id,name}\|null, books:[…] }` — see below. |
| `GET /shelf/documents/:documentId` | bearer | The EPUB (`application/epub+zip`, `Content-Disposition: attachment`). Records the download for the owner's "on phones" column, once per device and file. `404` for a file that is hidden, not a shelf format, or another profile's. |

`machine` is the server's hostname, or the public host when `PUBLIC_ORIGIN` is set — what groups
shelves on the reader side, since two profiles on one machine share an address. `via` is
`tailscale`, `lan` or `internet`; a reader should treat an unknown value as "other". `/shelf/pair*` is rate-limited per IP (`PAIR_RATE_LIMIT`).

A `401` means the shelf does not know this key: it was never issued, or the owner pressed
**Forget**. The reader should say so and offer to remove the shelf; what it already downloaded is
its own.

Every authenticated call updates `devices.last_seen_at`.

### The listing

```json
{
  "machine": "mini",
  "profile": { "id": "…", "name": "Petur" },
  "device": { "id": "…", "name": "Petur's iPhone" },
  "books": [
    {
      "id": "…", "title": "Der Prozess", "author": "Kafka", "language": "German",
      "source": "Project Gutenberg", "rights": "Public domain",
      "description": "A young scientist builds a creature and abandons it; the creature learns what that costs.",
      "editions": [
        { "documentId": "…", "format": "epub-bilingual", "language": "English",
          "label": "German and English", "chapterCount": 10, "bytes": 168820736,
          "createdAt": "2026-10-10T09:12:00.000Z", "downloaded": true,
          "narrated": true, "durationMs": 18120000, "voice": "Thorsten, Amy",
          "level": "word", "levels": { "source": "word", "target": "sentence" } },
        { "documentId": "…", "format": "epub-sync", "language": null,
          "label": "German, read-along", "chapterCount": 10, "bytes": 77594624,
          "createdAt": "2026-10-10T09:05:00.000Z", "downloaded": false,
          "narrated": true, "durationMs": 8400000, "voice": "Thorsten",
          "level": "word", "levels": { "source": "word", "target": null } }
      ]
    }
  ]
}
```

A book's `source` and `rights` are what the owner typed under Book details ("Project Gutenberg",
"Public domain"), null when empty, so a reader leaves the line out rather than invent it.
`description` is the same kind of field — plain text, a sentence to a paragraph — filled from an
EPUB's own `dc:description` on import and carried in a read-along export's layer, so a book brought
to a public shelf keeps it. A
book's `language` is a name in English from the book's language code (`Intl.DisplayNames`); an
edition's `language` is the translation's name as the variant key stores it, `null` for the
original. `label` is the line a row shows: the language first, because that is what a reader picks
by. `bytes` is `null` when the file is missing on disk. `downloaded` is whether *this* device has
fetched the file. Newest first within a book.

The narration fields come from the export (`documents.narration`, `lib/document-narration.ts`),
never from opening the file: `narrated` is false for a bilingual export written with neither
recording; `durationMs` is the running time across both lanes; `voice` names the voices across
both lanes; `level` is the finest cue level a reader gets, `word` (every chapter timed by word),
`sentence` (some) or `chunk` (none, a whole synthesis chunk lights); `levels` gives it per lane,
`source` for the original text's narration and `target` for the translation's. Exports written
before these were recorded are filled in once at the next server start from their sync maps; the
fields are null until then.

There is no cover endpoint yet: a book's only artwork is drawn into its M4B and deleted after, so a
reader draws a title tile.

## The owner's side

`routes/phone.ts` (tRPC `phone`) backs `pages/PhonePage.tsx`:

- `pairingCode` — mints a code and renders the QR (SVG data URL, quiet zone included). Answers
  with `code: null` and says why when the server binds loopback (`loopbackOnly`), the machine has
  no network address (`reachable: null`), or the network may reach nothing (`access: "none"`).
- `listenOnNetwork` — writes `HOST=0.0.0.0` to `.env`; the server binds at boot, so a restart
  applies it. Binding alone exposes nothing, because of the next one.
- `setNetworkAccess` — `none` | `shelf` | `all`, written to `.env` and applied live. The page's
  **Share this shelf on the network** sets `shelf`, **Stop sharing** sets `none`.
- `devices` / `forget` — the profile's paired devices with how many books each fetched; forgetting
  deletes the row, so the key stops working at the next call.
- `shelf` / `setHidden` — the profile's shelf files including hidden ones, with who fetched each;
  hiding sets `documents.shelf_hidden` and touches nothing on disk.

Deleting a profile cascades its devices; deleting a book cascades its documents and their download
records.

## Reaching the server

- **Two settings, not one.** `HOST` says which addresses the server listens on; `NETWORK_ACCESS`
  says what an address other than this machine may then reach: `none` (the default outside
  Docker), `shelf` (the four routes above and nothing else) or `all` (for a server behind a login
  of its own, the Docker default). The guard (`lib/network-access.ts`) runs before every plugin,
  decides on the *matched route* rather than the URL as typed — `/shelf/../trpc` matches no shelf
  route and is refused — and reads the socket address, never a forwarded header. A refused request
  gets a 403 with nothing else. The Phone page refuses to mint a code until a phone could use it:
  HOST on the network *and* access at least `shelf`.
- **A proxy on the same machine blinds the guard.** A reverse proxy, `tailscale serve` or an SSH
  tunnel that forwards to `127.0.0.1` makes every caller look like loopback, which gets everything.
  Behind one of those, the proxy's login is the protection, and `all` is the honest setting.
- **Plain http.** The shelf is served over whatever the network gives. A tailnet is already
  encrypted end to end; on bare Wi-Fi the device key is the only secret in the air, and it is
  bound to one profile's read-only list. iOS allows plain http to a LAN address by default but
  **not to a `.ts.net` name** — a reader built for it needs an App Transport Security exception for
  that, or the server needs `https` on the Tailscale name (`tailscale cert` issues one), which is
  not wired up here yet.
- **The universal link.** For a camera scan to open the reader directly, the site at
  `PAIR_LINK_BASE` has to serve an `apple-app-site-association` naming it, and the reader has to
  claim the domain. Until then the link opens in a browser, and a reader can scan the same QR with
  its own in-app camera, which needs no link at all. A custom scheme is one `PAIR_LINK_BASE` away.
- **Nothing to the internet.** The page prints the address a device on the same network or
  tailnet can reach; it opens no port and creates no account.

## The public case

The home case pairs each phone to a shelf. A server for everyone needs no pairing: the owner
presses **Make it public** on the Phone page (`phone.setPublic`, which writes
`PUBLIC_SHELF_PROFILE` to `.env` and applies it live), and from then on that one profile's shelf
answers `GET /shelf` and `GET /shelf/documents/:id` with **no credential at all**, with
`public: true` and `device: null` in the listing. A reader with a built-in entry for the address
lists it on every install. The pairing routes keep working, so a device key still answers for its
own profile on the same server, and any `Authorization` header that is not a device key this
server issued is still a 401 — only a request that offers nothing is the public. Both routes are
rate-limited per address (`SHELF_RATE_LIMIT`). The public shelf needs the network to reach the
server like any other: `NETWORK_ACCESS` at least `shelf`, or the proxy in front.

What a public download leaves behind is analytics, not tracking (`shelf_fetches`), counted once
when the file is asked for from its start — a resumed range or a HEAD is the same download — the
document, the moment, the reader's `User-Agent` — `Libratory-Reader/<version> (iOS <os>; <model>)` — and a
two-letter country only when the proxy supplies `CF-IPCountry`. No address, no install id, no
cookie. The owner's page shows the count per file beside the paired phones that fetched it.

Only a profile meant for the world should be made public: everything on its shelf is then one
URL away for anyone, and hiding a file is the only way back short of making it private again.

## Books that were made elsewhere

The synced EPUB is the exchange format as well as the download: dropped on `/upload/ebook` (the
upload dialog accepts it like any EPUB), a file that carries `p2af/book.json` comes back as a
**finished** book rather than text chapters (`lib/synced-epub-books.ts`, pure parts in
`lib/synced-epub.ts`). Each narrated chapter's audio is taken out of the archive straight onto
disk as `chNNN.m4a`, its sync map rebuilt from the cue document, its text from the cues, and the
EPUB itself moved under the book's outputs as the shelf document — so a server that never
synthesizes still serves a shelf, and the workshop's reader and player work on the imported book.
A chapter the export left unnarrated arrives suspended with whatever text the layer carried. The
voices are not recorded in the layer, so the imported document's `voice` is null. A bilingual
export is recognised by its chapters' translation entries and listed as `epub-bilingual`; only the
original lane's narration is restored into chapters, the file itself is served whole.

## Deploying behind a proxy

The README's Docker section has the Caddy block: `/shelf/*` open, everything else behind
`basic_auth`, `PUBLIC_ORIGIN` naming the public https origin and `TRUSTED_HOSTS` its host. Over
https there is no ATS exception to make and the universal link is the natural way in. Pairing is
unchanged: the owner opens the Phone page through the proxy's login, the QR carries the public
origin, the phone scans it.

## Not in this round

Reading-state sync through the owner's server, invites for someone outside the network, and the
public catalogue (`tasks/commons-bookstore.md`).
