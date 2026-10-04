# Reelpad

Launch a pump.fun coin with its own AI influencer. The creator sets the name, ticker, image and character (personality,
objective, look, voice); the coin is created on pump.fun from their wallet; they connect an Instagram Creator/Business
account; the character then posts images, carousels and Reels on a schedule. Each coin also gets an agent wallet that
receives the coin's pump.fun creator fees and can buy back or burn the coin within strict limits.

## How it works

```
Browser (React + Solana wallet adapter)
   │  sign-in by wallet signature, launch form, coin pages
   ▼
API (Express) ───────────── Postgres (coins, posts, treasury log, job queue)
   │                              ▲
   │                              │ jobs
   ▼                              │
Worker ── plan post (Claude) ── generate media (fal.ai) ── store (R2) ── publish (Instagram API)
      └── treasury: price snapshot → claim creator fees → policy decision → buy (PumpPortal) → burn
```

**Launch.** The server generates a mint keypair and an agent keypair (encrypted at rest), pins the image and metadata to
IPFS, and builds one transaction: pump.fun `createV2` with the creator wallet as payer and the **agent wallet as the coin's
creator** (so creator fees go to the treasury), plus the platform fee and a small gas transfer to the agent. The mint key
signs on the server; the creator signs in their wallet; the server checks the signed transaction is byte-for-byte what it
built before broadcasting. An optional first buy follows as a second approval.

**Posting.** Every minute the worker finds coins due a post, picks a format (respecting the weekly Reel cap), asks Claude
for a plan in the character's voice, rejects captions that promise returns or tell people to buy, generates images with the
token image as a character reference (and animates a keyframe for Reels), converts to Instagram-compatible JPEG/MP4,
stores them publicly, and publishes. Creators can switch on review mode to approve each post first.

**Treasury.** Every 15 minutes per coin: record the price, claim creator fees, and run the pure policy in
`server/src/domain/treasuryPolicy.ts`. The policy can only spend the smaller of the creator's limits and the platform caps,
never touches the reserve or gas buffer, and enforces cooldowns. `TREASURY_DRY_RUN=true` (the default) logs simulated
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

Instagram OAuth needs a public HTTPS redirect, so test the connect flow on your deployed domain (or an HTTPS tunnel set as
`PUBLIC_URL`).

## Accounts you need

| Service | Used for | Notes |
|---|---|---|
| Solana RPC (Helius, Triton…) | Launches, balances, trades | Public RPC drops transactions |
| Pinata | IPFS image + metadata | pump.fun no longer accepts direct uploads |
| Cloudflare R2 (or any S3) | Public media for Instagram | Bucket must be publicly readable |
| Meta developer app | Instagram publishing | See below |
| Anthropic | Post planning and captions | |
| fal.ai | Images and Reels | Model IDs configurable |

## Meta / Instagram setup

1. Create an app at developers.facebook.com (type: Business). Add the **Instagram** product and choose **API setup with
   Instagram login**. Copy the Instagram App ID and secret into `IG_APP_ID` / `IG_APP_SECRET`.
2. Under Business login settings, add the redirect URI `https://yourdomain.com/api/instagram/callback`.
3. Set **Deauthorize callback** to `https://yourdomain.com/api/instagram/deauthorize` and **Data deletion request** to
   `https://yourdomain.com/api/instagram/data-deletion`. Set the privacy policy URL to `https://yourdomain.com/privacy`.
4. Request `instagram_business_basic` and `instagram_business_content_publish`.
5. While the app is in development mode, only accounts added as Instagram testers can connect. Keep
   `IG_ACCESS_MODE=testers` and the site handles this for you:
   - The creator enters the coin's Instagram username (on the launch form or the coin page).
   - It appears in **Admin → Instagram access**. In the Meta dashboard, open App roles → Roles → Add people → Instagram
     Tester, paste the username, send the invite, then click **Mark invited**.
   - The creator's coin page then tells them to accept the invite (instagram.com → Settings → Apps and websites → Tester
     invites) and shows **Log in with Instagram**.
6. To let anyone connect, submit for **App Review** with a screencast of the connect-and-publish flow, and complete
   Business Verification. Once approved, set `IG_ACCESS_MODE=open` and redeploy: the login button works for everyone.
7. Each coin's Instagram must be a Professional (Creator or Business) account. Instagram allows 100 API posts per account
   per day; this app posts at most 3.

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
  promotes them on social media. Instagram's policies on financial products and branded content apply to these accounts.
  Have a lawyer review the Terms and Privacy pages in `web/src/pages/Legal.tsx`.

## Project layout

```
server/src
  config.ts               env validation
  db/                     pool, migrations, Postgres job queue
  domain/                 pure logic: catalog, schemas, persona prompt, captions, schedule, treasury policy
  services/               pump.fun, PumpPortal, Solana, Instagram, Claude, fal.ai, storage, IPFS, content, treasury
  http/                   routes: auth (wallet sign-in), coins, posts, instagram, admin
  worker/                 job runner + minute ticker
web/src
  pages/                  Home, Launch, Coin, Mine, Admin, Legal
  editors.tsx             character / posting / treasury editors (launch + settings)
```
