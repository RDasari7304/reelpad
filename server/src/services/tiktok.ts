import { config } from "../config.js";
import { PermanentError } from "../db/jobs.js";
import { photoTitle, pickPrivacy, postUrl, quotePostIds } from "../domain/tiktok.js";

export { postUrl };

/**
 * TikTok for Developers: Login Kit (OAuth v2) and the Content Posting API (Direct Post).
 * Videos and photo posts are pulled by TikTok from our public media URLs, so the S3_PUBLIC_BASE_URL
 * domain (or URL prefix) must be verified in the TikTok developer portal.
 *
 * Comment replies use the TikTok API for Business comment endpoints, which only work for apps that
 * were granted the comment scopes. They're switched on with TIKTOK_COMMENTS=true.
 */
const OPEN = "https://open.tiktokapis.com";
const BUSINESS = "https://business-api.tiktok.com/open_api/v1.3";
export const COMMENTS_SCOPE = "comment.list.manage";
export const PUBLISH_SCOPE = "video.publish";
export const tiktokScopes = () => [
  "user.info.basic",
  "user.info.profile",
  "video.publish",
  "video.upload",
  "video.list",
  ...(config.TIKTOK_COMMENTS ? ["comment.list", COMMENTS_SCOPE] : []),
];
export const redirectUri = () => `${config.PUBLIC_URL.replace(/\/$/, "")}/api/tiktok/callback`;

export class TikTokError extends Error {
  constructor(message: string, public code?: string, public status?: number) {
    super(message);
  }
  /** Token invalid/expired/revoked: retrying won't help until the token is refreshed or the creator reconnects. */
  get isAuth() {
    return ["access_token_invalid", "invalid_grant", "invalid_token", "token_expired", "40100", "40105"].includes(this.code ?? "") || this.status === 401;
  }
  /** The app or account lacks a permission (e.g. comment management wasn't granted). */
  get isPermission() {
    return ["scope_not_authorized", "scope_permission_missed", "permission_denied", "40001", "40002"].includes(this.code ?? "") || this.status === 403;
  }
  /** TikTok's rate and posting limits: stop and try again later. */
  get isRateLimit() {
    return ["rate_limit_exceeded", "spam_risk_too_many_posts", "spam_risk_too_many_pending_share", "40100429", "40016"].includes(this.code ?? "") || this.status === 429;
  }
  /** The comment or video no longer exists, or can't be replied to (deleted, hidden, restricted). */
  get isGone() {
    return ["video_not_found", "comment_not_found", "40404", "40006"].includes(this.code ?? "") || this.status === 404;
  }
}

/** TikTok's open API wraps every answer as { data, error: { code: "ok" | "...", message, log_id } }. */
async function ttFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(quotePostIds(text));
  } catch {
    throw new TikTokError(`TikTok returned non-JSON (${res.status})`, undefined, res.status);
  }
  const err = json.error;
  // OAuth endpoints answer errors as { error: "invalid_grant", error_description }.
  if (typeof err === "string") throw new TikTokError(json.error_description || err, err, res.status);
  if (!res.ok || (err && err.code && err.code !== "ok")) {
    throw new TikTokError(err?.message || `TikTok request failed (${res.status})`, err?.code, res.status);
  }
  return (json.data ?? json) as T;
}

const json = (token: string, body: unknown): RequestInit => ({
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
  body: JSON.stringify(body),
});

const form = (params: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
  body: new URLSearchParams(params).toString(),
});

// ---------- login ----------

export function authorizeUrl(state: string) {
  const u = new URL("https://www.tiktok.com/v2/auth/authorize/");
  u.searchParams.set("client_key", config.TIKTOK_CLIENT_KEY);
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", tiktokScopes().join(","));
  u.searchParams.set("state", state);
  u.searchParams.set("disable_auto_auth", "1");
  return u.toString();
}

export interface TokenSet {
  token: string;
  expiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
  openId: string;
  scopes: string[];
}

function tokenSet(t: any): TokenSet {
  return {
    token: String(t.access_token),
    expiresAt: new Date(Date.now() + (Number(t.expires_in) || 86_400) * 1000),
    refreshToken: String(t.refresh_token),
    refreshExpiresAt: new Date(Date.now() + (Number(t.refresh_expires_in) || 365 * 86_400) * 1000),
    openId: String(t.open_id),
    scopes: String(t.scope ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

/** Swaps the login code for an access token (24 hours) and a refresh token (365 days). */
export async function exchangeCode(code: string): Promise<TokenSet> {
  const t = await ttFetch<any>(
    `${OPEN}/v2/oauth/token/`,
    form({
      client_key: config.TIKTOK_CLIENT_KEY,
      client_secret: config.TIKTOK_CLIENT_SECRET,
      code: decodeURIComponent(code),
      grant_type: "authorization_code",
      redirect_uri: redirectUri(),
    }),
  );
  return tokenSet(t);
}

/** A fresh access token from the refresh token. TikTok may also rotate the refresh token. */
export async function refreshToken(refresh: string): Promise<TokenSet> {
  const t = await ttFetch<any>(
    `${OPEN}/v2/oauth/token/`,
    form({
      client_key: config.TIKTOK_CLIENT_KEY,
      client_secret: config.TIKTOK_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refresh,
    }),
  );
  return tokenSet(t);
}

/** Revokes the app's access (used on disconnect). Failures are ignored: the token is dropped either way. */
export async function revokeToken(token: string) {
  await ttFetch(
    `${OPEN}/v2/oauth/revoke/`,
    form({ client_key: config.TIKTOK_CLIENT_KEY, client_secret: config.TIKTOK_CLIENT_SECRET, token }),
  ).catch(() => {});
}

/** The logged-in account's profile. */
export async function getMe(token: string) {
  const fields = "open_id,union_id,avatar_url,display_name,username";
  const data = await ttFetch<{ user: { open_id: string; username?: string; display_name?: string; avatar_url?: string } }>(
    `${OPEN}/v2/user/info/?fields=${fields}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const u = data.user;
  if (!u?.username) throw new TikTokError("TikTok returned no username (the profile permission is needed)");
  return { openId: String(u.open_id), username: u.username, displayName: u.display_name ?? null, picture: u.avatar_url ?? null };
}

// ---------- publishing ----------

export interface CreatorInfo {
  creator_username: string;
  privacy_level_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec: number;
}

/** What the creator can post right now (TikTok requires this before every Direct Post). */
export async function creatorInfo(token: string): Promise<CreatorInfo> {
  return ttFetch<CreatorInfo>(`${OPEN}/v2/post/publish/creator_info/query/`, json(token, {}));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PublishStatus {
  status: "PROCESSING_DOWNLOAD" | "PROCESSING_UPLOAD" | "SEND_TO_USER_INBOX" | "PUBLISH_COMPLETE" | "FAILED" | string;
  fail_reason?: string;
  publicaly_available_post_id?: Array<string | number>;
}

/** Where a post is in TikTok's pipeline. Used on retries so a post that already went out isn't posted twice. */
export async function publishStatus(publishId: string, token: string): Promise<PublishStatus | null> {
  try {
    return await ttFetch<PublishStatus>(`${OPEN}/v2/post/publish/status/fetch/`, json(token, { publish_id: publishId }));
  } catch {
    return null;
  }
}

/** Waits until TikTok has downloaded, processed and published the post. Returns the public post id when there is one. */
async function waitForPublish(publishId: string, token: string, timeoutMs = 10 * 60_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await ttFetch<PublishStatus>(`${OPEN}/v2/post/publish/status/fetch/`, json(token, { publish_id: publishId }));
    if (s.status === "PUBLISH_COMPLETE") return s.publicaly_available_post_id?.[0] != null ? String(s.publicaly_available_post_id[0]) : null;
    if (s.status === "FAILED") throw new PermanentError(`TikTok could not publish the post: ${s.fail_reason ?? "unknown reason"}`);
    await sleep(5000);
  }
  throw new Error("Timed out waiting for TikTok to process the post");
}

export interface PublishInput {
  token: string;
  username: string;
  format: "image" | "carousel" | "reel";
  caption: string;
  mediaUrls: string[]; // images for image/carousel (photo post); [videoUrl] for reel (video post)
  /** Resume a post TikTok is already processing (a retry after the worker stopped mid-publish). */
  publishId?: string | null;
}

async function initPost(input: PublishInput, privacy: string, info: CreatorInfo) {
  const common = {
    privacy_level: privacy,
    disable_comment: info.comment_disabled ?? false,
    brand_content_toggle: false,
    brand_organic_toggle: false,
  };
  if (input.format === "reel") {
    return ttFetch<{ publish_id: string }>(
      `${OPEN}/v2/post/publish/video/init/`,
      json(input.token, {
        post_info: {
          ...common,
          title: input.caption.slice(0, 2200),
          disable_duet: info.duet_disabled ?? false,
          disable_stitch: info.stitch_disabled ?? false,
          video_cover_timestamp_ms: 500,
          is_aigc: true, // TikTok's "AI-generated" label
        },
        source_info: { source: "PULL_FROM_URL", video_url: input.mediaUrls[0] },
      }),
    );
  }
  const urls = input.mediaUrls.slice(0, 35);
  if (input.format === "carousel" && urls.length < 2) throw new PermanentError("A photo carousel needs at least 2 images");
  return ttFetch<{ publish_id: string }>(
    `${OPEN}/v2/post/publish/content/init/`,
    json(input.token, {
      post_info: { ...common, title: photoTitle(input.caption), description: input.caption.slice(0, 4000), auto_add_music: true },
      source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: urls },
      post_mode: "DIRECT_POST",
      media_type: "PHOTO",
    }),
  );
}

/**
 * Posts straight to the creator's TikTok. Unaudited apps may only post privately: if TikTok says so,
 * the post goes out as private ("only me") rather than failing.
 */
export async function publish(input: PublishInput, onPublishId?: (id: string) => Promise<void>) {
  let publishId = input.publishId ?? null;
  if (!publishId) {
    const info = await creatorInfo(input.token);
    const privacy = pickPrivacy(info.privacy_level_options ?? [], config.TIKTOK_PRIVACY_LEVEL);
    try {
      publishId = (await initPost(input, privacy, info)).publish_id;
    } catch (e) {
      if (!(e instanceof TikTokError) || e.code !== "unaudited_client_can_only_post_to_private_accounts" || privacy === "SELF_ONLY") throw e;
      publishId = (await initPost(input, "SELF_ONLY", info)).publish_id;
    }
    await onPublishId?.(publishId);
  }
  const postId = await waitForPublish(publishId, input.token);
  const permalink = postId ? postUrl(input.username, postId, input.format === "reel" ? "video" : "photo") : null;
  return { publishId, postId, permalink };
}

// ---------- comments ----------

export interface TtComment {
  id: string;
  text: string;
  username: string;
  timestamp: string;
  like_count?: number;
  replies?: { data: Array<Omit<TtComment, "replies">> };
}

/** Comment counts for the account's recent videos (one call), to fetch comments only where something changed. */
export async function mediaCommentCounts(token: string, postIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < postIds.length; i += 20) {
    const data = await ttFetch<{ videos: Array<{ id: string; comment_count?: number }> }>(
      `${OPEN}/v2/video/query/?fields=id,comment_count`,
      json(token, { filters: { video_ids: postIds.slice(i, i + 20) } }),
    );
    for (const v of data.videos ?? []) out.set(String(v.id), v.comment_count ?? 0);
  }
  return out;
}

/** The TikTok API for Business answers { code: 0, message, data }. */
async function bizFetch<T>(path: string, token: string, init?: { body?: unknown; query?: Record<string, string> }): Promise<T> {
  const u = new URL(`${BUSINESS}${path}`);
  for (const [k, v] of Object.entries(init?.query ?? {})) u.searchParams.set(k, v);
  const res = await fetch(u.toString(), {
    method: init?.body ? "POST" : "GET",
    headers: { "Access-Token": token, "Content-Type": "application/json" },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
  let j: any;
  try {
    j = await res.json();
  } catch {
    throw new TikTokError(`TikTok returned non-JSON (${res.status})`, undefined, res.status);
  }
  if (!res.ok || (j.code !== undefined && j.code !== 0)) throw new TikTokError(j.message || `TikTok request failed (${res.status})`, String(j.code ?? ""), res.status);
  return j.data as T;
}

type BizComment = { comment_id: string; text: string; username?: string; display_name?: string; create_time: number; likes?: number; owner?: boolean };
const toComment = (c: BizComment): Omit<TtComment, "replies"> => ({
  id: String(c.comment_id),
  text: c.text ?? "",
  username: c.username ?? c.display_name ?? "unknown",
  timestamp: new Date((c.create_time ?? Date.now() / 1000) * 1000).toISOString(),
  like_count: c.likes ?? 0,
});

/** Every comment on a video with its replies (TikTok threads are one level deep). Up to 4 pages of 50. */
export async function listComments(openId: string, videoId: string, token: string): Promise<TtComment[]> {
  const out: TtComment[] = [];
  let cursor = 0;
  for (let page = 0; page < 4; page++) {
    const data = await bizFetch<{ comments: Array<BizComment & { replies?: number }>; cursor: number; has_more: boolean }>(
      "/business/comment/list/",
      token,
      { query: { business_id: openId, video_id: videoId, max_count: "50", cursor: String(cursor) } },
    );
    for (const c of data.comments ?? []) {
      const replies: Array<Omit<TtComment, "replies">> = [];
      if ((c.replies ?? 0) > 0) {
        const r = await bizFetch<{ comments: BizComment[] }>("/business/comment/reply/list/", token, {
          query: { business_id: openId, video_id: videoId, comment_id: String(c.comment_id), max_count: "50" },
        }).catch(() => ({ comments: [] as BizComment[] }));
        replies.push(...(r.comments ?? []).map(toComment));
      }
      out.push({ ...toComment(c), replies: { data: replies } });
    }
    if (!data.has_more) break;
    cursor = data.cursor;
  }
  return out;
}

/** Posts a reply under a top-level comment. Returns the new comment's id. */
export async function replyToComment(openId: string, videoId: string, commentId: string, message: string, token: string): Promise<string> {
  const data = await bizFetch<{ comment_id: string }>("/business/comment/reply/create/", token, {
    body: { business_id: openId, video_id: videoId, comment_id: commentId, text: message },
  });
  return String(data.comment_id);
}
