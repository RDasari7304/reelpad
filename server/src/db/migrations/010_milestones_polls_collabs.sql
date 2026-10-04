-- Milestone posts, fan story polls and Instagram collabs.
CREATE TABLE IF NOT EXISTS coin_milestones (
  coin_id     uuid NOT NULL REFERENCES coins(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  key         text NOT NULL,
  note        text NOT NULL,
  achieved_at timestamptz NOT NULL DEFAULT now(),
  posted_at   timestamptz,
  PRIMARY KEY (coin_id, kind, key)
);
CREATE INDEX IF NOT EXISTS coin_milestones_pending ON coin_milestones(coin_id) WHERE posted_at IS NULL;

-- Holders vote on how the next episode of a storyline goes.
CREATE TABLE IF NOT EXISTS story_polls (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  arc_id     uuid NOT NULL REFERENCES story_arcs(id) ON DELETE CASCADE,
  coin_id    uuid NOT NULL REFERENCES coins(id) ON DELETE CASCADE,
  beat       int NOT NULL,                    -- the episode this poll decides
  question   text NOT NULL,
  options    jsonb NOT NULL,                  -- ["option text", ...]
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  winner     int,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at  timestamptz,
  UNIQUE (arc_id, beat)
);
CREATE TABLE IF NOT EXISTS story_poll_votes (
  poll_id  uuid NOT NULL REFERENCES story_polls(id) ON DELETE CASCADE,
  wallet   text NOT NULL,
  option   int NOT NULL,
  voted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, wallet)
);

-- Collab posts: the other character featured (and invited as an Instagram collaborator).
ALTER TABLE posts ADD COLUMN IF NOT EXISTS collab_coin_id uuid REFERENCES coins(id) ON DELETE SET NULL;
