import { one, query } from "../db/pool.js";

export interface KillSwitch {
  content: boolean;
  treasury: boolean;
  launches: boolean;
}

export async function getKillSwitch(): Promise<KillSwitch> {
  const row = await one<{ value: KillSwitch }>(`SELECT value FROM settings WHERE key = 'kill_switch'`);
  return { content: false, treasury: false, launches: false, ...(row?.value ?? {}) };
}

export async function setKillSwitch(patch: Partial<KillSwitch>): Promise<KillSwitch> {
  const next = { ...(await getKillSwitch()), ...patch };
  await query(
    `INSERT INTO settings(key, value) VALUES ('kill_switch', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(next)],
  );
  return next;
}
