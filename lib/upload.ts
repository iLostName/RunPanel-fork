/**
 * Upload a project's ZIP with progress.
 *
 * `fetch` cannot report how much of a request body has been sent, and a
 * 100 MB archive over a home connection is minutes of a frozen button. An
 * XMLHttpRequest can, so the one upload in the panel that is big enough to
 * need a progress bar goes through it.
 *
 * Browser-only. Same endpoint and fields as before (`/api/upload`, `file` +
 * `projectSlug`), so the server side is unchanged.
 */
export function uploadProjectZip(
  url: string,
  file: File,
  projectSlug: string,
  onProgress?: (fraction: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve();
        return;
      }
      let message: string | undefined;
      try {
        message = (JSON.parse(xhr.responseText) as { error?: string }).error;
      } catch {
        /* not JSON: a proxy's error page */
      }
      reject(new Error(message ?? (xhr.status === 413 ? "Archivio troppo grande per il server" : `Upload non riuscito (${xhr.status})`)));
    };
    xhr.onerror = () => reject(new Error("Upload interrotto: controlla la connessione e riprova"));
    xhr.onabort = () => reject(new Error("Upload annullato"));

    const form = new FormData();
    form.append("file", file);
    form.append("projectSlug", projectSlug);
    xhr.send(form);
  });
}
