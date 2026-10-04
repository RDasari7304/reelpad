/** A coin's locked website: its own page on Reelpad. */
export function coinPageUrl(publicUrl: string, mint: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/coin/${mint}`;
}
