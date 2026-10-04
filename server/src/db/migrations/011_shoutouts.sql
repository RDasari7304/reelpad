-- Burn-for-a-Shoutout: holders burn the coin and the influencer records them a personal shoutout.
CREATE TABLE IF NOT EXISTS shoutouts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_id       uuid NOT NULL REFERENCES coins(id) ON DELETE CASCADE,
  wallet        text NOT NULL,
  format        text NOT NULL CHECK (format IN ('video','photo')),
  recipient     text NOT NULL,
  request       text NOT NULL,
  public        boolean NOT NULL DEFAULT true,     -- shown on the coin's shoutout wall
  status        text NOT NULL DEFAULT 'awaiting_burn'
                CHECK (status IN ('awaiting_burn','queued','making','done','failed','expired')),
  price_sol     numeric NOT NULL,                  -- value of the burn when quoted
  tokens_raw    numeric NOT NULL,                  -- raw token units to burn
  decimals      int NOT NULL,
  burn_sig      text UNIQUE,
  burned_raw    numeric,
  script        jsonb,                             -- what the character says and the scene
  media         jsonb NOT NULL DEFAULT '[]'::jsonb,
  progress      int NOT NULL DEFAULT 0,
  stage         text,
  error         text,
  cost_usd      numeric NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  paid_at       timestamptz,
  done_at       timestamptz
);
CREATE INDEX IF NOT EXISTS shoutouts_coin ON shoutouts(coin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS shoutouts_wallet ON shoutouts(wallet, created_at DESC);
