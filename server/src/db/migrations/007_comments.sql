-- Comment replies: the influencer reads comments on its posts and answers them in character.
ALTER TABLE instagram_accounts ADD COLUMN IF NOT EXISTS scopes text[] NOT NULL DEFAULT '{}';
ALTER TABLE instagram_accounts ADD COLUMN IF NOT EXISTS comments_error text;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS ig_comments_count int NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS comments_synced_at timestamptz;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS last_comment_sync_at timestamptz;

CREATE TABLE IF NOT EXISTS ig_comments (
  id           text PRIMARY KEY,                -- Instagram comment id
  coin_id      uuid NOT NULL REFERENCES coins(id) ON DELETE CASCADE,
  post_id      uuid REFERENCES posts(id) ON DELETE SET NULL,
  media_id     text NOT NULL,
  parent_id    text,                            -- top-level comment this replies to (Instagram threads are one level deep)
  username     text NOT NULL,
  text         text NOT NULL,
  like_count   int NOT NULL DEFAULT 0,
  commented_at timestamptz NOT NULL,
  is_own       boolean NOT NULL DEFAULT false,  -- written by the influencer
  status       text NOT NULL DEFAULT 'new' CHECK (status IN ('new','replied','skipped','failed','own')),
  action       text,                            -- reply | react | skip
  reply_id     text,
  reply_text   text,
  reason       text,
  attempts     int NOT NULL DEFAULT 0,
  replied_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ig_comments_coin_idx ON ig_comments(coin_id, commented_at DESC);
CREATE INDEX IF NOT EXISTS ig_comments_new_idx ON ig_comments(coin_id) WHERE status = 'new';
CREATE INDEX IF NOT EXISTS ig_comments_parent_idx ON ig_comments(parent_id);
CREATE INDEX IF NOT EXISTS ig_comments_replied_idx ON ig_comments(coin_id, replied_at DESC) WHERE status = 'replied';
