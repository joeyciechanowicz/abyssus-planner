import { describe, expect, it } from 'vitest';
import { PAYLOAD_FIELDS, SCOPES, STATS } from '../model/effects';
import { statLabel } from './theme';

describe('statLabel', () => {
  it('has a readable label for every stat, payload field and scope', () => {
    for (const s of [...STATS, ...PAYLOAD_FIELDS]) expect(statLabel(s, 'all'), s).not.toBe(s);
    for (const scope of SCOPES.filter((x) => x !== 'all')) expect(statLabel('damage', scope), scope).not.toBe('Damage');
  });
});
