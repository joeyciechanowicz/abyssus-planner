import { describe, expect, it } from 'vitest';
import { MAX_BLESSINGS_PER_ASPECT, countedForAspect, heldBlessings, isPickable, picksLeft } from './blessings';
import { aspects, blessings } from './data';
import { emptyBuild, type Build } from './build';
import { simulate } from '../engine/simulate';

const blood = (picks: string[], extra: Record<string, number> = {}): Build => ({
  ...emptyBuild,
  aspects: { primary: 'Blood', secondary: null, ability: null },
  blessings: { Blood_Primary: 1, ...Object.fromEntries(picks.map((id) => [id, 1])), ...extra },
});
const ids = (b: Build) => heldBlessings(b, 'Blood').map((h) => h.blessing.id);

describe('fixed blessings', () => {
  it('every aspect has exactly one passive, Minor and Major, none of them pickable', () => {
    for (const aspect of aspects) {
      const roles = blessings.filter((b) => b.aspect === aspect && b.role).map((b) => b.role).sort();
      expect(roles, aspect).toEqual(['major', 'minor', 'passive']);
    }
    expect(blessings.filter((b) => b.role).some(isPickable)).toBe(false);
  });

  it('the passive is on as soon as the aspect is equipped', () => {
    expect(ids(blood([]))).toEqual(['Blood_Primary', 'Vigorous_Blood']);
  });

  it('the Minor comes 2nd and the Major 5th; the card does not count', () => {
    const picks = ['Red-blooded', 'Giants_Blood', 'Branding_Blood', 'Bloodletting', 'Feeble_Blood'];
    expect(ids(blood(picks.slice(0, 1)))).toEqual(['Blood_Primary', 'Vigorous_Blood', 'Red-blooded']);
    expect(ids(blood(picks.slice(0, 2))).slice(2)).toEqual(['Red-blooded', 'Blood_Sphere', 'Giants_Blood']);
    expect(ids(blood(picks.slice(0, 3))).slice(2)).not.toContain('Bloodsplosions');
    expect(ids(blood(picks.slice(0, 4))).slice(2)).toEqual([
      'Red-blooded', 'Blood_Sphere', 'Giants_Blood', 'Branding_Blood', 'Bloodsplosions', 'Bloodletting',
    ]);
  });

  it('counts picks plus the Minor and Major for "every X blessing"', () => {
    expect(countedForAspect(heldBlessings(blood([]), 'Blood'))).toBe(0);
    expect(countedForAspect(heldBlessings(blood(['Red-blooded', 'Giants_Blood']), 'Blood'))).toBe(3);
  });

  it('caps an aspect at 11 blessings, the Minor and Major included', () => {
    expect(picksLeft(blood([]), 'Blood')).toBe(9);
    const nine = blessings.filter((b) => b.aspect === 'Blood' && isPickable(b)).slice(0, 9).map((b) => b.id);
    const full = blood(nine);
    expect(picksLeft(full, 'Blood')).toBe(0);
    expect(countedForAspect(heldBlessings(full, 'Blood'))).toBe(MAX_BLESSINGS_PER_ASPECT);
  });

  it('keeps a rank set on a fixed blessing, and ignores it while the blessing is not due', () => {
    const held = heldBlessings(blood(['Red-blooded', 'Giants_Blood'], { Blood_Sphere: 3 }), 'Blood');
    expect(held.find((h) => h.blessing.id === 'Blood_Sphere')?.rank).toBe(3);
    expect(ids(blood(['Red-blooded'], { Blood_Sphere: 3 }))).not.toContain('Blood_Sphere');
  });

  it('a Minor stored in an old build does nothing until it is due', () => {
    const r = simulate(blood([], { Blood_Sphere: 1 }));
    expect(r.assumptions.some((a) => a.text.includes('Blood Orb'))).toBe(false);
  });
});
