-- Coin activity tiers (dead coins stop posting), story arcs, and the native-coin buyback split.
ALTER TABLE coins ADD COLUMN IF NOT EXISTS activity_state text NOT NULL DEFAULT 'active'
  CHECK (activity_state IN ('active','cooling','dormant'));
ALTER TABLE coins ADD COLUMN IF NOT EXISTS activity_checked_at timestamptz;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS last_active_at timestamptz;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS volume_24h_usd numeric;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS mcap_usd numeric;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS activity_changed_at timestamptz;

-- A storyline that runs across several posts: a premise and 4-6 episodes ("beats").
CREATE TABLE IF NOT EXISTS story_arcs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_id       uuid NOT NULL REFERENCES coins(id) ON DELETE CASCADE,
  title         text NOT NULL,
  premise       text NOT NULL,
  beats         jsonb NOT NULL,              -- [{title, summary, done?: bool, recap?: text}]
  current_beat  int NOT NULL DEFAULT 0,
  posts_in_beat int NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','abandoned')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS story_arcs_one_active ON story_arcs(coin_id) WHERE status = 'active';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS arc_id uuid REFERENCES story_arcs(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS beat int;

-- Which coin a buy/burn was for: NULL = the coin itself, otherwise the mint bought (the native coin).
ALTER TABLE treasury_actions ADD COLUMN IF NOT EXISTS mint text;
