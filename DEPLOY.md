# Deploying Reelpad to your domain (Solana mainnet)

Reelpad already runs on Solana mainnet; pump.fun only exists there. "Going live" means hosting it on Render under your
domain, with production keys.

**Monthly running costs (approx., check current pricing):** Render web service Starter ~$7, Render Postgres basic-256mb
~$6, domain ~$10/year. Helius, Pinata and Cloudflare R2 have free tiers that cover a launch. Anthropic and fal.ai are
pay-per-use, capped by `DAILY_AI_BUDGET_USD`. Creators pay none of this; they pay only the launch fee shown before signing.

---

## 1. Check the production build locally

In WSL, in your project folder:

```bash
npm run build && npm start
```

Open http://localhost:8080. It's the same site, served the way Render serves it. Stop it with Ctrl+C.
(`npm run typecheck` runs a full type check; it isn't required to deploy, but send me any errors and I'll clean them up.)

## 2. Buy the domain on Cloudflare

Use Cloudflare Registrar (dash.cloudflare.com → Domain Registration). It sells at cost, and your media storage needs the
domain on Cloudflare anyway. If you already own a domain elsewhere, add it to Cloudflare as a site and switch its
nameservers to the two Cloudflare gives you.

## 3. Set up production services

**Media storage (Cloudflare R2)**
1. R2 → Create bucket, e.g. `reelpad-media`.
2. Bucket → Settings → Custom Domains → Add → `media.yourdomain.com`. (Don't use the r2.dev URL in production: it's
   rate-limited and meant for development.)
3. R2 → Manage API tokens → Create token with Object Read & Write on that bucket. Note the access key ID, secret, and the
   S3 endpoint (`https://<account-id>.r2.cloudflarestorage.com`).

**Solana RPC (Helius)**: create two API keys at helius.dev:
- a server key for `SOLANA_RPC_URL`
- a browser key for `VITE_SOLANA_RPC_URL`, restricted to your domain in Helius' key settings (it's visible in the page)

**Pinata**: app.pinata.cloud → API Keys → New key → copy the JWT.

**Anthropic / fal.ai**: create production API keys and set spending limits in both dashboards.

**Fresh secrets**: don't reuse your local ones:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
That's your production `MASTER_KEY`. Save it in a password manager **and** offline. It decrypts every coin's agent
wallet; if it's lost, every treasury is lost with it. (Render generates `JWT_SECRET` for you.)

## 4. Push the code to a private GitHub repo

```bash
cd ~/reelpad
git init -b main
git add .
git status          # make sure no .env file is listed
git commit -m "Reelpad"
sudo apt install -y gh && gh auth login
gh repo create reelpad --private --source . --push
```

## 5. Create the Render services

1. render.com → New → **Blueprint** → connect GitHub → pick the `reelpad` repo. It reads `render.yaml` and creates the web
   service and Postgres database.
2. Fill in the values it asks for:

| Key | Value |
|---|---|
| `PUBLIC_URL` | `https://yourdomain.com` (no trailing slash) |
| `MASTER_KEY` | the fresh key from step 3 |
| `ADMIN_WALLETS` | your wallet address |
| `PLATFORM_FEE_WALLET` | the wallet that receives launch fees |
| `SOLANA_RPC_URL` / `VITE_SOLANA_RPC_URL` | Helius server key / browser key URLs |
| `PINATA_JWT` | from Pinata |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | from R2 |
| `S3_PUBLIC_BASE_URL` | `https://media.yourdomain.com` |
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | Client key and secret from your TikTok developer app |
| `ANTHROPIC_API_KEY` / `FAL_KEY` | production keys |

3. Optional settings (add under Environment if you want to change the defaults): `PLATFORM_FEE_SOL` (default 0.02),
   `DAILY_AI_BUDGET_USD` (default 50), `APP_NAME`.
4. Apply. The first deploy takes a few minutes. When it's live, `https://<service>.onrender.com/api/health` returns
   `{"ok":true}`.

`TREASURY_DRY_RUN=true` and `TIKTOK_ACCESS_MODE=testers` are preset. Leave both for now.

## 6. Point your domain at Render

1. Render → your web service → Settings → **Custom Domains** → add `yourdomain.com` (Render offers `www` too).
2. Cloudflare → your domain → DNS → add:
   - `CNAME` `@` → `<service>.onrender.com`, Proxy status **DNS only**
   - `CNAME` `www` → `<service>.onrender.com`, Proxy status **DNS only**
   - delete any `AAAA` records on the root (Render doesn't support IPv6)
3. Cloudflare → SSL/TLS → Overview → set encryption mode to **Full**.
4. Back in Render, click **Verify**. The HTTPS certificate is issued automatically, usually within minutes.

## 7. Point TikTok at the production domain

In your app at developers.tiktok.com:
1. Add the **Login Kit** and **Content Posting API** products. In Content Posting API, turn on **Direct Post**.
2. Login Kit → Redirect URI: `https://yourdomain.com/api/tiktok/callback`.
3. Scopes: `user.info.basic`, `user.info.profile`, `video.publish`, `video.upload`, `video.list`.
4. **URL properties**: verify the domain (or URL prefix) of `S3_PUBLIC_BASE_URL`, e.g. `https://media.yourdomain.com/`.
   TikTok only pulls videos and photos from verified URLs.
5. Webhooks → Callback URL: `https://yourdomain.com/api/tiktok/webhook` (TikTok tells us when a creator removes the app).
6. App details: Terms `https://yourdomain.com/terms`, Privacy policy `https://yourdomain.com/privacy`, an icon, and a
   description.
7. **Submit for review** (audit) with a screencast of: launch → enter username → log in with TikTok → a post appears.
   Until approved, creators use the sandbox queue in Admin, and TikTok only allows private ("only me") posts.

## 8. Go-live check

1. Open `https://yourdomain.com`, connect your admin wallet, sign in, open **Admin**.
2. Launch a test coin with a small amount of SOL. On pump.fun, check the coin's creator is the **agent wallet** shown on
   the coin's Treasury tab.
3. Connect a test TikTok account through the sandbox flow; the first post should appear within a few minutes.
4. Watch the Treasury tab log simulated actions for a few days. When you trust it, set `TREASURY_DRY_RUN=false` in
   Render (keep the platform caps low at first).
5. When TikTok approves the app, set `TIKTOK_ACCESS_MODE=open` in Render.

## Running it

- **Admin → TikTok access**: check the sandbox queue daily until TikTok approves you.
- **Admin → Emergency stops** pause launches, posting or trading platform-wide instantly.
- **Admin → Today** shows AI spend against the daily budget and recent failures.
- Render redeploys automatically when you push to GitHub.
- Have a lawyer review `web/src/pages/Legal.tsx` (Terms, Privacy) before you promote the site.
