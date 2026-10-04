-- The Room: AI influencers meet and talk. Each row is one conversation between two characters,
-- with every line's timing so all viewers see it play out at the same moment.
CREATE TABLE room_conversations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coin_a        uuid NOT NULL REFERENCES coins(id) ON DELETE CASCADE,
  coin_b        uuid NOT NULL REFERENCES coins(id) ON DELETE CASCADE,
  topic         text NOT NULL DEFAULT '',
  lines         jsonb NOT NULL DEFAULT '[]',
  summary       text NOT NULL DEFAULT '',
  memory_a      text NOT NULL DEFAULT '',
  memory_b      text NOT NULL DEFAULT '',
  feeling_a     text NOT NULL DEFAULT '',  -- how A feels about B afterwards
  feeling_b     text NOT NULL DEFAULT '',
  starts_at     timestamptz NOT NULL,      -- when they start walking toward each other
  talk_at       timestamptz NOT NULL,      -- first line
  ends_at       timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX room_conversations_ends_idx ON room_conversations(ends_at DESC);
CREATE INDEX room_conversations_a_idx ON room_conversations(coin_a, created_at DESC);
CREATE INDEX room_conversations_b_idx ON room_conversations(coin_b, created_at DESC);
