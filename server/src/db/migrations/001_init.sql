CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE auth_nonces (
  nonce       text PRIMARY KEY,
  wallet      text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used        boolean NOT NULL DEFAULT false
);

CREATE TABLE coins (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_wallet         text NOT NULL,
  name                   text NOT NULL,
  symbol                 text NOT NULL,
  description            text NOT NULL DEFAULT '',
  website                text,
  twitter                text,
  telegram               text,
  image_url              text NOT NULL,
  image_ipfs             text NOT NULL,
  metadata_uri           text,
  mint                   text UNIQUE,
  mint_secret_enc        text,
  agent_pubkey           text NOT NULL,
  agent_secret_enc       text NOT NULL,
  status                 text NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','awaiting_signature','launching','live','failed')),
  launch_error           text,
  launch_tx_sig          text,
  pending_message        bytea,
  pending_last_valid_height bigint,
  dev_buy_sol            numeric NOT NULL DEFAULT 0,
  persona                jsonb NOT NULL,
  content_settings       jsonb NOT NULL,
  treasury_settings      jsonb NOT NULL,
  content_paused         boolean NOT NULL DEFAULT false,
  treasury_paused        boolean NOT NULL DEFAULT false,
  next_post_at           timestamptz,
  last_treasury_run_at   timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  launched_at            timestamptz
);
CREATE INDEX coins_creator_idx ON coins(creator_wallet);
CREATE INDEX coins_status_idx ON coins(status, launched_at DESC);
CREATE INDEX coins_next_post_idx ON coins(next_post_at) WHERE status = 'live';

CREATE TABLE instagram_accounts (
  coin_id            uuid PRIMARY KEY REFERENCES coins(id) ON DELETE CASCADE,
  ig_user_id         text NOT NULL,
  username           text NOT NULL,
  account_type       text,
  profile_picture_url text,
  token_enc          text NOT NULL,
  token_expires_at   timestamptz NOT NULL,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','revoked')),
  connected_at       timestamptz NOT NULL DEFAULT now(),
  last_refreshed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX instagram_accounts_user_idx ON instagram_accounts(ig_user_id) WHERE status = 'active';

CREATE TABLE posts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_id         uuid NOT NULL REFERENCES coins(id) ON DELETE CASCADE,
  format          text NOT NULL CHECK (format IN ('image','carousel','reel')),
  status          text NOT NULL DEFAULT 'planned'
                  CHECK (status IN ('planned','generating','awaiting_approval','ready','publishing','published','failed','rejected')),
  trigger         text NOT NULL DEFAULT 'schedule',
  concept         text,
  caption         text,
  plan            jsonb,
  media           jsonb NOT NULL DEFAULT '[]'::jsonb,
  ig_container_id text,
  ig_media_id     text,
  permalink       text,
  error           text,
  cost_usd        numeric NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz
);
CREATE INDEX posts_coin_idx ON posts(coin_id, created_at DESC);

CREATE TABLE treasury_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_id     uuid NOT NULL REFERENCES coins(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('claim_fees','buy','burn','skip')),
  sol_amount  numeric,
  token_amount text,
  tx_sig      text,
  status      text NOT NULL CHECK (status IN ('done','failed','simulated','skipped')),
  reason      text NOT NULL,
  dry_run     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX treasury_actions_coin_idx ON treasury_actions(coin_id, created_at DESC);

CREATE TABLE price_snapshots (
  coin_id    uuid NOT NULL REFERENCES coins(id) ON DELETE CASCADE,
  ts         timestamptz NOT NULL DEFAULT now(),
  price_sol  numeric NOT NULL,
  graduated  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (coin_id, ts)
);

CREATE TABLE jobs (
  id            bigserial PRIMARY KEY,
  type          text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key    text,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  run_at        timestamptz NOT NULL DEFAULT now(),
  attempts      int NOT NULL DEFAULT 0,
  max_attempts  int NOT NULL DEFAULT 5,
  locked_until  timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready_idx ON jobs(run_at) WHERE status = 'queued';
-- Only one active (queued or running) job per dedupe key.
CREATE UNIQUE INDEX jobs_dedupe_idx ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running');

CREATE TABLE ai_spend (
  day  date PRIMARY KEY,
  usd  numeric NOT NULL DEFAULT 0
);

CREATE TABLE settings (
  key    text PRIMARY KEY,
  value  jsonb NOT NULL
);
INSERT INTO settings(key, value) VALUES
  ('kill_switch', '{"content": false, "treasury": false, "launches": false}'::jsonb);
