import { OBJECTIVES, PERSONALITIES, VISUAL_STYLES } from "./catalog.js";

/** Builds the persona brief shared by every content-planning prompt. Pure. */
export interface PersonaFields {
  personality?: string | null;
  personalityCustom?: string;
  objective?: string | null;
  objectiveCustom?: string;
  backstory?: string;
  voice?: string;
  visualStyle?: string;
  visualStyleCustom?: string;
  themes?: string[];
  avoid?: string;
  language?: string;
}

const pick = (map: Record<string, string>, key: string | null | undefined, custom?: string) =>
  key === "custom" ? (custom ?? "").trim() : key && key in map ? map[key]! : "";

export function visualStyleText(p: PersonaFields): string {
  return pick(VISUAL_STYLES, p.visualStyle ?? "3d_render", p.visualStyleCustom) || VISUAL_STYLES["3d_render"];
}

export function personaBrief(coin: { name: string; symbol: string; description: string }, p: PersonaFields): string {
  const lines = [
    `You are ${coin.name} ($${coin.symbol}), an AI character who is the face and influencer of the ${coin.symbol} coin on Instagram.`,
    coin.description ? `About the coin: ${coin.description}` : "",
    pick(PERSONALITIES, p.personality, p.personalityCustom) && `Personality: ${pick(PERSONALITIES, p.personality, p.personalityCustom)}`,
    pick(OBJECTIVES, p.objective, p.objectiveCustom) && `What you work towards: ${pick(OBJECTIVES, p.objective, p.objectiveCustom)}`,
    p.backstory?.trim() && `Backstory: ${p.backstory.trim()}`,
    p.voice?.trim() && `Voice and tone: ${p.voice.trim()}`,
    p.themes?.length ? `Recurring themes: ${p.themes.join(", ")}` : "",
    p.avoid?.trim() && `Never post about: ${p.avoid.trim()}`,
    `Visual style of your posts: ${visualStyleText(p)}`,
    `Write captions in ${p.language || "English"}.`,
  ];
  return lines.filter(Boolean).join("\n");
}

export const CONTENT_RULES = `Hard rules (never break these):
- Never give financial advice, predict prices, promise returns, or tell anyone to buy, hold or sell.
- No price targets, multipliers ("10x"), "guaranteed", "risk-free", or "get rich" language.
- You are openly an AI character; never claim to be a human or impersonate a real person or brand.
- No real people's likenesses, celebrities, logos, trademarks or copyrighted characters in image or video prompts.
- Nothing sexual, violent, hateful or harassing. Keep it fun, original and on-character.
- Treasury facts you mention must come from the context given to you; never invent numbers.`;
