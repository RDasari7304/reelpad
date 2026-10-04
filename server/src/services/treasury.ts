import { createBurnCheckedInstruction } from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import { config } from "../config.js";
import { enqueue } from "../db/jobs.js";
import { one, query } from "../db/pool.js";
import { friendlyTradeError } from "../domain/tradeErrors.js";
import { decideBuyback, splitBuyback } from "../domain/treasuryPolicy.js";
import { logger } from "../lib/logger.js";
import { openKeypair } from "../lib/secrets.js";
import { getCoin, type CoinRow } from "./coins.js";
import { nativeSymbol } from "./chart.js";
import { agentCollectCreatorFees } from "./pumpportal.js";
import { buyToken } from "./trade.js";
import { getKillSwitch } from "./settings.js";
import {
  connection,
  getPriceSol,
  getSolBalance,
  getTokenBalance,
  PUMP_PROGRAM_ID,
  signAndSendLegacy,
  sol,
} from "./solana.js";

async function record(
  coinId: string,
  a: { kind: string; status: string; reason: string; sol?: number; tokens?: string; sig?: string; dryRun?: boolean; mint?: string | null },
) {
  await query(
    `INSERT INTO treasury_actions(coin_id, kind, status, reason, sol_amount, token_amount, tx_sig, dry_run, mint)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [coinId, a.kind, a.status, a.reason.slice(0, 500), a.sol ?? null, a.tokens ?? null, a.sig ?? null, a.dryRun ?? false, a.mint ?? null],
  );
}

function creatorVaultPda(creator: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creator.toBuffer()], PUMP_PROGRAM_ID)[0];
}

async function maybeClaimFees(coin: CoinRow, graduated: boolean) {
  const agent = openKeypair(coin.agent_secret_enc);
  const vaultLamports = await connection.getBalance(creatorVaultPda(agent.publicKey), "confirmed");
  const rentFloor = 890_880; // rent-exempt minimum for a zero-data account
  const claimable = sol(Math.max(0, vaultLamports - rentFloor));

  let shouldClaim = claimable >= 0.003;
  if (!shouldClaim && graduated) {
    // After graduation fees accrue in PumpSwap; claim at most every 6 hours.
    const last = await one(
      `SELECT 1 FROM treasury_actions WHERE coin_id = $1 AND kind = 'claim_fees' AND created_at > now() - interval '6 hours'`,
      [coin.id],
    );
    shouldClaim = !last;
  }
  if (!shouldClaim) return;

  try {
    const before = await getSolBalance(agent.publicKey);
    const sig = await agentCollectCreatorFees(agent);
    const after = await getSolBalance(agent.publicKey);
    await record(coin.id, {
      kind: "claim_fees",
      status: "done",
      sol: Math.max(0, after - before),
      sig,
      reason: "Collected pump.fun creator fees into the treasury.",
    });
  } catch (e) {
    const msg = (e as Error).message;
    // "nothing to claim" style errors are expected after graduation; don't spam the log with failures.
    if (!graduated) await record(coin.id, { kind: "claim_fees", status: "failed", reason: msg });
    logger.warn({ coinId: coin.id, err: msg }, "fee claim failed");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Burns every coin the agent wallet holds. Runs after each buyback, and on every run in case an
 * earlier burn failed, so bought-back coins never sit in the treasury.
 */
async function burnAll(coin: CoinRow, reason: string, expectTokens = false, target: string = coin.mint!) {
  const agent = openKeypair(coin.agent_secret_enc);
  const mint = new PublicKey(target);
  const tag = target === coin.mint ? null : target; // native-coin rows are tagged with its mint
  let bal = await getTokenBalance(agent.publicKey, mint);
  // Right after a buy the RPC can briefly report the old balance; give it a few seconds.
  for (let i = 0; expectTokens && bal.raw === 0n && i < 8; i++) {
    await sleep(2500);
    bal = await getTokenBalance(agent.publicKey, mint);
  }
  if (bal.raw === 0n || bal.accounts.length === 0) return null;
  const mintInfo = await connection.getAccountInfo(mint, "confirmed");
  if (!mintInfo) throw new Error("Mint account not found");
  // Burn from every token account the agent holds (normally one), using the mint's own token program.
  const tx = new Transaction();
  for (const a of bal.accounts) {
    tx.add(createBurnCheckedInstruction(a.pubkey, mint, agent.publicKey, a.raw, bal.decimals, [], mintInfo.owner));
  }
  try {
    const sig = await signAndSendLegacy(tx, [agent]);
    await record(coin.id, { kind: "burn", status: "done", tokens: bal.ui.toString(), sig, reason, mint: tag });
    return bal.ui;
  } catch (e) {
    await record(coin.id, { kind: "burn", status: "failed", tokens: bal.ui.toString(), reason: friendlyTradeError((e as Error).message), mint: tag });
    throw e;
  }
}

/** Queues a post about the latest buyback and burn, at most once a day per coin. */
async function maybePostAboutBurn(coin: CoinRow, note: string) {
  if (coin.content_settings.postAboutBurns === false) return;
  const recent = await one(
    `SELECT 1 FROM posts WHERE coin_id = $1 AND trigger = 'treasury' AND created_at > now() - interval '24 hours'`,
    [coin.id],
  );
  if (recent) return;
  await enqueue("content.plan", { coinId: coin.id, trigger: "treasury", note }, { dedupeKey: `plan:${coin.id}`, maxAttempts: 2 });
}

/**
 * One treasury cycle for a coin: record the price, claim creator fees, then spend ALL fees above the
 * gas reserve on buybacks (split between the coin and the platform's native coin) and burn everything bought.
 */
export async function runTreasury(coinId: string) {
  const kill = await getKillSwitch();
  const coin = await getCoin(coinId);
  if (!coin || coin.status !== "live" || !coin.mint) return;
  await query(`UPDATE coins SET last_treasury_run_at = now() WHERE id = $1`, [coinId]);

  const mint = new PublicKey(coin.mint);
  const price = await getPriceSol(mint);
  if (price) {
    await query(`INSERT INTO price_snapshots(coin_id, price_sol, graduated) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
      coinId,
      price.priceSol,
      price.graduated,
    ]);
  }

  // Admin emergency stop (platform-wide) or admin pause for this coin.
  if (kill.treasury || coin.treasury_paused) return;

  await maybeClaimFees(coin, price?.graduated ?? false);

  const dryRun = config.TREASURY_DRY_RUN;
  const native = config.NATIVE_COIN_MINT && config.NATIVE_COIN_MINT !== coin.mint ? config.NATIVE_COIN_MINT : null;
  // Leftovers from an earlier run whose burn failed are burned first.
  if (!dryRun) {
    await burnAll(coin, "Burned coins left from an earlier buyback.").catch((e) =>
      logger.warn({ coinId, err: (e as Error).message }, "leftover burn failed"),
    );
    if (native) {
      await burnAll(coin, "Burned native coins left from an earlier buyback.", false, native).catch((e) =>
        logger.warn({ coinId, err: (e as Error).message }, "leftover native burn failed"),
      );
    }
  }

  const agent = openKeypair(coin.agent_secret_enc);
  const counted = dryRun ? ["done", "simulated"] : ["done"];
  const [balance, lastBuy, spent] = await Promise.all([
    getSolBalance(agent.publicKey),
    one<{ created_at: Date }>(
      `SELECT created_at FROM treasury_actions WHERE coin_id = $1 AND kind = 'buy' AND status = ANY($2)
       ORDER BY created_at DESC LIMIT 1`,
      [coinId, counted],
    ),
    one<{ own: string | null; nat: string | null }>(
      `SELECT sum(sol_amount) FILTER (WHERE mint IS NULL)::text AS own, sum(sol_amount) FILTER (WHERE mint IS NOT NULL)::text AS nat
       FROM treasury_actions WHERE coin_id = $1 AND kind = 'buy' AND status = 'done'`,
      [coinId],
    ),
  ]);

  const decision = decideBuyback({
    solBalance: balance,
    minutesSinceLastBuy: lastBuy ? (Date.now() - lastBuy.created_at.getTime()) / 60_000 : null,
    limits: {
      gasReserveSol: config.TREASURY_GAS_RESERVE_SOL,
      minBuySol: config.TREASURY_MIN_BUY_SOL,
      intervalMin: config.TREASURY_BUY_INTERVAL_MIN,
    },
  });

  // After a failed buy, wait before trying again instead of failing every check.
  const recentFail = await one(
    `SELECT 1 FROM treasury_actions WHERE coin_id = $1 AND kind = 'buy' AND status = 'failed'
       AND created_at > now() - ($2 || ' minutes')::interval`,
    [coinId, String(Math.min(config.TREASURY_BUY_INTERVAL_MIN, 30))],
  );
  if (decision.action === "skip" || recentFail) {
    logger.debug({ coinId, reason: decision.action === "skip" ? decision.reason : "waiting after a failed buy" }, "treasury skip");
    return;
  }

  // All the fees go to buybacks: a share to the platform's native coin, the rest to this coin.
  const split = splitBuyback({
    total: decision.sol,
    nativeShare: native ? config.NATIVE_BUYBACK_SHARE : 0,
    spentOwnSol: Number(spent?.own ?? 0),
    spentNativeSol: Number(spent?.nat ?? 0),
  });
  const nativeSym = native ? await nativeSymbol(native, config.NATIVE_COIN_SYMBOL) : "";

  if (dryRun) {
    if (split.own > 0) await record(coinId, { kind: "buy", status: "simulated", sol: split.own, reason: decision.reason, dryRun });
    if (split.native > 0) await record(coinId, { kind: "buy", status: "simulated", sol: split.native, reason: `Native $${nativeSym} buyback.`, dryRun, mint: native });
    return;
  }

  // Each side is independent: if one buy fails, the other still goes through.
  let ownBurned: number | null = null;
  let nativeBurned: number | null = null;
  let ownSol = 0;
  let nativeSol = 0;
  if (split.own > 0) {
    try {
      const bought = await buyToken(agent, mint, split.own, price?.graduated ?? false);
      ownSol = bought.sol;
      await record(coinId, {
        kind: "buy",
        status: "done",
        sol: bought.sol,
        sig: bought.sig,
        reason: `${decision.reason}${native ? ` ${Math.round((1 - config.NATIVE_BUYBACK_SHARE) * 100)}% goes to $${coin.symbol}.` : ""}`,
      });
      ownBurned = await burnAll(coin, "Burned the coins just bought back with creator fees.", true);
    } catch (e) {
      const raw = (e as Error).message;
      logger.warn({ coinId, err: raw }, "buyback failed");
      await record(coinId, { kind: "buy", status: "failed", sol: split.own, reason: friendlyTradeError(raw) });
    }
  }
  if (native && split.native > 0) {
    try {
      const nativeMint = new PublicKey(native);
      const np = await getPriceSol(nativeMint);
      const bought = await buyToken(agent, nativeMint, split.native, np?.graduated ?? true);
      nativeSol = bought.sol;
      await record(coinId, {
        kind: "buy",
        status: "done",
        sol: bought.sol,
        sig: bought.sig,
        mint: native,
        reason: `${Math.round(config.NATIVE_BUYBACK_SHARE * 100)}% of creator fees buy back the Reelpad native coin $${nativeSym}.`,
      });
      nativeBurned = await burnAll(coin, `Burned the $${nativeSym} just bought back.`, true, native);
    } catch (e) {
      const raw = (e as Error).message;
      logger.warn({ coinId, err: raw }, "native buyback failed");
      await record(coinId, { kind: "buy", status: "failed", sol: split.native, mint: native, reason: friendlyTradeError(raw) });
    }
  }

  if (ownBurned) {
    await maybePostAboutBurn(
      coin,
      `The treasury just used ${ownSol} SOL of creator fees to buy back ${Math.round(ownBurned).toLocaleString("en-US")} $${coin.symbol} and burned all of it.` +
        (nativeBurned ? ` Another ${nativeSol} SOL bought and burned ${Math.round(nativeBurned).toLocaleString("en-US")} of the Reelpad native coin $${nativeSym}.` : ""),
    );
  }
}

export async function scheduleTreasuryRuns() {
  const due = await query<{ id: string }>(
    `SELECT id FROM coins
     WHERE status = 'live' AND mint IS NOT NULL
       -- Dormant coins are checked every 6 hours instead (fees still get collected and burned, just less often).
       AND (last_treasury_run_at IS NULL OR last_treasury_run_at < now() - (CASE WHEN activity_state = 'dormant' THEN '360' ELSE $1 END || ' minutes')::interval)
     LIMIT 100`,
    [String(config.TREASURY_MIN_INTERVAL_MIN)],
  );
  for (const c of due.rows) {
    await enqueue("treasury.run", { coinId: c.id }, { dedupeKey: `treasury:${c.id}`, maxAttempts: 2 });
  }
}
