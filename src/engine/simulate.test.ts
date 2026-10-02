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
    // Automatic Fire: 32 damage, 64 weakspot, 8 shots/s, clip 30, reload 1.6s
    // (real game values, extracted from data/weapons.json's own RBaseWeaponSettings).
    // At 50% weakspot accuracy: (32 + 64) / 2 = 48 per hit, x0.95 accuracy = 45.6
    // Cycle: 30/8 + 1.6 = 5.35s for 30 shots => 1368 / 5.35 = 255.7 dps
    const r = simulate(base, { weakspotAccuracy: 0.5, accuracy: 0.95 });
    expect(r.perHit).toBeCloseTo(48, 5);
    expect(r.perShot).toBeCloseTo(45.6, 5);
    expect(r.weaponDps).toBeCloseTo(255.7, 1);
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
    expect(fast.stats.fireRate).toBeCloseTo(9.2, 5);
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
    // 200 damage x (one charge per 5s recharge + 3 charges refilled each 30s encounter) = 60 dps
    expect(r.abilityDps).toBeCloseTo(200 * (1 / 5 + 3 / 30), 5);
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
    // Brine Revolver: no heat or Combo Points, so the blend is a plain time share.
    const withBlessing: Build = {
      ...emptyBuild,
      weaponId: 'Brine_Revolver',
      modeName: 'Steady Scope', // Secondary
      weaveModeName: 'Semi-automatic', // Primary
      aspects: { primary: 'Blood', secondary: null, ability: null },
      blessings: { Blood_Primary: 1 },
    };
    const rate = 0.3;
    const r = simulate(withBlessing, { weakspotAccuracy: 0, weaveRate: rate });
    const mainOnly = simulate({ ...withBlessing, weaveModeName: null }, { weakspotAccuracy: 0 });
    const weaveOnly = simulate(
      { ...withBlessing, modeName: 'Semi-automatic', weaveModeName: null },
      { weakspotAccuracy: 0 },
    );
    // Raw weapon damage blends linearly; Hemorrhage's damage-taken bonus (scaled by its
    // uptime, which depends on how often the Primary mode fires) multiplies on top.
    const raw = (x: typeof r) => x.weaponDps / x.vulnerability;
    expect(raw(r)).toBeCloseTo(raw(mainOnly) * (1 - rate) + raw(weaveOnly) * rate, 5);
    expect(r.vulnerability).toBeGreaterThan(1);
    expect(r.weave?.rate).toBeCloseTo(rate, 5);
    // The Primary-scoped blessing helps the Primary's own DPS but not the Secondary's.
    const bare = (modeName: string) =>
      simulate({ ...emptyBuild, weaponId: 'Brine_Revolver', modeName }, { weakspotAccuracy: 0 });
    expect(weaveOnly.weaponDps).toBeGreaterThan(bare('Semi-automatic').weaponDps);
    expect(mainOnly.weaponDps).toBeCloseTo(bare('Steady Scope').weaponDps, 5);
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

describe('weapon uptime', () => {
  const base: Build = {
    ...emptyBuild,
    weaponId: 'Engine_Rifle',
    modeName: 'Automatic Fire',
    abilityId: 'frag_grenade',
  };

  it('defaults to 1.0, matching pre-existing behavior', () => {
    const r = simulate(base);
    const withDefault = simulate(base, { weaponUptime: 1.0 });
    expect(r.weaponDps).toBeCloseTo(withDefault.weaponDps, 5);
  });

  it('zeroes weapon and DoT DPS while leaving ability DPS untouched', () => {
    const full = simulate(base, { weaponUptime: 1 });
    const pureAbility = simulate(base, { weaponUptime: 0 });
    expect(pureAbility.weaponDps).toBe(0);
    expect(pureAbility.dotDps).toBe(0);
    expect(pureAbility.abilityDps).toBeCloseTo(full.abilityDps, 5);
  });

  it('scales weaponDps proportionally, including a blended weave', () => {
    const withWeave: Build = { ...base, weaveModeName: 'Engine Rev' };
    const full = simulate(withWeave, { weaveRate: 0.3, weaponUptime: 1 });
    const half = simulate(withWeave, { weaveRate: 0.3, weaponUptime: 0.4 });
    expect(half.weaponDps).toBeCloseTo(full.weaponDps * 0.4, 5);
    expect(half.weave!.weaponDps).toBeCloseTo(full.weave!.weaponDps * 0.4, 5);
  });

  it('is ignored (treated as 1) when no ability is equipped', () => {
    const noAbility: Build = { ...base, abilityId: null };
    const r = simulate(noAbility, { weaponUptime: 0 });
    expect(r.weaponDps).toBeGreaterThan(0);
  });

  it('excludes primary/secondary breakdown contributions entirely when zeroed', () => {
    const b: Build = {
      ...base,
      aspects: { primary: 'Blood', secondary: null, ability: null },
      blessings: { Blood_Primary: 1 },
    };
    const r = simulate(b, { weaponUptime: 0 });
    expect(r.breakdown.some((entry) => entry.source === 'Blood Primary')).toBe(false);
  });
});

describe('ability-cooldown and ability-charge effects', () => {
  it('Freebie (abilityCooldown -50%) raises abilityDps', () => {
    const bare: Build = { ...emptyBuild, abilityId: 'frag_grenade' };
    const withFreebie: Build = { ...bare, charmIds: ['freebie'] };
    const r = simulate(withFreebie);
    // Halves the 5s recharge; the per-encounter refill is unchanged.
    expect(r.abilityDps).toBeCloseTo(200 * (1 / 2.5 + 3 / 30), 5);
  });

  it('Compact Grenade halves effective charges alongside tripling damage', () => {
    const b: Build = {
      ...emptyBuild,
      abilityId: 'frag_grenade',
      abilityUpgrades: ['Compact Grenade'],
    };
    const r = simulate(b);
    // damage 200 x3 (mult +2.0); 2 charges (3 rounded-halved) refilled per encounter
    expect(r.abilityDps).toBeCloseTo(200 * 3 * (1 / 5 + 2 / 30), 5);
  });

  it("Activate Gun Mode raises weaponDps only when an ability is equipped", () => {
    const base: Build = {
      ...emptyBuild,
      weaponId: 'Engine_Rifle',
      modeName: 'Automatic Fire',
      abilityId: 'frag_grenade',
    };
    const withCharm: Build = { ...base, charmIds: ['activate_gun_mode'] };
    expect(simulate(withCharm).weaponDps).toBeGreaterThan(simulate(base).weaponDps);

    const noAbility: Build = { ...base, abilityId: null, charmIds: ['activate_gun_mode'] };
    const noAbilityBare: Build = { ...base, abilityId: null };
    expect(simulate(noAbility).weaponDps).toBeCloseTo(simulate(noAbilityBare).weaponDps, 5);
  });

  it('Sharp Shell scales its cooldown restore by weakspotAccuracy', () => {
    const b: Build = {
      ...emptyBuild,
      abilityId: 'frag_grenade',
      abilityUpgrades: ['Sharp Shell'],
    };
    const low = simulate(b, { weakspotAccuracy: 0 });
    const high = simulate(b, { weakspotAccuracy: 1 });
    expect(high.abilityDps).toBeGreaterThan(low.abilityDps);
  });

  it('Self-sustaining (stacking abilityCooldown) raises abilityDps for the Anchor', () => {
    const bare: Build = { ...emptyBuild, abilityId: 'anchor' };
    const withUpgrade: Build = { ...bare, abilityUpgrades: ['Self-sustaining'] };
    expect(simulate(withUpgrade).abilityDps).toBeGreaterThan(simulate(bare).abilityDps);
  });
});

describe('audit fixes: correctness bugs', () => {
  it('Softening Acid boosts Secondary only, matching "your next Secondary"', () => {
    const primary: Build = {
      ...emptyBuild,
      weaponId: 'Fish_Deity',
      modeName: 'Rapid Goo', // Primary
      weaponUpgrades: ['Softening Acid'],
    };
    const bare: Build = { ...primary, weaponUpgrades: [] };
    expect(simulate(primary).stats.damageMultiplier).toBeCloseTo(simulate(bare).stats.damageMultiplier, 5);

    const secondary: Build = { ...primary, modeName: 'Piercing Stab' }; // Secondary
    expect(simulate(secondary).stats.damageMultiplier).toBeGreaterThan(
      simulate({ ...secondary, weaponUpgrades: [] }).stats.damageMultiplier,
    );
  });

  it('Blessed Harpoons boosts both Primary and Secondary', () => {
    const primary: Build = {
      ...emptyBuild,
      weaponId: 'Harpoon_Gun',
      modeName: 'Piercing Harpoons', // Primary
      weaponUpgrades: ['Blessed Harpoons'],
    };
    const secondary: Build = { ...primary, modeName: 'Barbed Harpoons' }; // Secondary
    expect(simulate(primary).stats.damageMultiplier).toBeCloseTo(1.1, 5);
    expect(simulate(secondary).stats.damageMultiplier).toBeCloseTo(1.1, 5);
  });

  it('Raging Flames stacks once per burning enemy in the target scenario', () => {
    const b: Build = {
      ...emptyBuild,
      weaponId: 'Engine_Rifle',
      modeName: 'Automatic Fire',
      aspects: { primary: 'Flares', secondary: null, ability: null },
      blessings: { Raging_Flames: 1 },
    };
    // Automatic Fire's base fire rate is 8/s; +10% per affected enemy.
    expect(simulate(b, { target: 'boss' }).stats.fireRate).toBeCloseTo(8 * 1.1, 5);
    expect(simulate(b, { target: 'pack' }).stats.fireRate).toBeCloseTo(8 * 1.5, 5);
  });

  it("Headwind no longer subtracts from the player's own damage", () => {
    const b: Build = {
      ...emptyBuild,
      weaponId: 'Engine_Rifle',
      modeName: 'Automatic Fire',
      aspects: { primary: null, secondary: null, ability: 'Windburst' },
      blessings: { Headwind: 1 },
    };
    expect(simulate(b).stats.damageMultiplier).toBe(1);
  });
});

describe('audit fixes: new DSL-expressible effects', () => {
  it('Hate Forged (10% chance for triple damage) raises the average damage multiplier', () => {
    const b: Build = { ...emptyBuild, charmIds: ['hate_forged'] };
    expect(simulate(b).stats.damageMultiplier).toBeCloseTo(1.2, 5); // 0.1 chance x (3x - 1x)
  });

  it('a trigger-nested proc is scaled by the trigger chance, not applied at full strength', () => {
    const b: Build = {
      ...emptyBuild,
      weaponId: 'Fish_Deity',
      modeName: 'Piercing Stab',
      abilityId: 'smiting_spear',
      abilityUpgrades: ['Shockwave'],
    };
    const withUpgrade = simulate(b);
    const bare = simulate({ ...b, abilityUpgrades: [] });
    // Guaranteed on-stick 40 flat + ~1/3 chance of another 40 -- strictly more
    // than the guaranteed hit alone, and less than double it.
    const gain = withUpgrade.weaponDps - bare.weaponDps;
    expect(gain).toBeGreaterThan(0);
  });

  it('Repeating Jabs scales its extra stab with weakspotAccuracy via the trigger fix', () => {
    const b: Build = {
      ...emptyBuild,
      weaponId: 'Harpoon_Gun',
      modeName: 'Piercing Harpoons',
      weaponUpgrades: ['Repeating Jabs'],
    };
    const low = simulate(b, { weakspotAccuracy: 0 });
    const high = simulate(b, { weakspotAccuracy: 1 });
    const bare = simulate({ ...b, weaponUpgrades: [] }, { weakspotAccuracy: 0 });
    expect(low.weaponDps).toBeCloseTo(bare.weaponDps, 5);
    expect(high.weaponDps).toBeGreaterThan(low.weaponDps);
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

describe('ideal defaults and target scenario', () => {
  const bow: Build = { ...emptyBuild, weaponId: 'Combat_Bow', modeName: 'Exploding Arrow' };

  it('assumes every shot lands and stacks are full by default', () => {
    expect(defaultOptions.accuracy).toBe(1);
    expect(defaultOptions.stackFullness).toBe(1);
    expect(defaultOptions.target).toBe('boss');
  });

  it('lets area damage hit all 5 enemies of a pack, but a direct hit only one', () => {
    const boss = simulate(bow, { target: 'boss', weakspotAccuracy: 0 });
    const pack = simulate(bow, { target: 'pack', weakspotAccuracy: 0 });
    // Exploding Arrow at full charge: 119 impact + 306 explosion.
    expect(boss.perShot).toBeCloseTo(119 + 306, 5);
    expect(pack.perShot).toBeCloseTo(119 + 306 * 5, 5);
    expect(pack.assumptions.some((a) => a.source === 'Exploding Arrow')).toBe(true);
    expect(boss.assumptions.some((a) => a.source === 'Exploding Arrow')).toBe(false);
  });

  it('multiplies an area ability by the pack size, not a single-target one', () => {
    const grenade: Build = { ...emptyBuild, abilityId: 'frag_grenade' };
    const core: Build = { ...emptyBuild, abilityId: 'ancient_core' };
    expect(simulate(grenade, { target: 'pack' }).abilityDps).toBeCloseTo(
      simulate(grenade, { target: 'boss' }).abilityDps * 5,
      5,
    );
    expect(simulate(core, { target: 'pack' }).abilityDps).toBeCloseTo(simulate(core, { target: 'boss' }).abilityDps, 5);
  });

  it('gates Elite/Boss and standard-enemy conditions on the target', () => {
    const eff: Effect[] = [
      { op: 'conditional', when: 'targetIsEliteOrBoss', then: [{ op: 'mult', stat: 'damage', scope: 'all', value: 0.2 }] },
      { op: 'conditional', when: 'targetIsStandard', then: [{ op: 'mult', stat: 'damage', scope: 'all', value: 0.1 }] },
    ];
    const boss = new Modifiers();
    applyEffects(boss, eff, 'test', { ...opts, target: 'boss' });
    const pack = new Modifiers();
    applyEffects(pack, eff, 'test', { ...opts, target: 'pack' });
    expect(boss.multFor('damage', 'all')).toBeCloseTo(0.2);
    expect(pack.multFor('damage', 'all')).toBeCloseTo(0.1);
  });

  it('records what stacking, status conditions and chances assume', () => {
    const m = new Modifiers();
    applyEffects(
      m,
      [
        { op: 'stacking', stat: 'damage', scope: 'all', valuePer: 0.1, per: 'hit', max: 5 },
        { op: 'conditional', when: 'targetHasStatus', status: 'fire', then: [{ op: 'mult', stat: 'damage', scope: 'all', value: 0.1 }] },
        { op: 'trigger', on: 'hit', chance: 0.3, then: [{ op: 'mult', stat: 'fireRate', scope: 'all', value: 0.2 }] },
      ],
      'Pick',
      opts,
    );
    expect(m.assumptions.map((a) => a.text)).toEqual([
      '5 of 5 stacks',
      'the target always has fire',
      'averaged over its 30% chance per hit',
    ]);
  });
});

describe('charms', () => {
  const bow: Build = { ...emptyBuild, weaponId: 'Combat_Bow', modeName: 'Exploding Arrow' };

  it('Overkill carries half a hit per kill, doubled, in a pack only', () => {
    const r = simulate({ ...emptyBuild, charmIds: ['overkill'] }, { target: 'pack' });
    const kills = r.weaponDps / 500;
    expect(r.aspects.find((a) => a.name === 'Overkill')?.dps).toBeCloseTo(kills * (r.perHit / 2) * 2, 5);
    expect(simulate({ ...emptyBuild, charmIds: ['overkill'] }, { target: 'boss' }).aspectDps).toBe(0);
  });

  it('Plasma orbs explode: weakspot hit on the target, normal damage on the rest of the pack', () => {
    const plasma: Build = { ...emptyBuild, weaponId: 'Plasma_Launcher', modeName: 'Semi-automatic' };
    const boss = simulate(plasma, { target: 'boss', weakspotAccuracy: 1 });
    const pack = simulate(plasma, { target: 'pack', weakspotAccuracy: 1 });
    expect(boss.perShot).toBeCloseTo(360, 5); // 180 x2 weakspot on the target
    expect(pack.perShot).toBeCloseTo(360 + 180 * 4, 5);
    // Mr. Boom repeats the whole explosion.
    const boom = simulate({ ...plasma, charmIds: ['mr_boom'] }, { target: 'pack', weakspotAccuracy: 1 });
    expect(boom.perShot).toBeCloseTo((360 + 180 * 4) * 2, 5);
  });

  it('Power From Pain: +2% per 10 of 200 Health missing, nothing at full Health', () => {
    const b: Build = { ...emptyBuild, charmIds: ['power_from_pain'] };
    expect(simulate(b).stats.damageMultiplier).toBeCloseTo(1, 5);
    expect(simulate(b, { healthFraction: 0.5 }).stats.damageMultiplier).toBeCloseTo(1 + 0.02 * 10, 5);
  });

  it('Fan triples every direct hit', () => {
    const plain = simulate(emptyBuild, { weakspotAccuracy: 0 });
    expect(simulate({ ...emptyBuild, charmIds: ['fan'] }, { weakspotAccuracy: 0 }).perHit).toBeCloseTo(plain.perHit * 3, 5);
  });

  it('Mr. Boom doubles explosion components but not direct hits', () => {
    const plain = simulate(bow, { weakspotAccuracy: 0 });
    const boom = simulate({ ...bow, charmIds: ['mr_boom'] }, { weakspotAccuracy: 0 });
    expect(boom.perShot - plain.perShot).toBeCloseTo(306, 5); // one more 306 explosion
  });

  it('Ms. Boom adds a 50% chance of a 110% explosion that Mr. Boom repeats', () => {
    const plain = simulate(emptyBuild, { weakspotAccuracy: 0 });
    const ms = simulate({ ...emptyBuild, charmIds: ['ms_boom'] }, { weakspotAccuracy: 0 });
    expect(ms.perShot).toBeCloseTo(plain.perShot * (1 + 0.5 * 1.1), 5);
    const both = simulate(
      { ...emptyBuild, charmIds: ['ms_boom', 'mr_boom'], soulSkillIds: ['charm_power'] },
      { weakspotAccuracy: 0 },
    );
    expect(both.perShot).toBeCloseTo(plain.perShot * (1 + 0.5 * 1.1 * 2), 5);
  });
});

describe('ability timing', () => {
  it('Turret deals its whole lifetime of shots per cast', () => {
    const r = simulate({ ...emptyBuild, abilityId: 'turret' });
    // 50 x 2/s for 18.75s, one cast per 25s recharge + 1 charge per 30s encounter.
    expect(r.abilityDps).toBeCloseTo(50 * 2 * 18.75 * (1 / 25 + 1 / 30), 5);
  });

  it('caps recasts at the input cooldown', () => {
    const r = simulate({ ...emptyBuild, abilityId: 'frag_grenade', charmIds: ['freebie'], abilityUpgrades: ['Rich Get Richer'] });
    expect(r.abilityDps).toBeLessThanOrEqual(200 / 0.4 + 1e-9);
  });

  it('Active Reload resets the Core whenever a cast kills a pack enemy', () => {
    const core: Build = { ...emptyBuild, abilityId: 'ancient_core' };
    const reload = { ...core, abilityUpgrades: ['Active Reload'] };
    // 1000 damage kills a 500 HP enemy: recast every 2s input cooldown.
    expect(simulate(reload, { target: 'pack' }).abilityDps).toBeCloseTo(1000 / 2, 5);
    expect(simulate(reload, { target: 'boss' }).abilityDps).toBeCloseTo(simulate(core, { target: 'boss' }).abilityDps, 5);
  });
});

describe('Engine Rifle heat', () => {
  const rifle = (modeName: string, weave: string | null = null, weaponUpgrades: string[] = []): Build => ({
    ...emptyBuild, weaponId: 'Engine_Rifle', modeName, weaveModeName: weave, weaponUpgrades,
  });

  it('feathers a heat mode: Engine Rev holds the trigger half the time (10/s x 4 heat vs 40 cooling)', () => {
    const r = simulate(rifle('Engine Rev'), { weakspotAccuracy: 0 });
    expect(r.weaponDps).toBeCloseTo(35 * 10 * 0.5, 5);
    expect(r.stats.clipSize).toBeNull();
  });

  it('lets a woven Primary fill the cooling time', () => {
    // Engine Rev 50% of the time (its full feather duty) + Automatic Fire the rest.
    const r = simulate(rifle('Engine Rev', 'Automatic Fire'), { weakspotAccuracy: 0, weaveRate: 0.5 });
    const auto = simulate(rifle('Automatic Fire'), { weakspotAccuracy: 0 });
    expect(r.weaponDps).toBeCloseTo(35 * 10 * 0.5 + auto.weaponDps * 0.5, 5);
  });

  it('Prolonged Revving removes 3 Heat per hit: Engine Rev now heats 1 per shot', () => {
    const r = simulate(rifle('Engine Rev', null, ['Prolonged Revving']), { weakspotAccuracy: 0 });
    expect(r.weaponDps).toBeCloseTo(35 * 10 * (40 / (10 * 1 + 40)), 5);
  });

  it('Heat Converter runs at full Heat while feathering, for every mode in use', () => {
    const plain = simulate(rifle('Engine Rev'), { weakspotAccuracy: 0 });
    const hot = simulate(rifle('Engine Rev', null, ['Heat Converter']), { weakspotAccuracy: 0 });
    expect(hot.weaponDps / plain.weaponDps).toBeCloseTo(2, 5);
    // A Primary used alone builds no Heat, so it gets nothing.
    expect(simulate(rifle('Automatic Fire', null, ['Heat Converter'])).weaponDps).toBeCloseTo(
      simulate(rifle('Automatic Fire')).weaponDps, 5);
  });

  it('a gun that never heats gets nothing from Heat Converter', () => {
    // Fan triples hits, so Prolonged Revving refunds 9 Heat per 4-Heat shot: always cold.
    const cold = (up: string[]): Build => ({ ...rifle('Engine Rev', null, ['Prolonged Revving', ...up]), charmIds: ['fan'] });
    const r = simulate(cold(['Heat Converter']), { weakspotAccuracy: 0 });
    expect(r.weaponDps).toBeCloseTo(simulate(cold([]), { weakspotAccuracy: 0 }).weaponDps, 5);
    expect(r.assumptions.some((a) => a.text.includes('runs cold'))).toBe(true);
  });

  it('Heat Expulsion makes deliberate overheating worth it, once per overheat', () => {
    const r = simulate(rifle('Concentrated Shot', null, ['Heat Expulsion']), { weakspotAccuracy: 0 });
    expect(r.assumptions.some((a) => a.text === 'you overheat on purpose each cycle')).toBe(true);
    // 100 heat / 12 per shot = 8.33 shots in 0.83s, then 5s locked: one 1000% explosion per 5.83s.
    const time = 100 / (12 * 10) + 5;
    expect(r.weaponDps).toBeCloseTo(((100 / 12) * 100 + 10 * 100) / time, 3);
  });
});

describe('Harpoon Combo Points', () => {
  // Piercing: 6 shots per 5s + 2s reload = 0.857/s. Barbed / Brine-Powered: 6 per 12s + 2s = 0.429/s.
  const harpoon = (modeName: string, weave: string | null, weaponUpgrades: string[] = []): Build => ({
    ...emptyBuild, weaponId: 'Harpoon_Gun', modeName, weaveModeName: weave, weaponUpgrades,
  });

  it('spends no points without Primary hits: Barbed falls to its 0-point value', () => {
    const r = simulate(harpoon('Barbed Harpoons', null), { weakspotAccuracy: 0 });
    // Listed damage assumes 4 points (curve 6.0); 0 points is curve 0.5.
    expect(r.assumptions.some((a) => a.text.startsWith('0.0 of 4 Combo Points'))).toBe(true);
    expect(r.perShot).toBeCloseTo(50 * (0.5 / 6), 5);
  });

  it('banks 4 points per Secondary when Primaries fire two thirds of the time', () => {
    const r = simulate(harpoon('Barbed Harpoons', 'Piercing Harpoons'), { weakspotAccuracy: 0, weaveRate: 2 / 3 });
    expect(r.assumptions.some((a) => a.text.startsWith('4.0 of 4'))).toBe(true);
    expect(r.perShot).toBeCloseTo(50, 5); // the listed 4-point damage
  });

  it('Increased Combo spends 5 points: Brine-Powered x18/12', () => {
    const plain = simulate(harpoon('Brine-Powered Harpoons', 'Piercing Harpoons'), { weakspotAccuracy: 0, weaveRate: 0.9 });
    const inc = simulate(harpoon('Brine-Powered Harpoons', 'Piercing Harpoons', ['Increased Combo']), { weakspotAccuracy: 0, weaveRate: 0.9 });
    expect(inc.perShot / plain.perShot).toBeCloseTo(18 / 12, 5);
  });
});

describe('Turret extras', () => {
  const turret = (abilityUpgrades: string[] = []): Build => ({ ...emptyBuild, abilityId: 'turret', abilityUpgrades });

  it('Buddy System: 15s recharge, x0.75 damage, +25% per other Turret out', () => {
    const casts = 1 / 15 + 1 / 30;
    const alive = casts * 18.75;
    const r = simulate(turret(['Buddy System']));
    expect(r.abilityDps).toBeCloseTo(50 * 2 * 18.75 * 0.75 * casts * (1 + 0.25 * (alive - 1)), 5);
  });

  it('Ammo Transfer stretches your clip with rounds from Turret shots', () => {
    const plain = simulate(turret(), { weakspotAccuracy: 0 });
    const r = simulate(turret(['Ammo Transfer']), { weakspotAccuracy: 0 });
    const rounds = 0.6 * 2 * (1 / 25 + 1 / 30) * 18.75;
    // Automatic Fire: 30 rounds at 8/s + 1.6s reload.
    const shots = 30 / (30 / 8 + 1.6);
    const ref = Math.min(0.95, rounds / shots);
    const k = (30 / (1 - ref) / (30 / (1 - ref) / 8 + 1.6)) / shots;
    expect(r.weaponDps / plain.weaponDps).toBeCloseTo(k, 5);
  });
});

describe('out-of-scope picks', () => {
  it('lists melee/ally picks apart from gaps', () => {
    const r = simulate({
      ...emptyBuild,
      aspects: { primary: 'Frozen', secondary: null, ability: null },
      blessings: { Frozen_Primary: 1, Thawing_Strike: 1 },
    });
    const u = r.unmodeled.find((x) => x.name === 'Thawing Strike')!;
    expect(u.outOfScope).toBe(true);
    expect(u.utility).toBeFalsy();
  });
});

describe('Automatic Detonation', () => {
  it('fires the Secondary on every Primary weakspot hit', () => {
    const disc = (weaponUpgrades: string[]): Build => ({ ...emptyBuild, weaponId: 'Disc_Thrower', modeName: 'Automatic', weaponUpgrades });
    const plain = simulate(disc([]), { weakspotAccuracy: 0.5 });
    const auto = simulate(disc(['Automatic Detonation']), { weakspotAccuracy: 0.5 });
    const secondary = simulate({ ...emptyBuild, weaponId: 'Disc_Thrower', modeName: 'Inferno Discs' }, { weakspotAccuracy: 0.5 }).perShot;
    const hitsPerSecond = plain.weaponDps / plain.perShot; // one disc per shot
    expect(auto.weaponDps - plain.weaponDps).toBeCloseTo(hitsPerSecond * 0.5 * secondary, 5);
  });
});

describe('Smiting Spear concurrency', () => {
  const spear = (abilityUpgrades: string[] = []): Build => ({ ...emptyBuild, abilityId: 'smiting_spear', abilityUpgrades });
  const casts = 1 / 8 + 1 / 30; // one per 8s recharge + 1 charge per 30s encounter
  const out = casts * 9; // spears out at once (9s each)

  it('counts the spears out at once', () => {
    const r = simulate(spear());
    expect(r.abilityDps).toBeCloseTo(600 * casts, 5); // 200 impact + 8 x 50 pulses
    expect(r.assumptions.some((a) => a.text === `${out.toFixed(1)} spears out at once`)).toBe(true);
  });

  it('Chain Pulse makes every pulse 60% likely to pulse each other spear', () => {
    const r = simulate(spear(['Chain Pulse']));
    expect(r.abilityDps).toBeCloseTo(casts * (200 + 400 * (1 + 0.6 * (out - 1))), 5);
  });

  it('Split Spear throws three, and Spear Grid fills the space between them', () => {
    const split = simulate(spear(['Split Spear']));
    expect(split.abilityDps).toBeCloseTo(600 * 3 * casts, 5);
    const grid = simulate(spear(['Split Spear', 'Spear Grid']));
    expect(grid.abilityDps - split.abilityDps).toBeCloseTo(30 / 0.33, 5); // >= 2 spears out all the time
  });
});

describe('forge upgrades', () => {
  const fx = (weaponId: string, modeName: string, weaponUpgrades: string[], extra: Partial<Build> = {}): Build => ({
    ...emptyBuild, weaponId, modeName, weaponUpgrades, ...extra,
  });

  it('Greased Barrel averages +3% per 0.2s over each magazine', () => {
    // Automatic Fire: 30 rounds at 8/s = 3.75s held; +15%/s averaged over it = +28.1%.
    const r = simulate(fx('Engine_Rifle', 'Automatic Fire', ['Greased Barrel']), { weakspotAccuracy: 0 });
    expect(r.stats.damageMultiplier).toBeCloseTo(1 + 0.15 * 3.75 / 2, 5);
  });

  it('Larger Battery extends Charge Orb by two charge steps', () => {
    const plain = simulate(fx('Tesla_Gun', 'Charge Orb', []), { weakspotAccuracy: 0 });
    const big = simulate(fx('Tesla_Gun', 'Charge Orb', ['Larger Battery']), { weakspotAccuracy: 0 });
    // 97 > 120 > 142 > 165: +22.67 per step, two more steps.
    expect(big.perShot - plain.perShot).toBeCloseTo(((165 - 97) / 3) * 2, 5);
  });

  it('Critical Cylinder stretches the clip by refunded Weakspot shots', () => {
    const plain = simulate(fx('Brine_Revolver', 'Semi-automatic', []), { weakspotAccuracy: 1 });
    const crit = simulate(fx('Brine_Revolver', 'Semi-automatic', ['Critical Cylinder']), { weakspotAccuracy: 1 });
    expect(crit.perMagazine / plain.perMagazine).toBeCloseTo(2, 5); // half of all shots refunded
  });

  it('Charmed Harpoons follows the rarity of your charms', () => {
    const none = simulate(fx('Harpoon_Gun', 'Piercing Harpoons', ['Charmed Harpoons']));
    const common = simulate(fx('Harpoon_Gun', 'Piercing Harpoons', ['Charmed Harpoons'], { charmIds: ['hawkeye'] }));
    expect(common.stats.fireRate / none.stats.fireRate).toBeCloseTo(1.2, 5);
  });

  it('Cone Blast turns the Ancient Core into an area attack', () => {
    const core = { ...emptyBuild, abilityId: 'ancient_core' };
    const cone = { ...core, abilityUpgrades: ['Cone Blast'] };
    expect(simulate(cone, { target: 'pack' }).abilityDps).toBeCloseTo(simulate(core, { target: 'pack' }).abilityDps * 5, 5);
  });
});

describe('aspect-payload blessings stay off weapon damage', () => {
  // These boost an aspect's own payload (Fire DoT, Spirits, Windburst, Brine Ball)
  // or a non-simulated source (melee); they once leaked into weapon damage/all.
  const payloadOnly = [
    'Empowering_Flames', 'Critical_Flares', 'Barraging_Spirits', 'Spiritual_Exchange',
    'Growing_Spirits', 'Eye_of_the_Storm', 'Storm_Belt', 'Magnetic_Brine', 'Thawing_Strike',
    'Winds_Devastation', 'Frozen_Shards', 'Rapid_Tentacles', 'Rupturing_Shadows', 'Shadow_Conversion',
    'Explosive_Barrier', 'Exploding_Spirits', 'Fortunes_Riches',
  ];
  it.each(payloadOnly)('%s does not change weapon damage', (id) => {
    const aspect = blessings.find((b) => b.id === id)!.aspect;
    const b: Build = { ...emptyBuild, aspects: { primary: aspect, secondary: null, ability: null }, blessings: { [id]: 1 } };
    const bare: Build = { ...b, blessings: {} };
    // In a pack, so Frost's Knowledge (Elite/Boss damage per Frost blessing) stays out of it.
    const pack = { target: 'pack' } as const;
    expect(simulate(b, pack).stats.damageMultiplier).toBeCloseTo(simulate(bare, pack).stats.damageMultiplier, 5);
    expect(simulate(b, pack).weaponDps).toBeCloseTo(simulate(bare, pack).weaponDps, 5);
  });
});
