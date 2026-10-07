# Reelpad

Launch a pump.fun coin with its own AI influencer. The creator sets the name, ticker, image and character (personality,
look, voice); the coin is created on pump.fun from their wallet; they can connect a TikTok
account; the character then posts videos, photos and photo carousels on a schedule, on Reelpad and on TikTok. Each coin also gets an agent wallet that
receives the coin's pump.fun creator fees and automatically uses them to buy back and burn the coin.

## How it works

```
Browser (React + Solana wallet adapter)
   │  sign-in by wallet signature, launch form, coin pages
   ▼
API (Express) ───────────── Postgres (coins, posts, treasury log, job queue)
   │                              ▲
   │                              │ jobs
   ▼                              │
Worker ── plan post (Claude) ── generate media (fal.ai) ── store (R2) ── publish (TikTok Content Posting API)
      └── treasury: price snapshot → claim creator fees → policy decision → buy (PumpPortal) → burn
```

**Launch.** The server generates a mint keypair and an agent keypair (encrypted at rest), pins the image and metadata to
IPFS, and builds one transaction: pump.fun `createV2` with the creator wallet as payer and the **agent wallet as the coin's
creator** (so creator fees go to the treasury), plus the platform fee and a small gas transfer to the agent. The mint key
signs on the server; the creator signs in their wallet; the server checks the signed transaction is byte-for-byte what it
built before broadcasting. An optional first buy follows as a second approval.

**Posting.** Every minute the worker finds coins due a post, picks a format (respecting the weekly video cap), asks Claude
for a plan in the character's voice, rejects captions that promise returns or tell people to buy, generates images with the
token image as a character reference (and animates keyframes for videos), converts to TikTok-compatible JPEG/MP4,
stores them publicly, and publishes. Creators can switch on review mode to approve each post first.

**Treasury (automatic buyback and burn).** Every 15 minutes per coin: record the price and claim creator fees. Once at
least `TREASURY_MIN_BUY_SOL` has collected (and at most every `TREASURY_BUY_INTERVAL_MIN` minutes), the agent spends the
fees above its gas reserve buying the coin back, then burns everything it bought. The pure policy in
`server/src/domain/treasuryPolicy.ts` caps each buyback and each day; extra fees carry over. Creators can't change or
pause it; admins can, platform-wide or per coin. `TREASURY_DRY_RUN=true` (the default) logs simulated
trades instead of sending them. Admins have kill switches for launches, posting and trading.

## Run locally

Requirements: Node 20+, Postgres 14+.

```bash
npm install
cp .env.example server/.env        # fill in values; DATABASE_SSL=false for local Postgres
npm run migrate:dev --workspace server
npm run dev                         # API on :8080, web on :5173 (proxied)
npm test                            # unit tests (policy, captions, crypto, SigV4, scheduling)
```

TikTok login needs a public HTTPS redirect, so test the connect flow on your deployed domain (or an HTTPS tunnel set as
`PUBLIC_URL`).

## Accounts you need

| Service | Used for | Notes |
|---|---|---|
| Solana RPC (Helius, Triton…) | Launches, balances, trades | Public RPC drops transactions |
| Pinata | IPFS image + metadata | pump.fun no longer accepts direct uploads |
| Cloudflare R2 (or any S3) | Public media for TikTok | Bucket must be publicly readable, domain verified in TikTok |
| TikTok developer app | TikTok publishing | See below |
| Anthropic | Post planning and captions | |
| fal.ai | Images and Reels | Model IDs configurable |

## TikTok setup

1. Create an app at developers.tiktok.com. Add **Login Kit** and the **Content Posting API** (turn on **Direct Post**).
   Copy the Client key and secret into `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET`.
2. Login Kit → Redirect URI: `https://yourdomain.com/api/tiktok/callback`.
3. Scopes: `user.info.basic`, `user.info.profile`, `video.publish`, `video.upload`, `video.list`.
4. **URL properties**: verify the domain or URL prefix of `S3_PUBLIC_BASE_URL`. TikTok pulls every video and photo from
   that URL (`PULL_FROM_URL`), and refuses unverified ones.
5. Webhooks → Callback URL: `https://yourdomain.com/api/tiktok/webhook`. When a creator removes the app in TikTok, the
   stored tokens are dropped.
6. Until TikTok audits the app, only sandbox **target users** can log in, and posts can only be private. Keep
   `TIKTOK_ACCESS_MODE=testers` and the site handles this for you:
   - The creator enters the coin's TikTok username (on the launch form or the coin page).
   - It appears in **Admin → TikTok access**. In the developer portal, open your app's Sandbox → Target users, add the
     account, then click **Mark added**.
   - The creator's coin page then shows **Log in with TikTok**.
   - Posts go out as "only me" automatically while the app is unaudited (the API refuses public posts until then).
7. To let anyone connect and post publicly, **submit the app for review** with a screencast of the connect-and-publish
   flow. Once approved, set `TIKTOK_ACCESS_MODE=open` and redeploy: the login button works for everyone.
8. TikTok caps Direct Post at roughly 15 posts per creator per day, so `CONTENT_MAX_POSTS_PER_DAY` defaults to 15. Posts
   carry TikTok's AI-generated content label (`is_aigc`). Videos post as TikToks; image posts and carousels post as
   photo-mode posts (with auto-added music).
9. **Comment replies (optional).** TikTok's comment API (`comment.list`, `comment.list.manage`) is only available to
   approved apps. Once your app has those scopes, set `TIKTOK_COMMENTS=true`; creators then reconnect once to grant them.
   Without it, everything else works and the Comments tab says replies aren't switched on.

Access tokens last 24 hours and are refreshed automatically with the refresh token (valid for a year); creators only log
in again if they remove the app or don't post for a year.

## Deploy (Render)

**Full step-by-step guide: [DEPLOY.md](DEPLOY.md).** Short version:

1. Push this folder to a GitHub repo. In Render, **New → Blueprint** and select it (`render.yaml` creates the web service
   and Postgres).
2. Fill in the dashboard env vars (descriptions in `.env.example`). Generate `MASTER_KEY` with
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` and **store a copy offline**: it decrypts
   every agent wallet.
3. Add your domain in Render, then set `PUBLIC_URL` to it.
4. Migrations run on boot. Open `/admin` with a wallet listed in `ADMIN_WALLETS`.

## Before real money goes through it

- **Launch a test coin end to end** on mainnet with a small amount. The pump.fun SDK call is isolated in
  `server/src/services/pump.ts`; if a newer SDK version changes `createV2Instruction`'s parameters, that's the one place to
  adjust. Confirm on pump.fun that the coin's creator is the agent wallet.
- Check the fal.ai model pages for current input fields and prices (`server/src/services/ai/fal.ts`), and set
  `COST_*_USD` and `DAILY_AI_BUDGET_USD` accordingly.
- Watch simulated treasury activity for a few days, then set `TREASURY_DRY_RUN=false`. Start with low platform caps.
- The platform holds the agent wallets' keys, which makes treasuries custodial. Keep `MASTER_KEY` and the database
  secured, restrict admin wallets, and consider the legal side of running a service that creates and trades tokens and
  promotes them on social media. TikTok's policies on financial products, AI-generated content and branded content apply to these accounts.
  Have a lawyer review the Terms and Privacy pages in `web/src/pages/Legal.tsx`.

## Project layout

```
server/src
  config.ts               env validation
  db/                     pool, migrations, Postgres job queue
  domain/                 pure logic: catalog, schemas, persona prompt, captions, schedule, treasury policy
  services/               pump.fun, PumpPortal, Solana, TikTok, Claude, fal.ai, storage, IPFS, content, treasury
  http/                   routes: auth (wallet sign-in), coins, posts, tiktok, admin
  worker/                 job runner + minute ticker
web/src
  pages/                  Home, Launch, Coin, Mine, Admin, Legal
  editors.tsx             character / posting / treasury editors (launch + settings)
```
