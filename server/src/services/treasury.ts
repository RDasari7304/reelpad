import { createBurnCheckedInstruction } from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import { config } from "../config.js";
import { enqueue } from "../db/jobs.js";
import { one, query } from "../db/pool.js";
import { friendlyTradeError } from "../domain/tradeErrors.js";
import { decideBuyback } from "../domain/treasuryPolicy.js";
import { logger } from "../lib/logger.js";
import { openKeypair } from "../lib/secrets.js";
import { getCoin, type CoinRow } from "./coins.js";
import { agentBuy, agentCollectCreatorFees } from "./pumpportal.js";
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
  a: { kind: string; status: string; reason: string; sol?: number; tokens?: string; sig?: string; dryRun?: boolean },
) {
  await query(
    `INSERT INTO treasury_actions(coin_id, kind, status, reason, sol_amount, token_amount, tx_sig, dry_run)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [coinId, a.kind, a.status, a.reason.slice(0, 500), a.sol ?? null, a.tokens ?? null, a.sig ?? null, a.dryRun ?? false],
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
async function burnAll(coin: CoinRow, reason: string, expectTokens = false) {
  const agent = openKeypair(coin.agent_secret_enc);
  const mint = new PublicKey(coin.mint!);
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
    await record(coin.id, { kind: "burn", status: "done", tokens: bal.ui.toString(), sig, reason });
    return bal.ui;
  } catch (e) {
    await record(coin.id, { kind: "burn", status: "failed", tokens: bal.ui.toString(), reason: (e as Error).message });
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
 * One treasury cycle for a coin: record the price, claim creator fees, buy the coin back with the
 * fees (above the gas reserve, within platform caps), then burn everything bought.
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
  // Leftovers from an earlier run whose burn failed are burned first.
  if (!dryRun) await burnAll(coin, "Burned coins left from an earlier buyback.").catch((e) =>
    logger.warn({ coinId, err: (e as Error).message }, "leftover burn failed"),
  );

  const agent = openKeypair(coin.agent_secret_enc);
  // Simulated buys never count against live limits.
  const counted = dryRun ? ["done", "simulated"] : ["done"];
  const [balance, spent, lastBuy] = await Promise.all([
    getSolBalance(agent.publicKey),
    one<{ s: string | null }>(
      `SELECT sum(sol_amount)::text AS s FROM treasury_actions
       WHERE coin_id = $1 AND kind = 'buy' AND status = ANY($2) AND created_at > now() - interval '24 hours'`,
      [coinId, counted],
    ),
    one<{ created_at: Date }>(
      `SELECT created_at FROM treasury_actions WHERE coin_id = $1 AND kind = 'buy' AND status = ANY($2)
       ORDER BY created_at DESC LIMIT 1`,
      [coinId, counted],
    ),
  ]);

  const decision = decideBuyback({
    solBalance: balance,
    spentTodaySol: Number(spent?.s ?? 0),
    minutesSinceLastBuy: lastBuy ? (Date.now() - lastBuy.created_at.getTime()) / 60_000 : null,
    limits: {
      gasReserveSol: config.TREASURY_GAS_RESERVE_SOL,
      minBuySol: config.TREASURY_MIN_BUY_SOL,
      maxSolPerBuy: config.TREASURY_MAX_SOL_PER_ACTION,
      maxSolPerDay: config.TREASURY_MAX_SOL_PER_DAY,
      intervalMin: config.TREASURY_BUY_INTERVAL_MIN,
    },
  });

  // After a failed buy, wait before trying again instead of failing every check.
  const recentFail = await one(
    `SELECT 1 FROM treasury_actions WHERE coin_id = $1 AND kind = 'buy' AND status = 'failed'
       AND created_at > now() - ($2 || ' minutes')::interval`,
    [coinId, String(config.TREASURY_BUY_INTERVAL_MIN)],
  );
  if (recentFail && decision.action !== "skip") {
    logger.debug({ coinId }, "treasury waiting after a failed buy");
    return;
  }

  if (decision.action === "skip") {
    logger.debug({ coinId, reason: decision.reason }, "treasury skip");
    return;
  }

  if (dryRun) {
    await record(coinId, { kind: "buy", status: "simulated", sol: decision.sol, reason: decision.reason, dryRun });
    await record(coinId, { kind: "burn", status: "simulated", reason: "Would burn every coin bought back.", dryRun });
    await maybePostAboutBurn(coin, `The treasury ran a simulated buyback of ${decision.sol} SOL from creator fees, and would burn what it bought.`);
    return;
  }

  let spentSol = decision.sol;
  try {
    const bought = await agentBuy(agent, mint, decision.sol, price?.graduated ?? false);
    spentSol = bought.sol;
    await record(coinId, {
      kind: "buy",
      status: "done",
      sol: bought.sol,
      sig: bought.sig,
      reason: bought.sol < decision.sol ? `${decision.reason} Bought in a smaller piece because the price was moving.` : decision.reason,
    });
  } catch (e) {
    const raw = (e as Error).message;
    logger.warn({ coinId, err: raw }, "buyback failed");
    await record(coinId, { kind: "buy", status: "failed", sol: decision.sol, reason: friendlyTradeError(raw) });
    return; // logged on the Treasury tab; the next try waits (see backoff above)
  }

  const burned = await burnAll(coin, "Burned the coins just bought back with creator fees.", true);
  if (burned) {
    await maybePostAboutBurn(
      coin,
      `The treasury just used ${spentSol} SOL of creator fees to buy back ${Math.round(burned).toLocaleString("en-US")} $${coin.symbol} and burned all of it.`,
    );
  }
}

export async function scheduleTreasuryRuns() {
  const due = await query<{ id: string }>(
    `SELECT id FROM coins
     WHERE status = 'live' AND mint IS NOT NULL
       AND (last_treasury_run_at IS NULL OR last_treasury_run_at < now() - ($1 || ' minutes')::interval)
     LIMIT 100`,
    [String(config.TREASURY_MIN_INTERVAL_MIN)],
  );
  for (const c of due.rows) {
    await enqueue("treasury.run", { coinId: c.id }, { dedupeKey: `treasury:${c.id}`, maxAttempts: 2 });
  }
}
