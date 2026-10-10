import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { trpc } from "../trpc.ts";
import { Breadcrumbs } from "../components/Breadcrumbs.tsx";
import { Button } from "../components/Button.tsx";
import { LibraryHeader } from "../components/library/LibraryHeader.tsx";
import { Menu, MenuItem } from "../components/Menu.tsx";
import { IconBook, IconHide, IconMore, IconShow } from "../components/icons.tsx";
import { formatBytes, formatOutputDate, formatRelativeTime } from "../lib/format.ts";

// The workshop's Phone page: the QR that adds this profile's shelf to a phone, the phones already on
// it, and the shelf they see. The shelf is derived from the profile's finished read-along and
// bilingual EPUBs — there is no second place to publish to, and hiding is the only edit.

function mmss(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

type MintedCode = { link: string; image: string; expiresInMs: number };

// Keyed by its link, so a new code mounts a new countdown. The deadline is this clock plus the
// server's TTL, taken once on mount, so a browser clock far from the server's never sees a fresh
// code as dead and mints forever.
function PairingCode({ code, host, port, onExpired }: { code: MintedCode; host: string; port: string; onExpired: () => void }) {
  const [deadline] = useState(() => Date.now() + code.expiresInMs);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = Math.max(0, deadline - now);
  const expired = remaining === 0;
  // The dead code is replaced the moment it dies, so the page never shows one that cannot work
  useEffect(() => {
    if (expired) onExpired();
  }, [expired, onExpired]);
  return (
    <>
      <div className="flex justify-center p-3 rounded-md border border-(--border) bg-(--bg-subtle)">
        <img src={code.image} alt="Pairing code" width={168} height={168} className={expired ? "opacity-30" : ""} data-testid="pairing-qr" />
      </div>
      <div className="flex flex-col gap-1.5 text-xs text-(--text-muted)">
        <div className="flex justify-between gap-3">
          <span>Expires</span>
          <span className="tabular-nums text-(--text-secondary)">{expired ? "now — new code coming" : `in ${mmss(remaining)}, then a new code`}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span>Reaches this machine at</span>
          <span className="font-mono text-(--text-secondary)">
            {host}:{port}
          </span>
        </div>
        {/* The same link as text, for a reader with no camera — the simulator pastes it */}
        <div className="flex items-center gap-2">
          <code className="flex-1 min-w-0 truncate font-mono text-[11px] text-(--text-secondary) select-all" title={code.link} data-testid="pairing-link">
            {code.link}
          </code>
          <Button size="sm" onClick={() => navigator.clipboard.writeText(code.link).catch(() => {})} title="Copy the link, to paste into a reader with no camera">
            Copy link
          </Button>
        </div>
      </div>
    </>
  );
}

function PairingCard() {
  const utils = trpc.useUtils();
  // A fresh code is minted on every read, so the query is never refetched behind the person's back
  const code = trpc.phone.pairingCode.useQuery(undefined, { staleTime: Infinity, refetchOnWindowFocus: false });
  const listen = trpc.phone.listenOnNetwork.useMutation();
  const setAccess = trpc.phone.setNetworkAccess.useMutation({ onSuccess: () => utils.phone.pairingCode.invalidate() });
  const setPublic = trpc.phone.setPublic.useMutation({ onSuccess: () => utils.phone.pairingCode.invalidate() });
  const refresh = useCallback(() => void utils.phone.pairingCode.invalidate(), [utils]);

  const data = code.data;
  const busy = setAccess.isPending;
  return (
    <div className="border border-(--border) rounded-lg bg-(--bg-card) p-4 flex flex-col gap-4" data-testid="pairing-card">
      <div>
        <div className="text-base font-semibold tracking-tight text-(--text-primary)">
          {data ? `Add ${data.profileName}'s shelf to a phone` : "Add this shelf to a phone"}
        </div>
        <p className="mt-1 text-sm text-(--text-secondary) text-pretty">
          Open the Camera on the phone and point it here. The code is a link that works once, for this profile only.
        </p>
      </div>

      {data?.loopbackOnly ? (
        <div className="flex flex-col gap-2 px-3 py-2 rounded-md bg-(--warning-bg) text-sm text-(--warning-text)" data-testid="loopback-notice">
          <span>
            This server listens on this machine only, so no phone can reach it. Listening on the network exposes
            nothing by itself: what the network may reach is chosen here, and starts as nothing.
          </span>
          {listen.data ? (
            <span className="font-medium">Done — restart Libratory to apply.</span>
          ) : (
            <Button variant="warning" size="sm" className="self-start" onClick={() => listen.mutate()} disabled={listen.isPending} data-testid="listen-on-network">
              Listen on the network
            </Button>
          )}
          {listen.error && <span className="text-(--danger-text)">{listen.error.message}</span>}
        </div>
      ) : data && !data.reachable ? (
        <p className="px-3 py-2 rounded-md bg-(--warning-bg) text-sm text-(--warning-text)">
          No network address was found on this machine. Join a Wi-Fi network or start Tailscale, then reload.
        </p>
      ) : data?.access === "none" ? (
        <div className="flex flex-col gap-2 px-3 py-2 rounded-md bg-(--bg-subtle) text-sm text-(--text-secondary)" data-testid="not-shared-notice">
          <span>
            Not shared. The network can reach nothing on this server, so there is no code to scan
            {data.isPublic ? ", and the public shelf is marked but unreachable" : ""}.
          </span>
          <Button variant="primary" size="sm" className="self-start" onClick={() => setAccess.mutate({ access: "shelf" })} disabled={busy} data-testid="share-shelf">
            Share this shelf on the network
          </Button>
        </div>
      ) : data?.isPublic ? (
        <div className="flex flex-col gap-2 px-3 py-2 rounded-md bg-(--warning-bg) text-sm text-(--warning-text)" data-testid="public-notice">
          <span>
            This shelf is public: every reader that knows this server's address lists it and downloads from it, with
            nothing to pair. Hide a file from the shelf to keep it to yourself.
          </span>
          <Button variant="warning" size="sm" className="self-start" onClick={() => { if (confirm("Make this shelf private again? Readers that list it will see nothing until they pair.")) setPublic.mutate({ public: false }); }} disabled={setPublic.isPending} data-testid="make-private">
            Make it private
          </Button>
        </div>
      ) : data?.code && data.reachable ? (
        <>
          <PairingCode key={data.code.link} code={data.code} host={data.reachable.host} port={new URL(data.reachable.origin).port} onExpired={refresh} />
          {data.access === "all" ? (
            <div className="flex flex-col gap-2 px-3 py-2 rounded-md bg-(--warning-bg) text-sm text-(--warning-text)" data-testid="all-access-notice">
              <span>
                Everything on this server is reachable from the network, not only the shelf. That is meant for a server
                behind a login of its own, not for a laptop on someone else's Wi-Fi.
              </span>
              <Button variant="warning" size="sm" className="self-start" onClick={() => setAccess.mutate({ access: "shelf" })} disabled={busy} data-testid="limit-to-shelf">
                Limit the network to the shelf
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3 text-xs text-(--text-muted)">
              <span>Shared: the network reaches the shelf and nothing else.</span>
              <Button size="sm" onClick={() => setAccess.mutate({ access: "none" })} disabled={busy} data-testid="stop-sharing">
                Stop sharing
              </Button>
            </div>
          )}
        </>
      ) : (
        <div className="h-48 rounded-md bg-(--bg-subtle)" />
      )}
      {setAccess.error && <span className="text-xs text-(--danger-text)">{setAccess.error.message}</span>}
      {setPublic.error && <span className="text-xs text-(--danger-text)">{setPublic.error.message}</span>}
      {data && !data.isPublic && (
        <div className="flex items-center justify-between gap-3 text-xs text-(--text-muted)">
          <span>A server for everyone needs no pairing: a public shelf lists for any reader that knows its address.</span>
          <Button
            size="sm"
            onClick={() => { if (confirm("Make this shelf public? Anyone who knows this server's address can list and download every file on it, no pairing. Only do this on a server you meant to be public.")) setPublic.mutate({ public: true }); }}
            disabled={setPublic.isPending}
            data-testid="make-public"
          >
            Make it public
          </Button>
        </div>
      )}

      <p className="text-xs text-(--text-muted) text-pretty">
        The phone needs a way to reach this machine: the same Wi-Fi, or Tailscale on both. This page exposes nothing to
        the internet. Switch profile at the top to pair a phone to another shelf instead.
      </p>
    </div>
  );
}

function PhonesCard({ profileName }: { profileName: string | undefined }) {
  const utils = trpc.useUtils();
  const devices = trpc.phone.devices.useQuery(undefined, { refetchInterval: 5000 });
  const forget = trpc.phone.forget.useMutation({
    onSuccess: () => {
      utils.phone.devices.invalidate();
      utils.phone.shelf.invalidate();
    },
  });
  const rows = devices.data ?? [];
  return (
    <div className="border border-(--border) rounded-lg bg-(--bg-card) flex flex-col" data-testid="phones-card">
      <div className="flex items-baseline justify-between px-4 py-3 border-b border-(--border)">
        <span className="font-semibold text-(--text-primary)">{profileName ? `Phones on ${profileName}'s shelf` : "Phones on this shelf"}</span>
        <span className="text-xs text-(--text-muted)">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-xs text-(--text-muted)">No phone has scanned the code yet.</p>
      ) : (
        rows.map((d, i) => (
          <div key={d.id} className={`flex items-center gap-3 px-4 py-2.5 ${i < rows.length - 1 ? "border-b border-(--border)" : ""}`} data-testid="phone-row">
            <div className="flex-1 min-w-0">
              <div className="text-(--text-primary)">{d.name}</div>
              <div className="text-xs text-(--text-muted)">
                Paired {formatOutputDate(d.pairedAt)} · seen {formatRelativeTime(d.lastSeenAt)} · {d.books} {d.books === 1 ? "book" : "books"}
              </div>
            </div>
            <Button
              variant="danger"
              soft
              size="sm"
              title="The phone loses this shelf; what it already downloaded stays on it"
              disabled={forget.isPending}
              onClick={() => {
                if (confirm(`Forget ${d.name}? It will no longer see this shelf; the books it downloaded stay on it.`)) {
                  forget.mutate({ id: d.id });
                }
              }}
            >
              Forget
            </Button>
          </div>
        ))
      )}
    </div>
  );
}

function narrationVoices(narration: { original: { voice: string | null } | null; translation: { voice: string | null } | null } | null): string {
  const voices = [narration?.original?.voice, narration?.translation?.voice].filter(Boolean).join(", ");
  return voices ? `${voices} · ` : "";
}

const COLUMNS = "grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_72px_108px_32px]";

function ShelfTable({ profileName }: { profileName: string | undefined }) {
  const utils = trpc.useUtils();
  const shelf = trpc.phone.shelf.useQuery(undefined, { refetchInterval: 5000 });
  const navigate = useNavigate();
  const setHidden = trpc.phone.setHidden.useMutation({ onSuccess: () => utils.phone.shelf.invalidate() });
  const docs = shelf.data ?? [];
  const totalBytes = docs.reduce((sum, d) => sum + (d.bytes ?? 0), 0);
  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="text-base font-semibold tracking-tight text-(--text-primary)">{profileName ? `On ${profileName}'s shelf` : "On this shelf"}</div>
          <p className="mt-0.5 text-sm text-(--text-secondary) text-pretty">
            Every read-along and bilingual EPUB this profile has exported. A paired phone sees this list and nothing
            else: not the PDFs, not the other profiles, no way to change anything.
          </p>
        </div>
        <span className="text-xs text-(--text-muted) whitespace-nowrap">
          {docs.length} {docs.length === 1 ? "file" : "files"} · {formatBytes(totalBytes)}
        </span>
      </div>
      <div className="border border-(--border) rounded-lg bg-(--bg-card) overflow-hidden" data-testid="shelf-table">
        <div className={`grid ${COLUMNS} gap-3 px-4 py-2 border-b border-(--border) text-[11px] tracking-wide uppercase text-(--text-muted)`}>
          <span>Book</span>
          <span>Export</span>
          <span className="text-right">Size</span>
          <span>Downloads</span>
          <span />
        </div>
        {docs.length === 0 && (
          <p className="px-4 py-6 text-sm text-(--text-muted)">
            Nothing yet. Export a read-along or bilingual EPUB from a book's Outputs tab and it appears here the moment
            it finishes.
          </p>
        )}
        {docs.map((d, i) => (
          <div
            key={d.id}
            className={`grid ${COLUMNS} gap-3 items-center px-4 py-2.5 ${i < docs.length - 1 ? "border-b border-(--border)" : ""} ${d.hidden ? "opacity-60" : ""}`}
            data-testid="shelf-row"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="w-7 h-10 rounded-sm bg-(--bg-subtle) grid place-items-center text-(--text-muted) shrink-0">
                <IconBook className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="truncate text-(--text-primary)">{d.title}</div>
                <div className="text-xs text-(--text-muted) truncate">
                  {[d.author, `${d.chapterCount} ${d.chapterCount === 1 ? "chapter" : "chapters"}`].filter(Boolean).join(" · ")}
                </div>
              </div>
            </div>
            <div className="min-w-0">
              <div className="truncate text-(--text-primary)">{d.label}</div>
              <div className="text-xs text-(--text-muted) truncate">
                {narrationVoices(d.narration)}
                {formatOutputDate(d.createdAt)}
                {d.hidden ? " · hidden from phones" : ""}
              </div>
            </div>
            <span className="text-right tabular-nums text-(--text-secondary)">{d.bytes === null ? "—" : formatBytes(d.bytes)}</span>
            <span className="text-xs text-(--text-muted) truncate">
              {[...d.downloadedBy.map((p) => p.name), ...(d.fetches > 0 ? [`${d.fetches} public`] : [])].join(", ") || "—"}
            </span>
            <Menu
              testId="shelf-row-menu"
              trigger={({ toggle }) => (
                <Button variant="icon" size="sm" onClick={toggle} aria-label="Shelf row actions">
                  <IconMore className="h-4 w-4" />
                </Button>
              )}
            >
              {(close) => (
                <>
                  <MenuItem
                    icon={d.hidden ? <IconShow className="h-4 w-4" /> : <IconHide className="h-4 w-4" />}
                    onClick={() => {
                      setHidden.mutate({ documentId: d.id, hidden: !d.hidden });
                      close();
                    }}
                  >
                    {d.hidden ? "Show on phones" : "Hide from phones"}
                  </MenuItem>
                  <MenuItem icon={<IconBook className="h-4 w-4" />} onClick={() => { close(); navigate(`/books/${d.bookId}`); }}>
                    Open the book
                  </MenuItem>
                </>
              )}
            </Menu>
          </div>
        ))}
      </div>
      <p className="text-xs text-(--text-muted) text-pretty">
        Exports appear here the moment they finish; the menu hides one from phones without deleting the file. An export
        that is still being written is not listed until it is complete.
      </p>
    </div>
  );
}

export function PhonePage() {
  const { data } = trpc.phone.pairingCode.useQuery(undefined, { staleTime: Infinity, refetchOnWindowFocus: false });
  return (
    <div className="h-screen flex flex-col overflow-hidden bg-(--bg-page)">
      <div className="shrink-0">
        <LibraryHeader page="phone" />
      </div>
      <div className="shrink-0 flex items-center gap-2 h-11 px-4 border-b border-(--border) bg-(--bg-card)">
        <Breadcrumbs items={[{ to: "/", label: "Home" }, { label: "Phone" }]} />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div className="grid grid-cols-[360px_minmax(0,1fr)] gap-6 px-4 pt-6 pb-8 max-w-[1200px]">
          <div className="flex flex-col gap-4">
            <PairingCard />
            <PhonesCard profileName={data?.profileName} />
          </div>
          <ShelfTable profileName={data?.profileName} />
        </div>
      </div>
    </div>
  );
}
