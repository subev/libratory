// Reading speed is a standing preference, not something to re-pick every time a chapter opens —
// and it is one preference, shared by the reader, the chapter modal and the assembly rows
const SPEED_KEY = "reader.speed";
// localStorage only fires `storage` in *other* tabs, and all three of those surfaces can be on
// screen at once, so the one that writes has to say so.
const SPEED_EVENT = "libratory:speed";

export const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

export function loadSpeed(): number {
  const stored = Number(localStorage.getItem(SPEED_KEY));
  return SPEEDS.includes(stored) ? stored : 1;
}

export function saveSpeed(rate: number): void {
  localStorage.setItem(SPEED_KEY, String(rate));
  window.dispatchEvent(new Event(SPEED_EVENT));
}

export function subscribeSpeed(onChange: (rate: number) => void): () => void {
  const handler = () => onChange(loadSpeed());
  window.addEventListener(SPEED_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(SPEED_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}
