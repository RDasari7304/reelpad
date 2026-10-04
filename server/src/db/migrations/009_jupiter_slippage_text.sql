-- Readable text for Jupiter slippage failures logged before this fix.
UPDATE treasury_actions
SET reason = 'The price moved more than allowed during the buy (slippage), so it was cancelled and no SOL was spent. It retries automatically.'
WHERE kind = 'buy' AND status = 'failed' AND reason LIKE '%"Custom":6001%';
