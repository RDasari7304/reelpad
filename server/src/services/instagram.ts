import { config } from "../config.js";
import { PermanentError } from "../db/jobs.js";

/**
 * Instagram API with Instagram Login (Business Login for Instagram).
 * Works with Professional (Business or Creator) accounts; no Facebook Page needed.
 */
const GRAPH = `https://graph.instagram.com`;
const V = () => `${GRAPH}/${config.IG_API_VERSION}`;
export const IG_SCOPES = ["instagram_business_basic", "instagram_business_content_publish", "instagram_business_manage_comments"];
export const COMMENTS_SCOPE = "instagram_business_manage_comments";
export const redirectUri = () => `${config.PUBLIC_URL.replace(/\/$/, "")}/api/instagram/callback`;

export class InstagramError extends Error {
  constructor(message: string, public code?: number, public subcode?: number, public status?: number) {
    super(message);
  }
  /** Token invalid/expired/revoked: retrying won't help until the creator reconnects. */
  get isAuth() {
    return this.code === 190 || this.status === 401;
  }
  /** The app or account lacks a permission (e.g. comment management wasn't granted). */
  get isPermission() {
    return this.code === 10 || this.code === 200 || this.code === 3 || (this.code !== undefined && this.code >= 200 && this.code <= 299);
  }
  /** Instagram's rate limits: stop and try again later. */
  get isRateLimit() {
    return [4, 17, 32, 613].includes(this.code ?? -1) || this.status === 429;
  }
  /** The comment or post no longer exists, or can't be replied to (deleted, hidden, restricted). */
  get isGone() {
    return this.code === 100 || this.status === 404;
  }
}

async function igFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new InstagramError(`Instagram returned non-JSON (${res.status})`, undefined, undefined, res.status);
  }
  if (!res.ok || json.error) {
    const e = json.error ?? {};
    throw new InstagramError(
      e.error_user_msg || e.message || `Instagram request failed (${res.status})`,
      e.code,
      e.error_subcode,
      res.status,
    );
  }
  return json as T;
}

const form = (params: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(params).toString(),
});

export function authorizeUrl(state: string) {
  const u = new URL("https://www.instagram.com/oauth/authorize");
  u.searchParams.set("client_id", config.IG_APP_ID);
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", IG_SCOPES.join(","));
  u.searchParams.set("state", state);
  u.searchParams.set("force_reauth", "true");
  return u.toString();
}

export async function exchangeCode(code: string) {
  const json = await igFetch<any>(
    "https://api.instagram.com/oauth/access_token",
    form({
      client_id: config.IG_APP_ID,
      client_secret: config.IG_APP_SECRET,
      grant_type: "authorization_code",
      redirect_uri: redirectUri(),
      code: code.replace(/#_$/, ""),
    }),
  );
  const row = Array.isArray(json.data) ? json.data[0] : json;
  const permissions: string[] = String(row.permissions ?? "").split(",").map((s: string) => s.trim());
  return { shortToken: row.access_token as string, userId: String(row.user_id), permissions };
}

/**
 * Tries the same Instagram call on a few equivalent endpoints (unversioned and versioned), because
 * Instagram sometimes answers one with "Unsupported get request" (code 100) while another works.
 */
async function firstThatWorks<T>(attempts: Array<() => Promise<T>>): Promise<T> {
  let last: unknown;
  for (const a of attempts) {
    try {
      return await a();
    } catch (e) {
      last = e;
      // Only an expired/invalid token is final; anything else is worth the next endpoint.
      if (e instanceof InstagramError && e.isAuth && e.code === 190 && e.subcode === 463) break;
    }
  }
  throw last;
}

export async function toLongLived(shortToken: string) {
  const exchange = (base: string) => async () => {
    const u = new URL(`${base}/access_token`);
    u.searchParams.set("grant_type", "ig_exchange_token");
    u.searchParams.set("client_secret", config.IG_APP_SECRET);
    u.searchParams.set("access_token", shortToken);
    const json = await igFetch<{ access_token: string; expires_in: number }>(u.toString());
    return { token: json.access_token, expiresAt: new Date(Date.now() + (json.expires_in || 60 * 24 * 3600) * 1000) };
  };
  return firstThatWorks([exchange(GRAPH), exchange(V())]);
}

export async function refreshToken(token: string) {
  const u = new URL(`${GRAPH}/refresh_access_token`);
  u.searchParams.set("grant_type", "ig_refresh_token");
  u.searchParams.set("access_token", token);
  const json = await igFetch<{ access_token: string; expires_in: number }>(u.toString());
  return { token: json.access_token, expiresAt: new Date(Date.now() + json.expires_in * 1000) };
}

/**
 * The logged-in account's profile. Instagram sometimes rejects "/me" with "Unsupported get request"
 * (for some accounts, versions or fields), so this falls back to fewer fields, the unversioned API,
 * and finally the account's own ID from the login step.
 */
export async function getMe(token: string, userId?: string) {
  type Me = { user_id?: string; id: string; username: string; account_type?: string; profile_picture_url?: string };
  const get = (base: string, node: string, fields: string) => async () => {
    const u = new URL(`${base}/${node}`);
    u.searchParams.set("fields", fields);
    u.searchParams.set("access_token", token);
    const me = await igFetch<Me>(u.toString());
    if (!me.username) throw new InstagramError("Instagram returned no username");
    return me;
  };
  const full = "user_id,username,account_type,profile_picture_url";
  const basic = "id,username,account_type";
  const attempts = [get(V(), "me", full), get(V(), "me", basic), get(GRAPH, "me", basic)];
  if (userId && userId !== "undefined") attempts.push(get(V(), userId, "id,username,account_type,profile_picture_url"), get(GRAPH, userId, "id,username"));
  const me = await firstThatWorks(attempts);
  return {
    igUserId: String(me.user_id ?? me.id ?? userId),
    username: me.username,
    accountType: me.account_type ?? null,
    picture: me.profile_picture_url ?? null,
  };
}

// ---------- publishing ----------

async function createContainer(igUserId: string, token: string, params: Record<string, string>) {
  const json = await igFetch<{ id: string }>(`${V()}/${igUserId}/media`, form({ ...params, access_token: token }));
  return json.id;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until a container is FINISHED (videos are transcoded asynchronously). */
async function waitForContainer(containerId: string, token: string, timeoutMs = 10 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const u = new URL(`${V()}/${containerId}`);
    u.searchParams.set("fields", "status_code,status");
    u.searchParams.set("access_token", token);
    const s = await igFetch<{ status_code: string; status?: string }>(u.toString());
    if (s.status_code === "FINISHED") return;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") {
      throw new PermanentError(`Instagram could not process the media: ${s.status ?? s.status_code}`);
    }
    await sleep(5000);
  }
  throw new Error("Timed out waiting for Instagram to process media");
}

/** Used on retries: a container that is already PUBLISHED must not be published twice. */
export async function containerStatus(containerId: string, token: string): Promise<string | null> {
  const u = new URL(`${V()}/${containerId}`);
  u.searchParams.set("fields", "status_code");
  u.searchParams.set("access_token", token);
  try {
    return (await igFetch<{ status_code: string }>(u.toString())).status_code;
  } catch {
    return null;
  }
}

async function publishContainer(igUserId: string, token: string, containerId: string) {
  const json = await igFetch<{ id: string }>(
    `${V()}/${igUserId}/media_publish`,
    form({ creation_id: containerId, access_token: token }),
  );
  return json.id;
}

async function getPermalink(mediaId: string, token: string) {
  const u = new URL(`${V()}/${mediaId}`);
  u.searchParams.set("fields", "permalink");
  u.searchParams.set("access_token", token);
  try {
    return (await igFetch<{ permalink?: string }>(u.toString())).permalink ?? null;
  } catch {
    return null;
  }
}

export interface PublishInput {
  igUserId: string;
  token: string;
  format: "image" | "carousel" | "reel";
  caption: string;
  mediaUrls: string[]; // images for image/carousel; [videoUrl, coverImageUrl?] for reel
  /** Instagram usernames to invite as collaborators (up to 3); the post then shows on their profile too once they accept. */
  collaborators?: string[];
}

/**
 * Creates the post's main container with Instagram's AI-disclosure label and any collab partners.
 * If Instagram rejects one of those extras (e.g. a collaborator it can't invite), the post still goes
 * out: first without collaborators, then without the label.
 */
async function createTop(igUserId: string, token: string, params: Record<string, string>, collaborators: string[]) {
  const attempts: Array<Record<string, string>> = [
    { ...params, is_ai_generated: "true", ...(collaborators.length ? { collaborators: JSON.stringify(collaborators.slice(0, 3)) } : {}) },
    ...(collaborators.length ? [{ ...params, is_ai_generated: "true" }] : []),
    params,
  ];
  let last: unknown;
  for (const a of attempts) {
    try {
      return await createContainer(igUserId, token, a);
    } catch (e) {
      last = e;
      if (!(e instanceof InstagramError) || e.isAuth || e.isRateLimit) throw e;
    }
  }
  throw last;
}

export async function publish(input: PublishInput, onContainer?: (id: string) => Promise<void>) {
  const { igUserId, token, caption } = input;
  const collabs = input.collaborators ?? [];
  let containerId: string;

  if (input.format === "image") {
    containerId = await createTop(igUserId, token, { image_url: input.mediaUrls[0]!, caption }, collabs);
  } else if (input.format === "carousel") {
    const urls = input.mediaUrls.slice(0, 10);
    if (urls.length < 2) throw new PermanentError("A carousel needs at least 2 images");
    const children: string[] = [];
    for (const url of urls) {
      children.push(await createContainer(igUserId, token, { image_url: url, is_carousel_item: "true" }));
    }
    for (const c of children) await waitForContainer(c, token, 2 * 60_000);
    containerId = await createTop(igUserId, token, { media_type: "CAROUSEL", children: children.join(","), caption }, collabs);
  } else {
    const params: Record<string, string> = {
      media_type: "REELS",
      video_url: input.mediaUrls[0]!,
      caption,
      share_to_feed: "true",
    };
    if (input.mediaUrls[1]) params.cover_url = input.mediaUrls[1];
    containerId = await createTop(igUserId, token, params, collabs);
  }

  await onContainer?.(containerId);
  await waitForContainer(containerId, token);
  const mediaId = await publishContainer(igUserId, token, containerId);
  const permalink = await getPermalink(mediaId, token);
  return { containerId, mediaId, permalink };
}

// ---------- comments ----------

export interface IgComment {
  id: string;
  text: string;
  username: string;
  timestamp: string;
  like_count?: number;
  replies?: { data: Array<Omit<IgComment, "replies">> };
}

/** Comment counts for the account's recent media (one call), to fetch comments only where something changed. */
export async function mediaCommentCounts(igUserId: string, token: string): Promise<Map<string, number>> {
  const u = new URL(`${V()}/${igUserId}/media`);
  u.searchParams.set("fields", "id,comments_count");
  u.searchParams.set("limit", "50");
  u.searchParams.set("access_token", token);
  const json = await igFetch<{ data: Array<{ id: string; comments_count?: number }> }>(u.toString());
  return new Map(json.data.map((m) => [m.id, m.comments_count ?? 0]));
}

/** Every comment on a post with its replies (Instagram threads are one level deep). Up to 4 pages of 50. */
export async function listComments(mediaId: string, token: string): Promise<IgComment[]> {
  const out: IgComment[] = [];
  const u = new URL(`${V()}/${mediaId}/comments`);
  u.searchParams.set("fields", "id,text,username,timestamp,like_count,replies.limit(50){id,text,username,timestamp,like_count}");
  u.searchParams.set("limit", "50");
  u.searchParams.set("access_token", token);
  let next: string | undefined = u.toString();
  for (let page = 0; next && page < 4; page++) {
    const json: { data: IgComment[]; paging?: { next?: string } } = await igFetch(next);
    out.push(...json.data);
    next = json.paging?.next;
  }
  return out;
}

/** Posts a reply under a top-level comment. Returns the new comment's id. */
export async function replyToComment(commentId: string, message: string, token: string): Promise<string> {
  const json = await igFetch<{ id: string }>(`${V()}/${commentId}/replies`, form({ message, access_token: token }));
  return json.id;
}
