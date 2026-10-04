/** Instagram username rules: letters, numbers, periods and underscores, up to 30 characters. Pure, unit-tested. */
export const INSTAGRAM_USERNAME_MESSAGE = "Instagram usernames use letters, numbers, periods and underscores (max 30)";

/** Returns the normalised username (no @, lowercase), or null if it isn't a valid Instagram username. */
export function normalizeInstagramUsername(input: string): string | null {
  const u = input.trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(u) ? u : null;
}
