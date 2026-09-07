export function dur(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `about ${Math.round(seconds / 60)} min`;
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `about ${h}h ${m ? `${m}m` : "00m"}`;
}

export function preselectLanguage(bookPack: string | null, candidates: string[]): string {
  return bookPack ?? candidates[0] ?? "eng";
}
