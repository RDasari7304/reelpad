-- Before Meta approves the app, only Instagram accounts added as testers can connect.
-- Creators submit their username; an admin adds it as a tester in the Meta dashboard and marks it invited.
CREATE TABLE instagram_access_requests (
  coin_id       uuid PRIMARY KEY REFERENCES coins(id) ON DELETE CASCADE,
  username      text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','invited','connected')),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  invited_at    timestamptz
);
CREATE INDEX instagram_access_requests_status_idx ON instagram_access_requests(status, requested_at);
