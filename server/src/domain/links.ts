/** The token's website: the influencer's TikTok profile when known, otherwise its Reelpad page. */
export function coinWebsite(publicUrl: string, mint: string, tiktokUsername?: string | null): string {
  return tiktokUsername ? tiktokProfileUrl(tiktokUsername) : coinPageUrl(publicUrl, mint);
}

export const tiktokProfileUrl = (username: string) => `https://www.tiktok.com/@${username}`;

/** A coin's locked website: its own page on Reelpad. */
export function coinPageUrl(publicUrl: string, mint: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/coin/${mint}`;
}
