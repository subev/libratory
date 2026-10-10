# Commons: a public shelf of narrated public-domain books

Reserved, not started. The phone shelf (Phone page, `/shelf/*`, `devices`) shipped first; this is
the public half of the same idea, parked until the private one has been used for a while.

Design: claude.ai/design project "Libratory Reader mobile app", file `Libratory Server.dc.html`,
Turn 1 panels 1a, 1c, 1d, 1e and 1g (1b and 1f were replaced by the pairing flow in Turn 2).

## The idea

- A **server** is a folder of finished read-along EPUBs behind an address, served by this very
  program. **Commons** is one instance of it with a public address and no sign-in, built into the
  reader app so nobody types an address to get a first book.
- The phone lists what a server holds, filters by *the language I read* and *the one I am
  learning* (two capsules under the search field, remembered per phone), and downloads an
  **edition** (German narrated / German and English sentence by sentence / text only) into the
  Library exactly like an import. Size and running time sit on the row.
- A book page names the text source, the voices and the rights ("About this copy") — what makes a
  free catalogue trustworthy.
- The server's own **web page**: the same warm paper and the same filters as the app, a card with
  the address and a QR code, and the catalogue also published as **OPDS** for readers that browse
  one.
- Reading state stays on the phone; the server only counts downloads. A newer narration of a book
  you have is offered on the book row; bookmarks survive the swap through their `text`.

## How it meets what exists

- `/shelf/*` is already the read-only surface. Commons is the same routes in a public mode:
  pairing off, the device-key check skipped, one fixed profile, filters by language.
- The OPDS feed is a second rendering of the same list.
- An invite link for a shelf opened to a friend outside the network is the one case between a
  paired phone and a public server; from the Phone page, later.

## Decided for now

- Browsing lives under the Library's *Add a book* menu as *Get from a server*, not as a tab. A tab
  promises a store; this is a shelf.
- Contributions to Commons are not in v1: someone runs their own server and it is listed on the
  About page.
- Syncing reading state through your own server is the reason to own one, and the next step after
  this.

## Hosting notes (2026-10-10)

- First home: a Docker install on the strandzhapesni.com box (`~/repos/strandhzapee3`), just for a
  public shelf of famous books. That box is small (3.7 GB, a live site beside it), so synthesis
  probably does not happen there.
- Which means **importing books that are already synthesized** is the missing piece: a bundle of
  one book's rows plus its `uploads/` and `output/` files, exported from the laptop and imported on
  the server (chapters, documents, sync maps, the searchable copy; ids remapped). Build this before
  the public shelf, not after.
- `NETWORK_ACCESS=shelf` in Docker exposes only `/shelf/*` to the world — but inside a container
  every request is non-loopback, so the admin UI then needs its own way in: a trusted admin network
  (a `TRUSTED_ADMIN_CIDR`, the tailnet) or a second published port. Decide when the box is set up;
  until then the UI stays behind the proxy's login with `all`.
- The public mode (pairing off, no device key) is a fourth value of the same setting, not a new
  listener.
