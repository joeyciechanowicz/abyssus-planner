import { describe, expect, it } from 'vitest';
import { simulate } from './simulate';
import { Modifiers, applyEffects } from './stacking';
import { defaultOptions, emptyBuild, type Build } from '../model/build';
import { blessings, charms, soulSkills, weapons, abilities } from '../model/data';
import type { Effect } from '../model/effects';

const opts = defaultOptions;

describe('modifier stacking', () => {
  it('sums same-stat multipliers additively', () => {
    const m = new Modifiers();
    const effects: Effect[] = [
      { op: 'mult', stat: 'damage', scope: 'all', value: 0.15 },
      { op: 'mult', stat: 'damage', scope: 'all', value: 0.15 },
      { op: 'mult', stat: 'damage', scope: 'all', value: 0.15 },
    ];
    applyEffects(m, effects, 'test', opts);
    // additive, not (1.15)^3 = 1.52
    expect(m.multFor('damage', 'all')).toBeCloseTo(0.45);
  });

  it('adds scope-specific multipliers on top of the "all" bucket', () => {
    const m = new Modifiers();
    applyEffects(
      m,
      [
        { op: 'mult', stat: 'damage', scope: 'all', value: 0.1 },
        { op: 'mult', stat: 'damage', scope: 'primary', value: 0.15 },
      ],
      'test',
      opts,
    );
    expect(m.multFor('damage', 'primary')).toBeCloseTo(0.25);
    expect(m.multFor('damage', 'secondary')).toBeCloseTo(0.1);
  });

  it('scales stacking effects by assumed stack fullness', () => {
    const m = new Modifiers();
    applyEffects(
      m,
      [{ op: 'stacking', stat: 'damage', scope: 'all', valuePer: 0.1, per: 'hit', max: 10 }],
      'test',
      { ...opts, stackFullness: 1.0 },
    );
    expect(m.multFor('damage', 'all')).toBeCloseTo(1.0); // 10 stacks x 10%
  });

  it('scales trigger effects by their chance', () => {
    const m = new Modifiers();
    applyEffects(
      m,
      [
        {
          op: 'trigger',
          on: 'hit',
          chance: 0.5,
          then: [{ op: 'mult', stat: 'damage', scope: 'all', value: 1.0 }],
        },
      ],
      'test',
      opts,
    );
    expect(m.multFor('damage', 'all')).toBeCloseTo(0.5);
  });

  it('honours conditional thresholds', () => {
    const effects: Effect[] = [
      {
        op: 'conditional',
        when: 'healthAbove',
        threshold: 0.8,
        then: [{ op: 'mult', stat: 'damage', scope: 'all', value: 0.4 }],
      },
    ];
    const high = new Modifiers();
    applyEffects(high, effects, 'test', { ...opts, healthFraction: 1.0 });
    expect(high.multFor('damage', 'all')).toBeCloseTo(0.4);

    const low = new Modifiers();
    applyEffects(low, effects, 'test', { ...opts, healthFraction: 0.5 });
    expect(low.multFor('damage', 'all')).toBe(0);
  });
});

describe('simulate', () => {
  const base: Build = { ...emptyBuild, weaponId: 'Engine_Rifle', modeName: 'Automatic Fire' };

  it('computes bare-weapon DPS from the mode stats', () => {
    // Automatic Fire: 32 damage, 64 weakspot, 10 shots/s, clip 100, reload 2.2s.
    // At 50% weakspot accuracy: (32 + 64) / 2 = 48 per hit, x0.95 accuracy = 45.6
    // Cycle: 100/10 + 2.2 = 12.2s for 100 shots => 4560 / 12.2 = 373.8 dps
    const r = simulate(base, { weakspotAccuracy: 0.5, accuracy: 0.95 });
    expect(r.perHit).toBeCloseTo(48, 5);
    expect(r.perShot).toBeCloseTo(45.6, 5);
    expect(r.weaponDps).toBeCloseTo(373.77, 1);
  });

  it('applies weapon damage soul skills additively', () => {
    const withSkills: Build = {
      ...base,
      soulSkillIds: ['enhanced_weapons', 'enhanced_weapons_ii'],
    };
    const bare = simulate(base, { weakspotAccuracy: 0 });
    const buffed = simulate(withSkills, { weakspotAccuracy: 0 });
    // +10% and +10% => x1.2, not x1.21
    expect(buffed.perHit / bare.perHit).toBeCloseTo(1.2, 5);
  });

  it('only counts blessings whose aspect is equipped', () => {
    const wrongAspect: Build = {
      ...base,
      aspects: { primary: 'Blood', secondary: null, ability: null },
      blessings: { Primary_Flares: 1 },
    };
    const r = simulate(wrongAspect, { weakspotAccuracy: 0 });
    expect(r.warnings.some((w) => w.includes('not equipped'))).toBe(true);
    expect(r.stats.damageMultiplier).toBe(1);
  });

  it('applies a scoped aspect blessing only to its own fire mode', () => {
    const bloodPrimary: Build = {
      ...base,
      aspects: { primary: 'Blood', secondary: null, ability: null },
      blessings: { Blood_Primary: 1 },
    };
    const onPrimary = simulate(bloodPrimary, { weakspotAccuracy: 0 });
    expect(onPrimary.stats.damageMultiplier).toBeCloseTo(1.15, 5);

    // Engine Rev is a Secondary mode, so a Primary blessing must not touch it.
    const onSecondary = simulate(
      { ...bloodPrimary, modeName: 'Engine Rev' },
      { weakspotAccuracy: 0 },
    );
    expect(onSecondary.stats.damageMultiplier).toBe(1);
  });

  it('raises weakspot damage with Keen Vision only on weakspot hits', () => {
    const b: Build = { ...base, soulSkillIds: ['keen_vision'] };
    expect(simulate(b, { weakspotAccuracy: 0 }).perHit).toBeCloseTo(32, 5);
    expect(simulate(b, { weakspotAccuracy: 1 }).perHit).toBeCloseTo(64 * 1.1, 5);
  });

  it('shortens the cycle when fire rate rises', () => {
    const b: Build = { ...base, soulSkillIds: ['rapid_fire'] };
    const bare = simulate(base);
    const fast = simulate(b);
    expect(fast.stats.fireRate).toBeCloseTo(11.5, 5);
    expect(fast.weaponDps).toBeGreaterThan(bare.weaponDps);
  });

  it('reports unmodeled picks instead of silently ignoring them', () => {
    const b: Build = {
      ...base,
      aspects: { primary: 'Barrier', secondary: null, ability: null },
      blessings: { Lasting_Defense: 1 },
    };
    const r = simulate(b);
    expect(r.unmodeled.length).toBeGreaterThan(0);
  });

  it('adds ability damage when an ability is equipped', () => {
    const withAbility: Build = { ...base, abilityId: 'frag_grenade' };
    const r = simulate(withAbility);
    // 200 damage x 3 charges over a 30s encounter = 20 dps
    expect(r.abilityDps).toBeCloseTo(20, 5);
    expect(r.totalDps).toBeCloseTo(r.weaponDps + r.dotDps + r.abilityDps, 5);
  });

  it('counts a mode DoT component separately from impact', () => {
    const r = simulate({ ...emptyBuild, weaponId: 'Plasma_Launcher', modeName: 'Void Infusion' });
    expect(r.dotDps).toBeGreaterThan(0);
  });

  it('runs for every weapon mode in the data set', () => {
    for (const w of weapons) {
      for (const m of w.modes) {
        const r = simulate({ ...emptyBuild, weaponId: w.id, modeName: m.name });
        expect(Number.isFinite(r.totalDps), `${w.id}/${m.name}`).toBe(true);
        expect(r.totalDps).toBeGreaterThan(0);
      }
    }
  });
});

describe('weave mode', () => {
  const base: Build = { ...emptyBuild, weaponId: 'Engine_Rifle', modeName: 'Automatic Fire' };

  it('is absent from the result when unset', () => {
    expect(simulate(base).weave).toBeUndefined();
  });

  it('blends main and weave mode weaponDps by the weave rate', () => {
    const withBlessing: Build = {
      ...base,
      modeName: 'Engine Rev', // Secondary
      weaveModeName: 'Automatic Fire', // Primary
      aspects: { primary: 'Blood', secondary: null, ability: null },
      blessings: { Blood_Primary: 1 },
    };
    const rate = 0.3;
    const r = simulate(withBlessing, { weakspotAccuracy: 0, weaveRate: rate });

    const mainOnly = simulate({ ...withBlessing, weaveModeName: null }, { weakspotAccuracy: 0 });
    const weaveOnly = simulate(
      { ...withBlessing, modeName: 'Automatic Fire', weaveModeName: null },
      { weakspotAccuracy: 0 },
    );

    expect(r.weaponDps).toBeCloseTo(mainOnly.weaponDps * (1 - rate) + weaveOnly.weaponDps * rate, 5);
    expect(r.weave?.rate).toBeCloseTo(rate, 5);

    // The Primary-scoped blessing helps Automatic Fire's own DPS...
    const bareAutoFire = simulate({ ...base, modeName: 'Automatic Fire' }, { weakspotAccuracy: 0 });
    expect(weaveOnly.weaponDps).toBeGreaterThan(bareAutoFire.weaponDps);
    // ...but not Engine Rev's, since the blessing is Primary-scoped.
    const bareEngineRev = simulate({ ...base, modeName: 'Engine Rev' }, { weakspotAccuracy: 0 });
    expect(mainOnly.weaponDps).toBeCloseTo(bareEngineRev.weaponDps, 5);
  });

  it("doesn't blend per-hit/per-shot/stats -- those stay main-mode only", () => {
    const withWeave: Build = { ...base, weaveModeName: 'Engine Rev' };
    const r = simulate(withWeave, { weaveRate: 0.5 });
    const mainOnly = simulate(base);
    expect(r.perHit).toBeCloseTo(mainOnly.perHit, 5);
    expect(r.stats.damageMultiplier).toBeCloseTo(mainOnly.stats.damageMultiplier, 5);
  });

  it('warns and ignores a weave mode of the same fire type as the main mode', () => {
    const b: Build = { ...base, weaveModeName: 'Burst Fire' }; // also Primary
    const r = simulate(b, { weaveRate: 0.5 });
    expect(r.weave).toBeUndefined();
    expect(r.warnings.some((w) => w.includes('other fire type'))).toBe(true);
    expect(r.weaponDps).toBeCloseTo(simulate(base).weaponDps, 5);
  });

  it('warns and ignores an unknown weave mode name', () => {
    const b: Build = { ...base, weaveModeName: 'Not A Real Mode' };
    const r = simulate(b, { weaveRate: 0.5 });
    expect(r.weave).toBeUndefined();
    expect(r.warnings.some((w) => w.includes('Not A Real Mode'))).toBe(true);
  });
});

describe('breakdown accuracy', () => {
  const base: Build = { ...emptyBuild, weaponId: 'Engine_Rifle', modeName: 'Automatic Fire' };

  it('excludes a scope-locked contribution that is not part of the simulated mode(s)', () => {
    const b: Build = {
      ...base,
      modeName: 'Engine Rev', // Secondary
      aspects: { primary: 'Blood', secondary: null, ability: null },
      blessings: { Blood_Primary: 1 },
    };
    const r = simulate(b, { weakspotAccuracy: 0 });
    expect(r.breakdown.some((entry) => entry.source === 'Blood Primary')).toBe(false);
  });

  it('includes a scope-locked contribution once a matching weave mode is added', () => {
    const b: Build = {
      ...base,
      modeName: 'Engine Rev',
      weaveModeName: 'Automatic Fire',
      aspects: { primary: 'Blood', secondary: null, ability: null },
      blessings: { Blood_Primary: 1 },
    };
    const r = simulate(b, { weakspotAccuracy: 0, weaveRate: 0.3 });
    expect(r.breakdown.some((entry) => entry.source === 'Blood Primary')).toBe(true);
  });
});

describe('data integrity', () => {
  it('has the expected entity counts', () => {
    expect(blessings).toHaveLength(220);
    expect(charms).toHaveLength(40);
    expect(weapons).toHaveLength(9);
    expect(abilities).toHaveLength(6);
    expect(soulSkills).toHaveLength(43);
    expect(weapons.flatMap((w) => w.modes)).toHaveLength(54);
    expect(weapons.flatMap((w) => w.forgeUpgrades)).toHaveLength(72);
    expect(abilities.flatMap((a) => a.forgeUpgrades)).toHaveLength(66);
  });

  it('gives every fire mode parsed impact damage and a rate', () => {
    for (const w of weapons) {
      for (const m of w.modes) {
        expect(m.damageParsed, `${w.id}/${m.name}`).not.toBe('unparsed');
        expect(m.fireRate, `${w.id}/${m.name}`).toBeGreaterThan(0);
      }
    }
  });

  it('gives every entity either effects or an unmodeled reason', () => {
    const all = [
      ...blessings,
      ...charms,
      ...soulSkills,
      ...weapons.flatMap((w) => w.forgeUpgrades),
      ...abilities.flatMap((a) => a.forgeUpgrades),
    ];
    for (const e of all) {
      expect(e.effects.length > 0 || e.unmodeled !== undefined, e.name).toBe(true);
    }
  });

  it('has one aspect card per slot for each of the 11 aspects', () => {
    const aspectCards = blessings.filter((b) => b.kind === 'aspect');
    expect(aspectCards).toHaveLength(33);
    for (const slot of ['primary', 'secondary', 'ability'] as const) {
      expect(aspectCards.filter((b) => b.slot === slot)).toHaveLength(11);
    }
  });
});
