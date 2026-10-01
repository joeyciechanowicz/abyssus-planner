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
    // Golden Skin: "Take 2% less damage per 100 Gold" -> damageTaken -0.02, scaling with {DamageReduction}.
    const b = blessingById.get('Golden_Skin')!;
    const ranks = b.upgrades!.find((u) => u.variable === '{DamageReduction}')!.ranks;
    const top = ranks.length;
    const rank1 = scaleBlessingEffects(b, 1)[0] as { value: number };
    const rankTop = scaleBlessingEffects(b, top)[0] as { value: number };
    expect(rank1.value).toBeCloseTo(-ranks[0] / 100, 5);
    expect(rankTop.value).toBeCloseTo(-ranks[top - 1] / 100, 5); // stays negative, follows the rank table
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
