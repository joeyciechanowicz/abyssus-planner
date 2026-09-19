import { describe, expect, it } from 'vitest';
import { scaleBlessingEffects } from './blessingScaling';
import { blessingById } from '../model/data';

describe('scaleBlessingEffects', () => {
  it('leaves a blessing unchanged at rank 1', () => {
    const b = blessingById.get('Blood_Primary')!;
    expect(scaleBlessingEffects(b, 1)).toEqual(b.effects);
  });

  it('scales a linked leaf to its value at the chosen rank', () => {
    const b = blessingById.get('Blood_Primary')!;
    const scaled = scaleBlessingEffects(b, 11);
    const mult = scaled.find((e) => e.op === 'mult');
    const applyStatus = scaled.find((e) => e.op === 'applyStatus');
    // DamageIncrease rank 11 = 1000 (%), Chance rank 11 = 100 (%).
    expect(mult).toMatchObject({ value: 10.0 });
    expect(applyStatus).toMatchObject({ chance: 1.0 });
  });

  it('preserves sign for a negated ("deals less damage") linked effect', () => {
    const b = blessingById.get('Spiritual_Exchange')!;
    const rank1 = scaleBlessingEffects(b, 1)[0] as { value: number };
    const rank11 = scaleBlessingEffects(b, 11)[0] as { value: number };
    expect(rank1.value).toBeLessThan(0);
    expect(rank11.value).toBeGreaterThan(rank1.value); // the drawback shrinks at a higher rank
  });

  it('clamps a rank above the blessing max to its highest rank', () => {
    const b = blessingById.get('Blood_Primary')!;
    expect(scaleBlessingEffects(b, 999)).toEqual(scaleBlessingEffects(b, 11));
  });

  it('leaves a capstone (no upgrades) unaffected by rank', () => {
    const b = blessingById.get('Bloodsplosions')!;
    expect(b.upgrades ?? []).toHaveLength(0);
    expect(scaleBlessingEffects(b, 5)).toEqual(b.effects);
  });
});
