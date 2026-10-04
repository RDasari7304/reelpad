/**
 * Timing for Room conversations. Stored with each conversation so every viewer sees the same
 * thing at the same moment: two characters walk toward each other, then speak line by line.
 */
export const WALK_IN_SEC = 6;
export const LEAD_IN_SEC = 4; // time for viewers' next refresh to pick the conversation up
export const MAX_LINE_CHARS = 180;

/** Seconds a line stays on screen: enough to read it comfortably. */
export function lineSeconds(text: string): number {
  return Math.min(10, Math.max(2.4, 1.6 + text.length * 0.055));
}

export interface TimedLine {
  speaker: "a" | "b";
  text: string;
  action: string;
  at: number; // seconds after talk_at
  dur: number;
}

/** Adds start offsets and durations to each line (with a short beat between speakers). */
export function timeLines(lines: Array<{ speaker: "a" | "b"; text: string; action?: string }>): { lines: TimedLine[]; talkSec: number } {
  let t = 0;
  const out: TimedLine[] = [];
  lines.forEach((l, i) => {
    const text = cleanLine(l.text);
    if (!text) return;
    const dur = lineSeconds(text);
    const gap = i === 0 ? 0 : l.speaker === out[out.length - 1]?.speaker ? 0.3 : 0.6;
    t += gap;
    out.push({ speaker: l.speaker, text, action: cleanAction(l.action ?? ""), at: Math.round(t * 10) / 10, dur });
    t += dur;
  });
  return { lines: out, talkSec: Math.ceil(t + 1) };
}

export function cleanLine(raw: string): string {
  let s = String(raw ?? "")
    .replace(/\s+/g, " ")
    .replace(/#\w+/g, "")
    .trim();
  if (s.length > MAX_LINE_CHARS) s = `${s.slice(0, MAX_LINE_CHARS - 1).replace(/\s+\S*$/, "")}…`;
  return s;
}

function cleanAction(raw: string): string {
  return String(raw ?? "")
    .replace(/[*()[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

/** Picks who talks to whom: favours pairs that haven't met (or not lately), with some randomness. */
export function pickPair(
  ids: string[],
  lastMet: Map<string, number>, // pairKey → ms timestamp
  busy: Set<string>,
  now: number,
  rand: () => number = Math.random,
): [string, string] | null {
  const free = ids.filter((id) => !busy.has(id));
  if (free.length < 2) return null;
  let best: [string, string] | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < free.length; i++) {
    for (let j = i + 1; j < free.length; j++) {
      const met = lastMet.get(pairKey(free[i]!, free[j]!));
      const hoursSince = met === undefined ? 48 : (now - met) / 3_600_000;
      // Recent meetings score low; strangers and old friends score high; randomness keeps it lively.
      const score = Math.min(hoursSince, 48) / 48 + rand() * 0.9 - (hoursSince < 0.25 ? 2 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = rand() < 0.5 ? [free[i]!, free[j]!] : [free[j]!, free[i]!];
      }
    }
  }
  return best;
}

export const pairKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);
