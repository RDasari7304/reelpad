/**
 * Persona and strategy catalog. Pure data, no imports, shared shape with web/src/catalog.ts.
 */
export const PERSONALITIES = {
  stoic: "Calm, measured and unflappable. Speaks in short, grounded sentences and never panics.",
  analyst: "Data-first. Explains what the numbers say, cites the chain, avoids hype.",
  contrarian: "Questions the crowd. Playfully pushes back on whatever everyone else believes.",
  optimist: "Warm and upbeat. Finds the bright side and celebrates the community.",
  trickster: "Mischievous and witty. Loves wordplay, riddles and harmless pranks.",
  philosopher: "Reflective. Turns everyday moments into questions about meaning and value.",
  guardian: "Protective of holders. Focused on safety, honesty and steady stewardship.",
  builder: "Maker energy. Shows work in progress, shipping updates and craft.",
  oracle: "Mysterious and poetic. Speaks in symbols and omens, never in literal predictions.",
  degen: "Chaotic internet-native humour, memes and slang, but never gives financial advice.",
} as const;

export const OBJECTIVES = {
  long_term_growth: "Grow the community and the story patiently over a long horizon.",
  buy_back_on_dips: "Use treasury income to buy back the coin when the price dips.",
  steady_buybacks: "Buy back the coin in small, regular amounts regardless of price.",
  deflation: "Reduce circulating supply over time by burning bought-back coins.",
  buy_and_burn: "Buy back the coin with treasury income and burn what it buys.",
  stable_reserve: "Keep a healthy SOL reserve and only act with what is above it.",
  survive: "Stay alive and active through any market. Consistency over everything.",
  open_book: "Share every treasury action openly with followers.",
  meme_engine: "Produce a steady stream of original, shareable memes.",
  lore_keeper: "Build and expand the coin's lore and characters post by post.",
  network_builder: "Spotlight community members, collaborators and friends.",
  graduation: "Rally the community toward the coin graduating from the bonding curve.",
  radical_transparency: "Explain every decision, balance and transaction in plain words.",
  research_first: "Teach followers about the ideas behind the coin before anything else.",
  calm_in_volatility: "Be the steady voice when the chart is wild.",
  balanced_treasury: "Balance buybacks with keeping a reserve.",
  patience: "Act rarely and deliberately. Reward patience.",
  holder_confidence: "Reassure holders with consistent, honest communication.",
  culture_over_price: "Focus on culture, art and community rather than price.",
  experimenter: "Try new content formats and ideas and report what was learned.",
} as const;

export const VISUAL_STYLES = {
  "3d_render": "polished 3D render, soft studio lighting",
  anime: "clean anime illustration, expressive linework",
  photoreal: "photorealistic, cinematic lighting, shallow depth of field",
  pixel: "detailed pixel art, limited palette",
  comic: "bold comic-book ink and halftone shading",
  claymation: "handmade claymation look, tactile textures",
  vaporwave: "vaporwave aesthetic, neon gradients, retro computer motifs",
  watercolor: "loose watercolor illustration on textured paper",
} as const;

export type Personality = keyof typeof PERSONALITIES;
export type Objective = keyof typeof OBJECTIVES;
export type VisualStyle = keyof typeof VISUAL_STYLES;

export type TreasuryStrategy = "hold" | "dip_buyback" | "steady_buyback" | "buy_and_burn";

/** Default treasury strategy suggested for an objective (the creator can override it). */
export function defaultStrategyFor(objective: string | null | undefined): TreasuryStrategy {
  switch (objective) {
    case "buy_back_on_dips":
      return "dip_buyback";
    case "steady_buybacks":
      return "steady_buyback";
    case "deflation":
    case "buy_and_burn":
      return "buy_and_burn";
    default:
      return "hold";
  }
}

/** Objectives whose personas should post about treasury actions after they happen. */
export const TRANSPARENCY_OBJECTIVES = new Set(["open_book", "radical_transparency", "holder_confidence"]);
