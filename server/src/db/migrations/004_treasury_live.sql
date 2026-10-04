-- Treasuries are live now: remove the logged-only simulation entries so coin pages show real activity only.
DELETE FROM treasury_actions WHERE status = 'simulated' OR dry_run = true;
