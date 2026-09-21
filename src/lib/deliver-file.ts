/**
 * Hands in-memory bytes to the browser's own download flow. The blob lives
 * only in memory behind a short-lived object URL: nothing is written to the
 * Cache API, the service worker or any local storage, per docs/22 section 6.
 */
export function deliverBlobToBrowser(blob: Blob, filename: string): boolean {
  if (
    typeof document === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return false;
  }
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  return true;
}
