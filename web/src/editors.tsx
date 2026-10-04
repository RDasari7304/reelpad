import { useState } from "react";
import { humanize, type AppConfig, type ContentSettings, type Format, type Persona } from "./api";
import { ChipChoice, Field } from "./components";

export const defaultPersona = (): Persona => ({
  personality: null,
  personalityCustom: "",
  backstory: "",
  voice: "",
  visualStyle: "3d_render",
  visualStyleCustom: "",
  themes: [],
  avoid: "",
  language: "English",
});

export const defaultContent = (): ContentSettings => ({
  formats: ["image", "carousel"],
  postsPerDay: 12,
  reelsPerWeek: 3,
  autoPublish: true,
  hashtags: [],
  postAboutBurns: true,
  commentReplies: true,
  commentRepliesPerDay: 40,
});

function TagInput({
  value,
  onChange,
  max,
  placeholder,
  prefix = "",
  maxLen = 60,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  max: number;
  placeholder: string;
  prefix?: string;
  maxLen?: number;
}) {
  const [draft, setDraft] = useState("");
  /** Adds one or more tags (a pasted list is split on new lines and commas), skipping duplicates. */
  const addMany = (text: string) => {
    const next = [...value];
    for (const raw of text.split(/[\n\r,]+/)) {
      const t = raw.trim().replace(/^#/, "").slice(0, maxLen).trim();
      if (t && !next.includes(t) && next.length < max) next.push(t);
    }
    if (next.length !== value.length) onChange(next);
    setDraft("");
  };
  const add = () => addMany(draft);
  return (
    <div className="tags">
      {value.map((t) => (
        <button type="button" key={t} className="tag" onClick={() => onChange(value.filter((x) => x !== t))} aria-label={`Remove ${t}`}>
          {prefix}
          {t} <span aria-hidden>×</span>
        </button>
      ))}
      {value.length < max && (
        <input
          className="tag-input"
          value={draft}
          placeholder={placeholder}
          maxLength={maxLen}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (/[\n\r,]/.test(text)) {
              e.preventDefault();
              addMany(draft + text);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
        />
      )}
    </div>
  );
}

export function PersonaEditor({ value, onChange, config }: { value: Persona; onChange: (p: Persona) => void; config: AppConfig }) {
  const set = <K extends keyof Persona>(k: K, v: Persona[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="editor">
      <h3 className="sub">Personality</h3>
      <p className="sub-hint">Who your coin's character is on Instagram.</p>
      <ChipChoice
        label="Personality"
        options={config.catalog.personalities}
        value={value.personality}
        onChange={(v) => set("personality", v)}
        custom={value.personalityCustom}
        onCustom={(v) => set("personalityCustom", v)}
        customPlaceholder="A retired space pirate who speaks only in sea shanties"
      />

      <h3 className="sub">Look</h3>
      <p className="sub-hint">Every post uses your token image as the character reference, drawn in this style.</p>
      <ChipChoice
        label="Visual style"
        allowNone={false}
        options={config.catalog.visualStyles}
        value={value.visualStyle}
        onChange={(v) => set("visualStyle", v ?? "3d_render")}
        custom={value.visualStyleCustom}
        onCustom={(v) => set("visualStyleCustom", v)}
        customPlaceholder="Ukiyo-e woodblock print, muted indigo and rust"
      />

      <div className="grid-2">
        <Field label="Backstory" hint="Optional. Where it came from, what it loves, its running jokes.">
          <textarea className="input" rows={4} maxLength={1500} value={value.backstory} onChange={(e) => set("backstory", e.target.value)} />
        </Field>
        <Field label="Voice" hint="Optional. How it talks, in captions and out loud in Reels: tone, accent, pace, slang.">
          <textarea className="input" rows={4} maxLength={400} value={value.voice} onChange={(e) => set("voice", e.target.value)} />
        </Field>
        <Field label="Recurring themes" hint="Up to 10, each up to 60 characters. Press Enter after each, or paste a list.">
          <TagInput value={value.themes} onChange={(v) => set("themes", v)} max={10} placeholder="space, naps, jazz" />
        </Field>
        <Field label="Never post about" hint="Optional. Topics the character must avoid.">
          <input className="input" maxLength={600} value={value.avoid} onChange={(e) => set("avoid", e.target.value)} />
        </Field>
        <Field label="Caption language">
          <input className="input" maxLength={40} value={value.language} onChange={(e) => set("language", e.target.value)} />
        </Field>
      </div>
    </div>
  );
}

const formatLabels = (config: AppConfig): Record<Format, [string, string]> => {
  const secs = config.reels?.seconds ?? 5;
  return {
    image: ["Image posts", "A single image with a caption."],
    carousel: ["Carousels", "Three to five images telling a short story."],
    reel: [
      "Reels",
      config.reels?.audio === false
        ? `${secs}-second AI video clips. These cost the most to make, so they're capped per week.`
        : `${secs}-second AI videos with sound, where your character talks to the camera. These cost the most to make, so they're capped per week.`,
    ],
  };
};

export function ContentEditor({ value, onChange, config }: { value: ContentSettings; onChange: (c: ContentSettings) => void; config: AppConfig }) {
  const set = <K extends keyof ContentSettings>(k: K, v: ContentSettings[K]) => onChange({ ...value, [k]: v });
  const toggle = (f: Format) => {
    const has = value.formats.includes(f);
    if (has && value.formats.length === 1) return;
    set("formats", has ? value.formats.filter((x) => x !== f) : [...value.formats, f]);
  };
  const FORMAT_LABELS = formatLabels(config);
  return (
    <div className="editor">
      <div className="format-options">
        {(Object.keys(FORMAT_LABELS) as Format[]).map((f) => (
          <label key={f} className={value.formats.includes(f) ? "option on" : "option"}>
            <input type="checkbox" checked={value.formats.includes(f)} onChange={() => toggle(f)} />
            <span>
              <strong>{FORMAT_LABELS[f][0]}</strong>
              <small>{FORMAT_LABELS[f][1]}</small>
            </span>
          </label>
        ))}
      </div>
      <div className="grid-2">
        <Field label="Posts per day" hint="The first post (a Reel, if Reels are on) starts as soon as Instagram is connected.">
          <select className="input" value={value.postsPerDay} onChange={(e) => set("postsPerDay", Number(e.target.value))}>
            {Array.from(
              { length: config.limits.maxPostsPerDay - (config.limits.minPostsPerDay ?? 1) + 1 },
              (_, i) => i + (config.limits.minPostsPerDay ?? 1),
            ).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        {value.formats.includes("reel") && (
          <Field label="Reels per week, at most">
            <select className="input" value={value.reelsPerWeek} onChange={(e) => set("reelsPerWeek", Number(e.target.value))}>
              {Array.from({ length: config.limits.maxReelsPerWeek + 1 }, (_, i) => i).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Hashtags on every post" hint="Up to 8. Your ticker is always added.">
          <TagInput value={value.hashtags} onChange={(v) => set("hashtags", v)} max={8} placeholder="memecoin" prefix="#" maxLen={40} />
        </Field>
      </div>
      <label className="switch">
        <input type="checkbox" checked={!value.autoPublish} onChange={(e) => set("autoPublish", !e.target.checked)} />
        <span>
          <strong>Review posts before they go live</strong>
          <small>New posts wait on your coin page until you approve them. Off means the character posts on its own.</small>
        </span>
      </label>
      <label className="switch">
        <input
          type="checkbox"
          checked={value.postAboutBurns !== false}
          onChange={(e) => set("postAboutBurns", e.target.checked)}
        />
        <span>
          <strong>Post about buybacks and burns</strong>
          <small>At most once a day, the character posts about the latest buyback and burn, using the real numbers.</small>
        </span>
      </label>
      <label className="switch">
        <input
          type="checkbox"
          checked={value.commentReplies !== false}
          onChange={(e) => set("commentReplies", e.target.checked)}
        />
        <span>
          <strong>Reply to comments</strong>
          <small>
            The character reads every comment but only answers the ones it finds interesting: real questions, funny or
            creative comments, people picking up on its story, and anyone talking back to it. Generic hype, spam and
            trolls are skipped.
          </small>
        </span>
      </label>
      {value.commentReplies !== false && (
        <div className="grid-2">
          <Field label="Comment replies per day, at most" hint="Replies go out gradually, at most a dozen an hour.">
            <select
              className="input"
              value={value.commentRepliesPerDay ?? 40}
              onChange={(e) => set("commentRepliesPerDay", Number(e.target.value))}
            >
              {[10, 20, 40, 60, 100, 150].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
    </div>
  );
}

/** Read-only explanation of the automatic buyback-and-burn treasury (nothing to configure). */
export function TreasuryExplainer({ config }: { config: AppConfig }) {
  const l = config.limits;
  return (
    <div className="editor treasury-explainer">
      <ol className="burn-cycle">
        <li>
          <strong>Fees come in.</strong> Your coin gets its own agent wallet, set as the coin's creator on pump.fun, so
          every trade's creator fee goes to it.
        </li>
        <li>
          <strong>It buys the coin back.</strong> Once at least {l.treasuryMinBuySol} SOL in fees has collected, the agent
          spends it buying your coin, at most once every {l.treasuryBuyIntervalMin} minutes.
        </li>
        <li>
          <strong>It burns what it bought.</strong> Every coin the agent buys back is burned straight away, permanently
          reducing the supply.
        </li>
      </ol>
      <p className="sub-hint">
        It runs on its own for as long as the coin trades. Each buyback is capped at {l.treasuryMaxSolPerAction} SOL and{" "}
        {l.treasuryMaxSolPerDay} SOL a day; extra fees carry over. Nobody can withdraw from the treasury, including you, and
        every buyback and burn is listed publicly on the coin's Treasury tab.
      </p>
    </div>
  );
}

/** Read-only view of a launched coin's character. It's locked after launch so the influencer stays consistent. */
export function PersonaSummary({ persona, config }: { persona: Persona; config: AppConfig }) {
  const personality =
    persona.personality === "custom"
      ? persona.personalityCustom
      : persona.personality
        ? `${humanize(persona.personality)}. ${config.catalog.personalities[persona.personality] ?? ""}`
        : "";
  const look =
    persona.visualStyle === "custom" ? persona.visualStyleCustom : humanize(persona.visualStyle || "3d_render");
  const rows: Array<[string, string]> = [
    ["Personality", personality],
    ["Look", look],
    ["Backstory", persona.backstory],
    ["Voice", persona.voice],
    ["Recurring themes", (persona.themes ?? []).join(", ")],
    ["Never posts about", persona.avoid],
    ["Caption language", persona.language || "English"],
  ];
  return (
    <div className="editor persona-locked">
      <p className="sub-hint">Locked after launch, so your character stays consistent from post to post.</p>
      <dl className="locked-list">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value?.trim() ? value : <span className="muted">Not set</span>}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
