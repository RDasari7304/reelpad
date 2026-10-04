-- Live progress for posts being made, shown as a loading card on the coin page.
ALTER TABLE posts ADD COLUMN progress int NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN stage text;
UPDATE posts SET progress = 100 WHERE status IN ('published', 'awaiting_approval', 'ready');
