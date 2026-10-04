/** The token's website: the influencer's Instagram profile when known, otherwise its Reelpad page. */
export function coinWebsite(publicUrl: string, mint: string, instagramUsername?: string | null): string {
  return instagramUsername ? instagramProfileUrl(instagramUsername) : coinPageUrl(publicUrl, mint);
}

export const instagramProfileUrl = (username: string) => `https://www.instagram.com/${username}/`;

/** A coin's locked website: its own page on Reelpad. */
export function coinPageUrl(publicUrl: string, mint: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/coin/${mint}`;
}
