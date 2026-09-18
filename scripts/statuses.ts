/** Gathers every status name the codified effects refer to, for the validator report. */
export const STATUSES_SEEN = new Set<string>();

export function collectStatuses(effects: unknown[]): void {
  for (const e of effects) {
    if (!e || typeof e !== 'object') continue;
    const eff = e as Record<string, unknown>;
    if (typeof eff.status === 'string') STATUSES_SEEN.add(eff.status);
    if (Array.isArray(eff.then)) collectStatuses(eff.then);
  }
}
