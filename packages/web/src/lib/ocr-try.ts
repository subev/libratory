export function dur(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `about ${Math.round(seconds / 60)} min`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds - h * 3600) / 60);
  return `about ${h}h ${m ? `${m}m` : "00m"}`;
}

export function preselectLanguage(bookPack: string | null, candidates: string[]): string {
  return bookPack ?? candidates[0] ?? "eng";
}
