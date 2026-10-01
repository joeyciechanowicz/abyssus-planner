import { describe, expect, it } from 'vitest';
import { payloadDamage, scaledHit, type HitStream, type PayloadContext } from './payloads';
import { payloadByAspect } from '../model/data';
import { simulate } from './simulate';
import { emptyBuild, type Build } from '../model/build';

const stream = (over: Partial<HitStream> = {}): HitStream => ({
  slot: 'primary',
  directHitsPerSecond: 5,
  directHit: 100,
  areaEventsPerSecond: 0,
  areaHit: 0,
  procMultiplier: 1,
  ...over,
});
const ctx = (over: Partial<PayloadContext> = {}): PayloadContext => ({
  enemies: 1,
  primaryModeDamage: 100,
  targetMissingHealth: 0,
  gold: 1000,
  targetTier: 'boss',
  targetMaxHealth: 25000,
  payloadBonus: 0,
  ...over,
});
const payload = (aspect: string) => payloadByAspect.get(aspect)!;

describe('scaledHit', () => {
  const f = { base: 100, percent: 60, softCap: 500, percentAboveCap: 20 };
  it('scales the hit below the soft cap', () => expect(scaledHit(f, 200)).toBeCloseTo(100 + 120));
  it('switches to the post-cap percentage above it', () =>
    expect(scaledHit(f, 800)).toBeCloseTo(100 + 300 + 0.2 * 300));
});

describe('payloadDamage', () => {
  it('Chain Lightning: procs x payload, bouncing with 20% falloff in a pack', () => {
    const p = payload('Chain Lightning');
    const boss = payloadDamage(p, 0.2, [stream()], ctx());
    expect(boss.procsPerSecond).toBeCloseTo(1); // 5 hits/s x 20%
    expect(boss.dps).toBeCloseTo(100 + 60); // 1 proc/s x (100 + 60% of 100)
    const pack = payloadDamage(p, 0.2, [stream()], ctx({ enemies: 5 }));
    expect(pack.dps).toBeCloseTo(160 * (1 + 0.8 + 0.64 + 0.512 + 0.4096));
  });

  it('Windburst hits every enemy in the pack', () => {
    const p = payload('Windburst');
    const one = payloadDamage(p, 0.2, [stream()], ctx()).dps;
    expect(payloadDamage(p, 0.2, [stream()], ctx({ enemies: 5 })).dps).toBeCloseTo(one * 5);
  });

  it("multiplies proc chance by the mode's proc multiplier, capped at 100%", () => {
    const p = payload('Chain Lightning');
    expect(payloadDamage(p, 0.2, [stream({ procMultiplier: 4 })], ctx()).procsPerSecond).toBeCloseTo(4);
    expect(payloadDamage(p, 0.5, [stream({ procMultiplier: 4 })], ctx()).procsPerSecond).toBeCloseTo(5);
  });

  it('Hemorrhage: ticks from the primary damage stat, with uptime and a damage-taken bonus', () => {
    const p = payload('Blood');
    const r = payloadDamage(p, 1, [stream()], ctx({ primaryModeDamage: 50 }));
    const up = 1 - Math.exp(-5 * 4); // 5 procs/s, 4s duration
    expect(r.dps).toBeCloseTo((8 + 0.02 * 50) * 4 * up); // 4 ticks/s
    expect(r.vulnerability).toBeCloseTo(1 + 0.2 * up);
    const hurt = payloadDamage(p, 1, [stream()], ctx({ primaryModeDamage: 50, targetMissingHealth: 0.5 }));
    expect(hurt.dps).toBeCloseTo(r.dps * 1.5);
  });

  it('spreads direct hits over a pack, so a DoT is up less on each enemy', () => {
    const p = payload('Blood');
    const boss = payloadDamage(p, 0.2, [stream()], ctx());
    const pack = payloadDamage(p, 0.2, [stream()], ctx({ enemies: 5 }));
    const upBoss = 1 - Math.exp(-1 * 4);
    const upPack = 1 - Math.exp(-0.2 * 4);
    expect(boss.dps / upBoss).toBeCloseTo(pack.dps / upPack / 5);
  });

  it('Tentacles: alive count capped at 3, attacking every 2s for 100 + 25% of the trigger', () => {
    const p = payload('Tentacles');
    const r = payloadDamage(p, 0.4, [stream()], ctx());
    expect(r.dps).toBeCloseTo((3 * (100 + 25)) / 2);
    // A trickle of procs keeps fewer alive: 0.1 procs/s x 15s lifetime = 1.5 on average.
    const slow = payloadDamage(p, 0.02, [stream()], ctx());
    expect(slow.dps).toBeCloseTo((1.5 * 125) / 2);
  });

  it('Goldburst hits the struck enemy for your current Gold', () => {
    const p = payload('Goldburst');
    expect(payloadDamage(p, 0.2, [stream()], ctx({ gold: 750 })).dps).toBeCloseTo(1 * 750);
    // Direct hit only: a pack doesn't multiply it.
    expect(payloadDamage(p, 0.2, [stream()], ctx({ gold: 750, enemies: 5 })).dps).toBeCloseTo(750);
  });

  it('Freeze: build to min(10% HP, cap), shred 3% of half Health, blocked 5s while Frozen', () => {
    const p = payload('Frozen');
    // 500 damage/s on a 25,000 HP boss: threshold 2,500 -> 5s to build + 5s Frozen = 10s cycle.
    const r = payloadDamage(p, 1, [stream({ directHitsPerSecond: 5, directHit: 100 })], ctx());
    expect(r.dps).toBeCloseTo((0.03 * 25000 * 0.5) / 10);
    // Pack of 500 HP standard enemies: threshold 250 each, 100 dmg/s each -> 2.5s + 5s.
    const pack = payloadDamage(p, 1, [stream()], ctx({ enemies: 5, targetTier: 'standard', targetMaxHealth: 500 }));
    expect(pack.dps).toBeCloseTo((5 * Math.max(5, 0.1 * 500 * 0.5)) / 7.5);
  });

  it('Shadows deals no damage itself but makes enemies take 25% more', () => {
    const r = payloadDamage(payload('Shadows'), 1, [stream()], ctx());
    expect(r.dps).toBe(0);
    expect(r.vulnerability).toBeCloseTo(1.25);
  });

  it('adds a payload-scoped bonus on top', () => {
    const p = payload('Windburst');
    const plain = payloadDamage(p, 0.2, [stream()], ctx()).dps;
    expect(payloadDamage(p, 0.2, [stream()], ctx({ payloadBonus: 0.3 })).dps).toBeCloseTo(plain * 1.3);
  });
});

describe('aspect payloads in simulate()', () => {
  const card = (aspect: string, id: string): Build => ({
    ...emptyBuild,
    aspects: { primary: aspect, secondary: null, ability: null },
    blessings: { [id]: 1 },
  });

  it('adds Chain Lightning damage from Automatic Fire hits (hand-checked)', () => {
    // Automatic Fire: 32 dmg, 8/s, clip 30, 1.6s reload -> 30 shots per 5.35s cycle.
    // +15% from the card; 50% weakspots at 2x -> average hit 55.2.
    // 20% chance -> 1.1215 procs/s x (100 + 60% x 55.2) = 149.2 DPS.
    const r = simulate(card('Chain Lightning', 'Primary_Chain_Lightning'), { target: 'boss' });
    expect(r.aspectDps).toBeCloseTo((30 / 5.35) * 0.2 * (100 + 0.6 * 55.2), 1);
    expect(r.totalDps).toBeCloseTo(r.weaponDps + r.dotDps + r.abilityDps + r.aspectDps, 5);
  });

  it("uses the game's {Chance} over the card text (Tentacles: 40%, text says 30%)", () => {
    const r = simulate(card('Tentacles', 'Primary_Tentacles'));
    expect(r.aspects[0].name).toBe('Tentacle');
  });

  it('scales every damage source by Shadows vulnerability', () => {
    const shadowed = simulate(card('Shadows', 'Primary_Shadows'));
    const plain = simulate({ ...card('Shadows', 'Primary_Shadows'), blessings: {} });
    expect(shadowed.vulnerability).toBeCloseTo(1.25);
    expect(shadowed.weaponDps).toBeCloseTo(plain.weaponDps * 1.15 * 1.25, 5);
  });

  it('flags aspects whose payload is not modelled yet', () => {
    const r = simulate(card('Spirit', 'Spirit_Primary'));
    expect(r.aspectDps).toBe(0);
    expect(r.unmodeled.some((u) => u.name === 'Spirit aspect')).toBe(true);
  });

  it('only counts a card for hits from its own slot', () => {
    const secondaryCard: Build = {
      ...emptyBuild,
      aspects: { primary: null, secondary: 'Chain Lightning', ability: null },
      blessings: { Secondary_Chain_Lightning: 1 },
    };
    // emptyBuild fires the Primary mode only, so a Secondary card never procs.
    expect(simulate(secondaryCard).aspectDps).toBe(0);
  });
});

describe('blessings that modify a payload', () => {
  const build = (aspect: string, card: string, extra: Record<string, number>): Build => ({
    ...emptyBuild,
    aspects: { primary: aspect, secondary: null, ability: null },
    blessings: { [card]: 1, ...extra },
  });
  const aspect = (b: Build, opts = {}) => simulate(b, opts).aspectDps;

  it('Roaring Winds fires each Windburst twice; Raging Winds three times', () => {
    const base = aspect(build('Windburst', 'Windburst_Primary', {}));
    expect(aspect(build('Windburst', 'Windburst_Primary', { Roaring_Winds: 1 }))).toBeCloseTo(base * 2, 5);
    expect(aspect(build('Windburst', 'Windburst_Primary', { Raging_Winds: 1 }))).toBeCloseTo(base * 3, 5);
  });

  it('Storm Belt adds +10% Windburst damage per stack, up to 5', () => {
    const base = aspect(build('Windburst', 'Windburst_Primary', {}));
    expect(aspect(build('Windburst', 'Windburst_Primary', { Storm_Belt: 1 }))).toBeCloseTo(base * 1.5, 5);
  });

  it('Team Tentacles raises the cap from 3 to 5 alive', () => {
    const r = simulate(build('Tentacles', 'Primary_Tentacles', { Team_Tentacles: 1 }));
    expect(r.assumptions.some((a) => a.text.startsWith('5.0 of 5 Tentacles'))).toBe(true);
  });

  it('Loaded Bounce turns -20% per bounce into +5% in a pack', () => {
    const plain = aspect(build('Chain Lightning', 'Primary_Chain_Lightning', {}), { target: 'pack' });
    const loaded = aspect(build('Chain Lightning', 'Primary_Chain_Lightning', { Loaded_Bounce: 1 }), { target: 'pack' });
    const reach = (f: number) => [0, 1, 2, 3, 4].reduce((s, i) => s + (1 - f) ** i, 0);
    expect(loaded / plain).toBeCloseTo(reach(-0.05) / reach(0.2), 5);
  });

  it('Exponential Gold adds 20% of your Gold to each Goldburst', () => {
    const base = aspect(build('Goldburst', 'Primary_Goldburst', {}));
    expect(aspect(build('Goldburst', 'Primary_Goldburst', { Exponential_Gold: 1 }))).toBeCloseTo(base * 1.2, 5);
  });

  it('Creeping Shadows raises the Shadows bonus from +25% to +30%', () => {
    const r = simulate(build('Shadows', 'Primary_Shadows', { Creeping_Shadows: 1 }));
    expect(r.vulnerability).toBeCloseTo(1.3, 5);
    expect(r.assumptions.some((a) => a.source === 'Creeping Shadows')).toBe(true);
  });

  it('marks no-damage blessings as utility, not as a gap', () => {
    const r = simulate(build('Goldburst', 'Primary_Goldburst', { Golden_Pocket: 1, Erupting_Gold: 1 }));
    expect(r.unmodeled.find((u) => u.name === 'Golden Pocket')?.utility).toBe(true);
    expect(r.unmodeled.find((u) => u.name === 'Erupting Gold')?.utility).toBeFalsy();
  });
});
