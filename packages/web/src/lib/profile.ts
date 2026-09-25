const KEY = "profile.id";

export function getStoredProfileId(): string | null {
  return localStorage.getItem(KEY);
}

// Fired on this window whenever the profile changes, for what has to follow it while mounted —
// the assistant panel keeps a thread that belongs to one profile
const CHANGED = "profile-changed";

export function setStoredProfileId(id: string | null) {
  if (id) localStorage.setItem(KEY, id);
  else localStorage.removeItem(KEY);
  window.dispatchEvent(new Event(CHANGED));
}

export function subscribeProfile(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  return () => window.removeEventListener(CHANGED, onChange);
}

// Missing header → server falls back to the default profile
export function profileHeaders(): Record<string, string> {
  const id = getStoredProfileId();
  return id ? { "x-profile-id": id } : {};
}
