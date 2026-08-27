// Reflecting any origin let any web page the user happened to have open drive this server from
// their browser — deleting books, spending credits, and since `secrets.set`, rewriting API keys on
// disk. Nothing legitimate needs it: the UI is same-origin in the app and proxied by Vite in
// development, and non-browser callers (the external /api scripts) send no Origin at all.

function isIpLiteral(hostname: string): boolean {
  // URL parsing brackets IPv6 and normalises IPv4, so these two shapes are the whole set.
  return hostname.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

export function isLocalOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
  } catch {
    return false;
  }
}

export function parseTrustedHosts(value: string): ReadonlySet<string> {
  return new Set(value.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
}

// A phone reading the library over HOST=0.0.0.0 sends an Origin naming this very server, and
// holding that against a localhost list rejected every POST a headless deployment exists to serve.
// Matching Host against Origin alone would hand the same welcome to DNS rebinding, though: a page
// on attacker.com rebound to 127.0.0.1 sends Host and Origin that agree. What it cannot send is an
// IP literal — to make a browser say "Host: attacker.com" the page must come from attacker.com, so
// a literal is a host the browser could only have reached by connecting to this machine directly.
// Names that legitimately front this server (a reverse proxy, an mDNS or tailnet name) are the
// case TRUSTED_HOSTS exists for.
export function isSameOrigin(origin: string, hostHeader: string | undefined, trustedHosts: ReadonlySet<string>): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase();
  try {
    const url = new URL(origin);
    if (url.host !== host) return false;
    return isIpLiteral(url.hostname) || trustedHosts.has(host);
  } catch {
    return false;
  }
}

export function isAllowedOrigin(origin: string | undefined, hostHeader: string | undefined, trustedHosts: ReadonlySet<string>): boolean {
  return origin === undefined || isLocalOrigin(origin) || isSameOrigin(origin, hostHeader, trustedHosts);
}
