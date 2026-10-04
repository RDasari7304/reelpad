/**
 * The Room's world: layout, and where every character is at any moment.
 *
 * Movement is a pure function of (character id, time, conversations), so every viewer sees each
 * character in the same place at the same time without the server streaming positions.
 */

export const WORLD = { w: 2400, h: 1500 };
export const SLOT_SEC = 9; // a character picks a new spot to walk to every slot
const SPEED = 75; // px per second
const RELEASE_SEC = 4; // time to drift back to wandering after a conversation

export interface Zone {
  key: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

/** Areas of the Room. Characters each have a favourite and drift between the rest. */
export const ZONES: Zone[] = [
  { key: "cafe", label: "Café", x: 120, y: 120, w: 620, h: 440, color: "#f3e3cf" },
  { key: "desk", label: "Trading desks", x: 900, y: 110, w: 640, h: 380, color: "#d9e6f7" },
  { key: "stage", label: "Stage", x: 1700, y: 120, w: 580, h: 440, color: "#ecd8f3" },
  { key: "garden", label: "Garden", x: 140, y: 820, w: 640, h: 560, color: "#d8eed9" },
  { key: "fountain", label: "Fountain", x: 960, y: 640, w: 480, h: 420, color: "#dbeaf0" },
  { key: "lounge", label: "Lounge", x: 1620, y: 800, w: 660, h: 580, color: "#f3dbe1" },
];

export interface TimedLine {
  speaker: "a" | "b";
  text: string;
  action: string;
  at: number;
  dur: number;
}
export interface Conversation {
  id: string;
  a: string;
  b: string;
  topic: string;
  lines: TimedLine[];
  summary: string;
  startsAt: string;
  talkAt: string;
  endsAt: string;
}
/** Conversation with times pre-parsed to seconds. */
export interface Convo extends Conversation {
  s: number;
  talk: number;
  e: number;
}
export const toConvo = (c: Conversation): Convo => ({
  ...c,
  s: Date.parse(c.startsAt) / 1000,
  talk: Date.parse(c.talkAt) / 1000,
  e: Date.parse(c.endsAt) / 1000,
});

export function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const hueOf = (id: string) => hash(id) % 360;
const favouriteZone = (id: string) => ZONES[hash(`${id}:zone`) % ZONES.length]!;

const MARGIN = 60;
/** The spot character `id` walks toward during slot k. */
export function target(id: string, k: number): { x: number; y: number } {
  const r = rng(hash(id) ^ Math.imul(k, 2654435761));
  const fav = favouriteZone(id);
  const zone = r() < 0.55 ? fav : ZONES[Math.floor(r() * ZONES.length)]!;
  // Sometimes wander the open floor between areas.
  if (r() < 0.2) return { x: MARGIN + r() * (WORLD.w - 2 * MARGIN), y: MARGIN + r() * (WORLD.h - 2 * MARGIN) };
  return { x: zone.x + 40 + r() * (zone.w - 80), y: zone.y + 60 + r() * (zone.h - 100) };
}

const ease = (p: number) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

export interface Pose {
  x: number;
  y: number;
  moving: boolean;
  facing: 1 | -1;
  talking: boolean;
}

/** Free wandering, ignoring conversations. */
export function wander(id: string, t: number): Pose {
  const k = Math.floor(t / SLOT_SEC);
  const from = target(id, k - 1);
  const to = target(id, k);
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const walk = Math.min(SLOT_SEC * 0.8, Math.max(1.5, dist / SPEED));
  // Small per-character delay so they don't all set off at once.
  const delay = (hash(`${id}:d`) % 1000) / 1000 * (SLOT_SEC - walk) * 0.6;
  const p = Math.min(1, Math.max(0, (t - k * SLOT_SEC - delay) / walk));
  return {
    x: lerp(from.x, to.x, ease(p)),
    y: lerp(from.y, to.y, ease(p)),
    moving: p > 0 && p < 1,
    facing: to.x >= from.x ? 1 : -1,
    talking: false,
  };
}

/** Where two characters stand while they talk (side by side, A on the left). */
function spots(c: Convo) {
  const a0 = wander(c.a, c.s);
  const b0 = wander(c.b, c.s);
  const mx = Math.min(WORLD.w - 120, Math.max(120, (a0.x + b0.x) / 2));
  const my = Math.min(WORLD.h - 120, Math.max(120, (a0.y + b0.y) / 2));
  const aLeft = a0.x <= b0.x;
  return {
    a: { x: mx + (aLeft ? -42 : 42), y: my },
    b: { x: mx + (aLeft ? 42 : -42), y: my },
    mid: { x: mx, y: my },
  };
}

/** The conversation (if any) that is moving this character at time t. */
export function activeConvoFor(id: string, t: number, convos: Convo[]): Convo | null {
  let best: Convo | null = null;
  for (const c of convos) {
    if ((c.a === id || c.b === id) && t >= c.s && t <= c.e + RELEASE_SEC && (!best || c.s > best.s)) best = c;
  }
  return best;
}

export function poseAt(id: string, t: number, convos: Convo[]): Pose {
  const free = wander(id, t);
  const c = activeConvoFor(id, t, convos);
  if (!c) return free;
  const sp = spots(c);
  const me = c.a === id ? sp.a : sp.b;
  const other = c.a === id ? sp.b : sp.a;
  const facing: 1 | -1 = other.x >= me.x ? 1 : -1;
  if (t < c.talk) {
    const start = wander(id, c.s);
    const p = ease(Math.min(1, (t - c.s) / Math.max(0.1, c.talk - c.s)));
    return { x: lerp(start.x, me.x, p), y: lerp(start.y, me.y, p), moving: p < 1, facing: me.x >= start.x ? 1 : -1, talking: false };
  }
  if (t <= c.e) return { x: me.x, y: me.y, moving: false, facing, talking: true };
  const p = ease(Math.min(1, (t - c.e) / RELEASE_SEC));
  return { x: lerp(me.x, free.x, p), y: lerp(me.y, free.y, p), moving: true, facing: free.facing, talking: false };
}

export const convoMid = (c: Convo) => spots(c).mid;

/** The line being said right now in a conversation, with how far through it we are (0–1). */
export function currentLine(c: Convo, t: number): { line: TimedLine; progress: number } | null {
  const rel = t - c.talk;
  for (const line of c.lines) {
    if (rel >= line.at && rel < line.at + line.dur) return { line, progress: (rel - line.at) / line.dur };
  }
  return null;
}

/** Lines already said (for transcripts). */
export const spokenLines = (c: Convo, t: number) => c.lines.filter((l) => t - c.talk >= l.at);

export type ConvoState = "upcoming" | "walking" | "talking" | "done";
export function convoState(c: Convo, t: number): ConvoState {
  if (t < c.s) return "upcoming";
  if (t < c.talk) return "walking";
  if (t <= c.e) return "talking";
  return "done";
}
