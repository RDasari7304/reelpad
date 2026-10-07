-- Reelpad posts to TikTok instead of Instagram.
-- Tables and columns are renamed; existing Instagram connections can't be used with TikTok, so they're
-- marked revoked and creators reconnect with "Log in with TikTok". Posting on Reelpad itself is unaffected.

ALTER TABLE instagram_accounts RENAME TO tiktok_accounts;
ALTER TABLE tiktok_accounts RENAME COLUMN ig_user_id TO open_id;
ALTER TABLE tiktok_accounts RENAME COLUMN profile_picture_url TO avatar_url;
ALTER TABLE tiktok_accounts RENAME COLUMN account_type TO display_name;
ALTER TABLE tiktok_accounts ADD COLUMN IF NOT EXISTS refresh_token_enc text;
ALTER TABLE tiktok_accounts ADD COLUMN IF NOT EXISTS refresh_expires_at timestamptz;
ALTER INDEX instagram_accounts_user_idx RENAME TO tiktok_accounts_user_idx;
UPDATE tiktok_accounts SET status = 'revoked', token_enc = 'revoked', display_name = NULL, comments_error = NULL;

ALTER TABLE instagram_access_requests RENAME TO tiktok_access_requests;
ALTER INDEX instagram_access_requests_status_idx RENAME TO tiktok_access_requests_status_idx;
-- Instagram tester invites don't carry over to TikTok's sandbox: anything not yet connected starts again as pending.
UPDATE tiktok_access_requests SET status = 'pending', invited_at = NULL;

ALTER TABLE posts RENAME COLUMN ig_container_id TO tiktok_publish_id;
ALTER TABLE posts RENAME COLUMN ig_media_id TO tiktok_post_id;
ALTER TABLE posts RENAME COLUMN ig_comments_count TO comments_count;
-- Instagram IDs and links mean nothing to TikTok: old posts stay on Reelpad without an outside link.
UPDATE posts SET tiktok_publish_id = NULL, tiktok_post_id = NULL, comments_count = 0,
  permalink = CASE WHEN permalink LIKE '%instagram.com%' THEN NULL ELSE permalink END;

ALTER TABLE ig_comments RENAME TO tiktok_comments;
ALTER INDEX ig_comments_coin_idx RENAME TO tiktok_comments_coin_idx;
ALTER INDEX ig_comments_new_idx RENAME TO tiktok_comments_new_idx;
ALTER INDEX ig_comments_parent_idx RENAME TO tiktok_comments_parent_idx;
ALTER INDEX ig_comments_replied_idx RENAME TO tiktok_comments_replied_idx;

-- Old jobs for the removed Instagram token refresh.
DELETE FROM jobs WHERE type = 'instagram.refresh' AND status IN ('queued','failed');
