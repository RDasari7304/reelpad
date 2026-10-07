export class ApiError extends Error {
  constructor(message: string, public status: number, public issues?: Array<{ path: string; message: string }>) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const issue = data.issues?.[0];
    throw new ApiError(issue ? `${issue.path}: ${issue.message}` : data.error ?? `Request failed (${res.status})`, res.status, data.issues);
  }
  return data as T;
}

// ---------- shared types ----------

export type Format = "image" | "carousel" | "reel";

export interface Persona {
  personality: string | null;
  personalityCustom: string;
  backstory: string;
  voice: string;
  visualStyle: string;
  visualStyleCustom: string;
  themes: string[];
  avoid: string;
  language: string;
}

export interface ContentSettings {
  formats: Format[];
  postsPerDay: number;
  reelsPerWeek: number;
  autoPublish: boolean;
  hashtags: string[];
  postAboutBurns?: boolean;
  commentReplies?: boolean;
  commentRepliesPerDay?: number;
  /** Reels: "film" = live-action cinematic footage, "match" = the character's own art style. */
  reelLook?: "film" | "match";
}

export interface Coin {
  id: string;
  creatorWallet: string;
  name: string;
  symbol: string;
  description: string;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  imageUrl: string;
  mint: string | null;
  agentWallet: string;
  status: "draft" | "awaiting_signature" | "launching" | "live" | "failed";
  launchError: string | null;
  launchTxSig: string | null;
  persona: Persona;
  contentSettings: ContentSettings;
  contentPaused: boolean;
  treasuryPaused: boolean;
  nextPostAt: string | null;
  launchedAt: string | null;
  tiktok?: {
    username: string;
    status?: string;
    picture?: string | null;
    commentsEnabled?: boolean;
    commentsError?: string | null;
  } | null;
  tiktokAccess?: TikTokAccess | null;
  lastImage?: string | null;
  activity?: "active" | "cooling" | "dormant";
  activityChangedAt?: string | null;
  postCount?: number;
  isOwner?: boolean;
}

export interface TikTokAccess {
  username: string;
  status: "pending" | "invited" | "connected";
  requestedAt: string;
  invitedAt: string | null;
}

/** Mirrors server/src/domain/tiktok.ts */
export function normalizeTikTokUsername(input: string): string | null {
  const u = input.trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9._]{2,24}$/.test(u) && !u.endsWith(".") ? u : null;
}

export interface Post {
  id: string;
  format: Format;
  status: string;
  trigger: string;
  concept: string | null;
  caption: string | null;
  media: Array<{ type: "image" | "video"; url: string; role?: string }>;
  permalink: string | null;
  error: string | null;
  progress: number;
  stage: string | null;
  created_at: string;
  published_at: string | null;
  collab?: { id: string; name: string; symbol: string; mint: string | null } | null;
}

export interface FeedPost {
  id: string;
  format: Format;
  caption: string | null;
  media: Array<{ type: "image" | "video"; url: string; role?: string }>;
  permalink: string | null;
  publishedAt: string;
  coin: { id: string; name: string; symbol: string; mint: string | null; imageUrl: string; tiktok: string | null };
  collab?: { id: string; name: string; symbol: string; mint: string | null } | null;
}

export interface StoryArcView {
  title: string;
  premise: string;
  status: "active" | "done";
  episode: number;
  episodes: number;
  happened: Array<{ title: string; recap: string | null }>;
  startedAt: string;
  completedAt: string | null;
}
export interface StoryResponse {
  current: StoryArcView | null;
  past: StoryArcView[];
  /** Before the first storyline: the character's latest moments, from its posts. */
  lately?: Array<{ title: string; recap: string | null; at: string }>;
  poll?: StoryPoll | null;
}
export interface StoryPoll {
  id: string;
  question: string;
  episode: number;
  options: Array<{ text: string; votes: number }>;
  total: number;
  myVote: number | null;
}

export interface CommentView {
  id: string;
  username: string;
  text: string;
  likeCount: number;
  at: string;
  isOwn: boolean;
  status?: "new" | "replied" | "skipped" | "failed" | "own";
  action?: "reply" | "react" | "skip" | null;
  reason?: string | null;
}
export interface CommentThread extends CommentView {
  post: { id: string | null; permalink: string | null; thumb: string | null };
  replies: CommentView[];
}
export interface CommentsResponse {
  threads: CommentThread[];
  stats: { today: number; waiting: number; total: number } | null;
}

export interface Shoutout {
  id: string;
  coinId: string;
  format: "video" | "photo";
  recipient: string;
  status: "awaiting_burn" | "queued" | "making" | "done" | "failed" | "expired";
  progress: number;
  stage: string | null;
  error: string | null;
  media: Array<{ type: "image" | "video"; url: string; role?: string }>;
  note: string | null;
  spokenLine: string | null;
  burnSig: string | null;
  tokensBurned: string | null;
  tokens: string;
  fan: string;
  createdAt: string;
  doneAt: string | null;
  mine: boolean;
  request: string | null;
  public: boolean;
}
export interface ShoutoutPrice {
  sol: number;
  tokens: string;
  raw: string;
}
export interface ShoutoutsResponse {
  pricing: { enabled: boolean; decimals: number; photo: ShoutoutPrice | null; video: ShoutoutPrice | null } | null;
  wall: Shoutout[];
  mine: Shoutout[];
  stats: { shoutouts: number; tokensBurned: string };
}

export interface TreasuryView {
  agentWallet: string;
  solBalance: number | null;
  totals: { feesCollectedSol: number; boughtBackSol: number; tokensBurned: number; burns: number; nativeBoughtSol?: number; nativeBurned?: number };
  rules: { minBuySol: number; buyIntervalMin: number; gasReserveSol: number };
  native: { mint: string; symbol: string; share: number } | null;
  paused: boolean;
  dryRun: boolean;
  actions: Array<{
    kind: string;
    sol_amount: string | null;
    token_amount: string | null;
    tx_sig: string | null;
    status: string;
    reason: string;
    dry_run: boolean;
    created_at: string;
    mint?: string | null;
  }>;
  prices: Array<{ t: string; p: number }>;
}

export interface AppConfig {
  appName: string;
  platformFeeSol: number;
  agentGasSol: number;
  treasuryDryRun: boolean;
  tiktokAccessMode: "testers" | "open";
  tiktokComments?: boolean;
  limits: { minPostsPerDay: number; maxPostsPerDay: number; maxReelsPerWeek: number; nativeBuybackShare?: number; treasuryMinBuySol: number; treasuryBuyIntervalMin: number };
  reels?: { seconds: number; shots?: number; audio: boolean };
  catalog: {
    personalities: Record<string, string>;
    visualStyles: Record<string, string>;
  };
}

export const shortAddr = (a: string, n = 4) => `${a.slice(0, n)}…${a.slice(-n)}`;
export const humanize = (key: string) =>
  key.replace(/_/g, " ").replace(/^3d/, "3D").replace(/^\w/, (c) => c.toUpperCase());
