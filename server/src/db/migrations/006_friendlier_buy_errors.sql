-- Replace raw program logs on failed buybacks with a readable reason.
UPDATE treasury_actions
SET reason = 'The price moved more than allowed during the buy (slippage), so it was cancelled. It retries later with a smaller amount.'
WHERE kind = 'buy' AND status = 'failed' AND (reason LIKE '%0x1774%' OR reason LIKE '%0x1772%');
