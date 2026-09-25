import { profileHeaders } from "./profile.ts";

export type StagedUpload = { id: string; ref: string; filename: string; sizeBytes: number };

// XMLHttpRequest rather than fetch, for the one thing fetch cannot do: report upload progress.
// The chip shows a percentage, and a 300 MB scan with no percentage looks stuck.
export function uploadStaged(file: File, onProgress: (fraction: number) => void): { done: Promise<StagedUpload>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<StagedUpload>((resolve, reject) => {
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON — the status is the message
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as StagedUpload);
      else {
        const message = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `Upload failed (${xhr.status})`;
        reject(new Error(message));
      }
    };
    xhr.onerror = () => reject(new Error("Upload interrupted"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.open("POST", "/upload/staged");
    for (const [name, value] of Object.entries(profileHeaders())) xhr.setRequestHeader(name, value);
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
  return { done, abort: () => xhr.abort() };
}

export async function removeStagedUpload(id: string): Promise<void> {
  await fetch(`/upload/staged/${id}`, { method: "DELETE", headers: profileHeaders() }).catch(() => {});
}

export function isPdf(file: File): boolean {
  return file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf";
}
