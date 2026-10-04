import { useState } from "react";
import type { AppConfig, ContentSettings, Format, Persona, Strategy, TreasurySettings } from "./api";
import { ChipChoice, Field } from "./components";

export const defaultPersona = (): Persona => ({
  personality: null,
  personalityCustom: "",
  objective: null,
  objectiveCustom: "",
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
  postsPerDay: 1,
  reelsPerWeek: 1,
  autoPublish: true,
  hashtags: [],
});

export const defaultTreasury = (): TreasurySettings => ({
  enabled: false,
  strategy: "hold",
  maxSolPerAction: 0.05,
  maxSolPerDay: 0.2,
  reserveSol: 0.05,
  dipPct: 15,
  intervalMin: 60,
  burnBought: false,
  postAboutActions: true,
});

export function strategyFor(objective: string | null): Strategy {
  if (objective === "buy_back_on_dips") return "dip_buyback";
  if (objective === "steady_buybacks") return "steady_buyback";
  if (objective === "deflation" || objective === "buy_and_burn") return "buy_and_burn";
  return "hold";
}

function TagInput({ value, onChange, max, placeholder, prefix = "" }: { value: string[]; onChange: (v: string[]) => void; max: number; placeholder: string; prefix?: string }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const t = draft.trim().replace(/^#/, "");
    if (t && !value.includes(t) && value.length < max) onChange([...value, t]);
    setDraft("");
  };
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
          onChange={(e) => setDraft(e.target.value)}
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
      <div className="editor-cols">
        <div>
          <h3 className="sub">Personality</h3>
          <p className="sub-hint">Who it is.</p>
          <ChipChoice
            label="Personality"
            options={config.catalog.personalities}
            value={value.personality}
            onChange={(v) => set("personality", v)}
            custom={value.personalityCustom}
            onCustom={(v) => set("personalityCustom", v)}
            customPlaceholder="A retired space pirate who speaks only in sea shanties"
          />
        </div>
        <div>
          <h3 className="sub">Objective</h3>
          <p className="sub-hint">What it works towards.</p>
          <ChipChoice
            label="Objective"
            options={config.catalog.objectives}
            value={value.objective}
            onChange={(v) => set("objective", v)}
            custom={value.objectiveCustom}
            onCustom={(v) => set("objectiveCustom", v)}
            customPlaceholder="Map every coffee shop on the moon"
          />
        </div>
      </div>

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
        <Field label="Voice" hint="Optional. How it talks: emoji use, slang, sentence length.">
          <textarea className="input" rows={4} maxLength={400} value={value.voice} onChange={(e) => set("voice", e.target.value)} />
        </Field>
        <Field label="Recurring themes" hint="Up to 10. Press Enter after each.">
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

const FORMAT_LABELS: Record<Format, [string, string]> = {
  image: ["Image posts", "A single image with a caption."],
  carousel: ["Carousels", "Three to five images telling a short story."],
  reel: ["Reels", "Five-second AI video clips. These cost the most to make, so they're capped per week."],
};

export function ContentEditor({ value, onChange, config }: { value: ContentSettings; onChange: (c: ContentSettings) => void; config: AppConfig }) {
  const set = <K extends keyof ContentSettings>(k: K, v: ContentSettings[K]) => onChange({ ...value, [k]: v });
  const toggle = (f: Format) => {
    const has = value.formats.includes(f);
    if (has && value.formats.length === 1) return;
    set("formats", has ? value.formats.filter((x) => x !== f) : [...value.formats, f]);
  };
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
        <Field label="Posts per day">
          <select className="input" value={value.postsPerDay} onChange={(e) => set("postsPerDay", Number(e.target.value))}>
            {Array.from({ length: config.limits.maxPostsPerDay }, (_, i) => i + 1).map((n) => (
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
          <TagInput value={value.hashtags} onChange={(v) => set("hashtags", v)} max={8} placeholder="memecoin" prefix="#" />
        </Field>
      </div>
      <label className="switch">
        <input type="checkbox" checked={!value.autoPublish} onChange={(e) => set("autoPublish", !e.target.checked)} />
        <span>
          <strong>Review posts before they go live</strong>
          <small>New posts wait on your coin page until you approve them. Off means the character posts on its own.</small>
        </span>
      </label>
    </div>
  );
}

const STRATEGIES: Record<Strategy, [string, string]> = {
  hold: ["Hold", "Collect creator fees into the treasury and never trade."],
  dip_buyback: ["Buy back on dips", "Buy when the price falls a set percentage below its 24-hour high."],
  steady_buyback: ["Steady buybacks", "Buy small amounts on a regular schedule."],
  buy_and_burn: ["Buy and burn", "Buy on a schedule, then burn every coin it bought."],
};

export function TreasuryEditor({ value, onChange, config }: { value: TreasurySettings; onChange: (t: TreasurySettings) => void; config: AppConfig }) {
  const set = <K extends keyof TreasurySettings>(k: K, v: TreasurySettings[K]) => onChange({ ...value, [k]: v });
  const num = (k: keyof TreasurySettings, step: number, min: number, max: number) => (
    <input
      className="input"
      type="number"
      step={step}
      min={min}
      max={max}
      value={value[k] as number}
      onChange={(e) => set(k, Number(e.target.value) as never)}
    />
  );
  return (
    <div className="editor">
      <p className="sub-hint">
        Each coin gets its own agent wallet, set as the coin's creator on pump.fun, so creator fees flow into it. The agent can
        only spend within the limits below, and the platform caps every coin at {config.limits.treasuryMaxSolPerAction} SOL per
        trade and {config.limits.treasuryMaxSolPerDay} SOL per day. Nobody can withdraw from the treasury, including you.
      </p>
      <label className="switch">
        <input type="checkbox" checked={value.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        <span>
          <strong>Let the agent trade</strong>
          <small>Off means fees still collect in the treasury, but it never buys or burns.</small>
        </span>
      </label>
      {value.enabled && (
        <>
          <div className="format-options">
            {(Object.keys(STRATEGIES) as Strategy[]).map((s) => (
              <label key={s} className={value.strategy === s ? "option on" : "option"}>
                <input type="radio" name="strategy" checked={value.strategy === s} onChange={() => set("strategy", s)} />
                <span>
                  <strong>{STRATEGIES[s][0]}</strong>
                  <small>{STRATEGIES[s][1]}</small>
                </span>
              </label>
            ))}
          </div>
          {value.strategy !== "hold" && (
            <div className="grid-3">
              <Field label="Most SOL per trade">{num("maxSolPerAction", 0.01, 0.001, 10)}</Field>
              <Field label="Most SOL per day">{num("maxSolPerDay", 0.01, 0.001, 50)}</Field>
              <Field label="Always keep (SOL)" hint="Never spends below this.">
                {num("reserveSol", 0.01, 0, 1000)}
              </Field>
              <Field label="Minutes between trades">{num("intervalMin", 15, 15, 1440)}</Field>
              {value.strategy === "dip_buyback" && <Field label="Dip size (%)">{num("dipPct", 1, 5, 80)}</Field>}
            </div>
          )}
          {value.strategy !== "buy_and_burn" && value.strategy !== "hold" && (
            <label className="switch">
              <input type="checkbox" checked={value.burnBought} onChange={(e) => set("burnBought", e.target.checked)} />
              <span>
                <strong>Burn what it buys</strong>
                <small>Bought coins are destroyed instead of held.</small>
              </span>
            </label>
          )}
          <label className="switch">
            <input type="checkbox" checked={value.postAboutActions} onChange={(e) => set("postAboutActions", e.target.checked)} />
            <span>
              <strong>Post about treasury trades</strong>
              <small>Used when the objective is Open book, Radical transparency or Holder confidence.</small>
            </span>
          </label>
        </>
      )}
    </div>
  );
}
