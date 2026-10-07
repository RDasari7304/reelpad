import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { humanize, shortAddr, type Coin } from "./api";

/** A coin shown as an instant-photo print: the influencer's latest post, handle written underneath. */
export function CoinPrint({ coin, tilt = 0 }: { coin: Coin; tilt?: number }) {
  return (
    <Link to={`/coin/${coin.mint ?? coin.id}`} className="print" style={{ ["--tilt" as string]: `${tilt}deg` }}>
      <div className="print-photo">
        <img src={coin.lastImage ?? coin.imageUrl} alt="" loading="lazy" />
        <img className="print-avatar" src={coin.imageUrl} alt="" loading="lazy" />
      </div>
      <div className="print-caption">
        <strong>{coin.name}</strong>
        <span className="print-ticker">${coin.symbol}</span>
        <span className="print-handle">{coin.tiktok ? `@${coin.tiktok.username}` : "TikTok not connected yet"}</span>
        {coin.tiktok && <NextPostCountdown coin={coin} compact />}
      </div>
    </Link>
  );
}

/** Single-choice chip group with an optional "Custom" chip that reveals a text box. */
export function ChipChoice({
  options,
  value,
  onChange,
  custom,
  onCustom,
  customPlaceholder,
  allowNone = true,
  label,
}: {
  options: Record<string, string>;
  value: string | null;
  onChange: (v: string | null) => void;
  custom?: string;
  onCustom?: (v: string) => void;
  customPlaceholder?: string;
  allowNone?: boolean;
  label: string;
}) {
  const selected = value ? (value === "custom" ? customPlaceholder ?? "Your own words" : options[value]) : null;
  return (
    <div className="chip-choice">
      <div className="chips" role="radiogroup" aria-label={label}>
        {Object.keys(options).map((k) => (
          <button
            type="button"
            key={k}
            role="radio"
            aria-checked={value === k}
            className={value === k ? "chip on" : "chip"}
            onClick={() => onChange(value === k && allowNone ? null : k)}
          >
            {humanize(k)}
          </button>
        ))}
        {onCustom && (
          <button
            type="button"
            role="radio"
            aria-checked={value === "custom"}
            className={value === "custom" ? "chip chip-custom on" : "chip chip-custom"}
            onClick={() => onChange(value === "custom" && allowNone ? null : "custom")}
          >
            Custom
          </button>
        )}
      </div>
      {value === "custom" && onCustom ? (
        <textarea
          className="input"
          rows={2}
          maxLength={400}
          value={custom}
          placeholder={customPlaceholder}
          onChange={(e) => onCustom(e.target.value)}
          aria-label={`Custom ${label.toLowerCase()}`}
        />
      ) : (
        <p className="chip-hint">{selected ?? "Optional. Pick one, or write your own with Custom."}</p>
      )}
    </div>
  );
}

export function Field({ label, hint, children, error }: { label: string; hint?: string; children: ReactNode; error?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Address({ value, href }: { value: string; href?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="address">
      {href ? (
        <a href={href} target="_blank" rel="noreferrer">
          {shortAddr(value)}
        </a>
      ) : (
        <code>{shortAddr(value)}</code>
      )}
      <button
        type="button"
        className="copy"
        onClick={() => {
          navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "error" | "ok" | "warn"; children: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

/** Current time, re-rendered every `ms` milliseconds. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** 3725000 → "1:02:05", 65000 → "1:05". */
export function formatCountdown(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * Live countdown to the character's next scheduled post. Shows "Posting now" while a post is being
 * made, "Paused" when posting is off, and calls `onDue` once when the timer reaches zero.
 */
export function NextPostCountdown({
  coin,
  making = false,
  onDue,
  compact = false,
}: {
  coin: Coin;
  making?: boolean;
  onDue?: () => void;
  compact?: boolean;
}) {
  const now = useNow(1000);
  const target = coin.nextPostAt ? new Date(coin.nextPostAt).getTime() : null;
  const left = target === null ? null : target - now;
  const fired = useRef<number | null>(null);
  useEffect(() => {
    if (left !== null && left <= 0 && onDue && fired.current !== target) {
      fired.current = target;
      onDue();
    }
  }, [left, onDue, target]);

  if (coin.status !== "live") return null;
  let label: string;
  let state: "counting" | "now" | "paused";
  if (coin.contentPaused) {
    label = "Paused";
    state = "paused";
  } else if (making) {
    label = "Posting now";
    state = "now";
  } else if (left === null || left <= 0) {
    label = "Any moment";
    state = "now";
  } else {
    label = formatCountdown(left);
    state = "counting";
  }

  if (compact) {
    return (
      <span className={`countdown-chip ${state}`} title="Time until this character's next post">
        <span className="countdown-dot" aria-hidden />
        {state === "counting" ? `Next post ${label}` : label}
      </span>
    );
  }
  return (
    <div className={`countdown ${state}`} role="timer" aria-live="off">
      <span className="countdown-dot" aria-hidden />
      <span className="countdown-text">
        <small>{state === "counting" ? `${coin.name} posts again in` : state === "paused" ? "Posting is" : `${coin.name} is`}</small>
        <strong>{state === "counting" ? label : state === "paused" ? "Paused" : making ? "Posting now" : "About to post"}</strong>
      </span>
      {target && state === "counting" && (
        <time className="countdown-at" dateTime={new Date(target).toISOString()}>
          around {new Date(target).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </time>
      )}
    </div>
  );
}
