/** One spelling for the page and its skeleton, so the header does not change under the reader. */
export function monitorDescription(isSolo: boolean): string {
  return isSolo
    ? "Come sta il server e chi lo sta usando, adesso e nel tempo"
    : "Come stanno i server e chi li sta usando, adesso e nel tempo";
}
