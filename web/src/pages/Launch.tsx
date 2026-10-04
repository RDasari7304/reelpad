import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, humanize, normalizeInstagramUsername, type AppConfig, type Coin, type ContentSettings, type Persona } from "../api";
import { Field, Notice } from "../components";
import {
  ContentEditor,
  defaultContent,
  defaultPersona,
  PersonaEditor,
  TreasuryExplainer,
} from "../editors";
import { decodeTx, signAndLaunch } from "../launchTx";
import { useSession } from "../session";

type Stage = "idle" | "saving" | "building" | "signing" | "confirming" | "devbuy" | "done";

const STAGE_TEXT: Record<Stage, string> = {
  idle: "",
  saving: "Uploading image and saving your coin…",
  building: "Preparing the launch transaction…",
  signing: "Approve the transaction in your wallet…",
  confirming: "Launching on pump.fun. This usually takes a few seconds…",
  devbuy: "Approve your first buy in your wallet…",
  done: "Launched.",
};

function ProfilePreview(props: { name: string; symbol: string; description: string; image: string | null; persona: Persona; config: AppConfig }) {
  const { name, symbol, description, image, persona, config } = props;
  const handle = (name || "yourcoin").toLowerCase().replace(/[^a-z0-9_.]/g, "").slice(0, 24) || "yourcoin";
  const trait =
    persona.personality === "custom" ? persona.personalityCustom : persona.personality ? config.catalog.personalities[persona.personality] : "";
  const style = persona.visualStyle === "custom" ? persona.visualStyleCustom || "Custom style" : humanize(persona.visualStyle);
  return (
    <aside className="phone" aria-label="Instagram profile preview">
      <div className="phone-screen">
        <div className="ig-top">
          <span className="ig-handle">{handle}</span>
        </div>
        <div className="ig-head">
          <div className="ig-avatar">{image ? <img src={image} alt="" /> : <span>{symbol ? symbol[0] : "?"}</span>}</div>
          <dl className="ig-stats">
            <div>
              <dt>Posts</dt>
              <dd>0</dd>
            </div>
            <div>
              <dt>Followers</dt>
              <dd>0</dd>
            </div>
            <div>
              <dt>Following</dt>
              <dd>0</dd>
            </div>
          </dl>
        </div>
        <div className="ig-bio">
          <strong>{name || "Your coin"}</strong>
          <span className="ig-ticker">{symbol ? `$${symbol}` : "$TICKER"}</span>
          <p>{description || trait || "Your character's bio shows up here."}</p>
          <span className="ig-tag">AI character</span>
        </div>
        <div className="ig-grid">
          {Array.from({ length: 9 }, (_, i) => (
            <div key={i} className="ig-cell" style={image ? { backgroundImage: `url(${image})` } : undefined}>
              {i === 0 && <span>{style}</span>}
            </div>
          ))}
        </div>
      </div>
      <p className="phone-note">Preview. Connect the real Instagram account right after launch.</p>
    </aside>
  );
}

export default function Launch() {
  const { config, wallet: sessionWallet, signIn } = useSession();
  const { publicKey, signTransaction, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { setVisible } = useWalletModal();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [persona, setPersona] = useState<Persona>(defaultPersona);
  const [content, setContent] = useState<ContentSettings>(defaultContent);
  const [igUsername, setIgUsername] = useState("");
  const [devBuy, setDevBuy] = useState("0");
  const [accepted, setAccepted] = useState(false);

  const [coin, setCoin] = useState<Coin | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!file) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);


  const devBuySol = Number(devBuy) || 0;
  const total = useMemo(
    () => (config ? config.platformFeeSol + config.agentGasSol + devBuySol + 0.02 : 0),
    [config, devBuySol],
  );

  if (!config) return <div className="page narrow" aria-busy="true" />;

  const busy = stage !== "idle" && stage !== "done";
  const igValid = !igUsername.trim() || normalizeInstagramUsername(igUsername) !== null;
  const canSubmit = name.trim() && symbol.trim() && (file || coin) && accepted && igValid && !busy;

  async function launch() {
    setError(null);
    try {
      if (!publicKey) {
        setVisible(true);
        return;
      }
      if (!signTransaction) throw new Error("This wallet can't sign transactions.");
      if (sessionWallet !== publicKey.toBase58()) await signIn();

      let current = coin;
      if (!current) {
        setStage("saving");
        const form = new FormData();
        form.append("image", file!);
        form.append(
          "data",
          JSON.stringify({
            name,
            symbol,
            description,
            twitter: twitter || undefined,
            telegram: telegram || undefined,
            instagramUsername: igUsername.trim() || undefined,
            persona,
            contentSettings: content,
          }),
        );
        current = (await api<{ coin: Coin }>("/coins", { method: "POST", body: form })).coin;
        setCoin(current);
      }

      await signAndLaunch(current.id, signTransaction, setStage);

      if (devBuySol > 0) {
        try {
          setStage("devbuy");
          const r = await api<{ transaction: string }>(`/coins/${current.id}/dev-buy-tx`, { method: "POST", json: { sol: devBuySol } });
          const sig = await sendTransaction(decodeTx(r.transaction), connection);
          await connection.confirmTransaction(sig, "confirmed");
        } catch (e) {
          // The coin is live either way; the creator can buy on pump.fun.
          console.warn("dev buy failed", e);
        }
      }
      setStage("done");
      navigate(`/coin/${current.id}?launched=1`);
    } catch (e) {
      setStage("idle");
      const msg = e instanceof ApiError || e instanceof Error ? e.message : String(e);
      setError(/reject|declin|cancel/i.test(msg) ? "You cancelled in your wallet. Nothing was charged." : msg);
    }
  }

  return (
    <div className="page launch">
      <div className="launch-form">
        <h1>Launch a coin with a face</h1>
        <p className="lede">Everything except the name, ticker and image is optional and can be changed after launch.</p>

        <section className="step">
          <h2>
            <span className="step-n">1</span> Identity
          </h2>
          <div className="identity">
            <label className={preview ? "dropzone has-image" : "dropzone"}>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                disabled={!!coin}
              />
              {preview ? <img src={preview} alt="Token image" /> : <span>Add the token image. Square works best, up to 5 MB.</span>}
            </label>
            <div className="identity-fields">
              <Field label="Name">
                <input className="input" maxLength={32} value={name} onChange={(e) => setName(e.target.value)} disabled={!!coin} />
              </Field>
              <Field label="Ticker">
                <input
                  className="input ticker"
                  maxLength={10}
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase())}
                  disabled={!!coin}
                />
              </Field>
              <Field label="Description" hint="Shown on pump.fun and in the Instagram bio.">
                <textarea className="input" rows={3} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} disabled={!!coin} />
              </Field>
            </div>
          </div>
          <details className="more">
            <summary>Links</summary>
            <div className="grid-3">
              <Field label="Website" hint="Locked. Your coin's website is its own page on Reelpad.">
                <input className="input" value={coin?.mint ? `${window.location.origin}/coin/${coin.mint}` : `${window.location.origin}/coin/…`} readOnly disabled />
              </Field>
              <Field label="X">
                <input className="input" type="url" placeholder="https://x.com/…" value={twitter} onChange={(e) => setTwitter(e.target.value)} disabled={!!coin} />
              </Field>
              <Field label="Telegram">
                <input className="input" type="url" placeholder="https://t.me/…" value={telegram} onChange={(e) => setTelegram(e.target.value)} disabled={!!coin} />
              </Field>
            </div>
          </details>
        </section>

        <section className="step">
          <h2>
            <span className="step-n">2</span> Character
          </h2>
          <PersonaEditor value={persona} onChange={setPersona} config={config} />
        </section>

        <section className="step">
          <h2>
            <span className="step-n">3</span> Posting
          </h2>
          <div className="grid-2">
            <Field
              label="Instagram account"
              error={igValid ? undefined : "Use letters, numbers, periods and underscores (max 30)."}
              hint={
                config.igAccessMode === "testers"
                  ? "Optional. If you've already made the coin's Instagram (a Creator or Business account), enter it now so we can start giving it access. You can also add it after launch."
                  : "Optional. You'll log in with this account right after launch. It must be a Creator or Business account."
              }
            >
              <input
                className="input"
                value={igUsername}
                placeholder="@mooncat.coin"
                maxLength={31}
                autoCapitalize="off"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setIgUsername(e.target.value)}
                disabled={!!coin}
              />
            </Field>
          </div>
          <ContentEditor value={content} onChange={setContent} config={config} />
        </section>

        <section className="step">
          <h2>
            <span className="step-n">4</span> Buyback and burn
          </h2>
          <TreasuryExplainer config={config} />
          {config.treasuryDryRun && <Notice tone="warn">Buybacks are in simulation mode on this site right now: they're logged but not sent on-chain yet.</Notice>}
        </section>

        <section className="step">
          <h2>
            <span className="step-n">5</span> Launch
          </h2>
          <div className="grid-2">
            <Field label="Your first buy (SOL)" hint="Optional. Bought right after the coin is created, as a second approval.">
              <input className="input" type="number" min={0} step={0.1} value={devBuy} onChange={(e) => setDevBuy(e.target.value)} disabled={busy} />
            </Field>
          </div>
          <table className="costs">
            <tbody>
              <tr>
                <td>Platform fee</td>
                <td>{config.platformFeeSol} SOL</td>
              </tr>
              <tr>
                <td>Starting gas for the agent wallet</td>
                <td>{config.agentGasSol} SOL</td>
              </tr>
              <tr>
                <td>pump.fun creation and network fees</td>
                <td>about 0.02 SOL</td>
              </tr>
              {devBuySol > 0 && (
                <tr>
                  <td>Your first buy</td>
                  <td>{devBuySol} SOL</td>
                </tr>
              )}
              <tr className="costs-total">
                <td>Total, roughly</td>
                <td>{total.toFixed(3)} SOL</td>
              </tr>
            </tbody>
          </table>
          <label className="switch">
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
            <span>
              <strong>I understand</strong>
              <small>
                The coin is created on pump.fun from my wallet, its creator fees go to an AI-run treasury that automatically buys back and burns the coin, I can't withdraw from it, and
                the AI character posts publicly on the Instagram account I connect. I've read the Terms.
              </small>
            </span>
          </label>
          {error && <Notice tone="error">{error}</Notice>}
          {busy && <Notice>{STAGE_TEXT[stage]}</Notice>}
          <button className="btn btn-primary btn-big" onClick={launch} disabled={publicKey ? !canSubmit : false}>
            {!publicKey ? "Connect wallet to launch" : coin ? "Try launching again" : "Launch coin"}
          </button>
        </section>
      </div>
      <ProfilePreview name={name} symbol={symbol} description={description} image={preview} persona={persona} config={config} />
    </div>
  );
}
