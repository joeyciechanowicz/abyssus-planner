import {
  abilityById,
  blessingById,
  charmById,
  sharedAbilityUpgrades,
  soulSkillById,
  weaponById,
  type DamageComponent,
  type WeaponMode,
} from '../model/data';
import { defaultOptions, type Build, type SimOptions } from '../model/build';
import { Modifiers, applyEffects } from './stacking';
import { scaleBlessingEffects } from './blessingScaling';

export interface SimResult {
  /** Average damage of one landed hit, weakspot chance blended in. Main mode only. */
  perHit: number;
  /** Damage of one trigger pull (all projectiles). Main mode only. */
  perShot: number;
  /** Damage of a full magazine. Main mode only. */
  perMagazine: number;
  /** Sustained weapon DPS including reloads -- blended with the weave mode, if any. */
  weaponDps: number;
  /** Damage-over-time contribution per second -- blended with the weave mode, if any. */
  dotDps: number;
  /** Ability damage amortised over its cooldown. */
  abilityDps: number;
  /** weaponDps + dotDps + abilityDps. */
  totalDps: number;
  /** The main mode being simulated (`build.modeName`). */
  mode: { name: string; type: 'Primary' | 'Secondary' };
  /**
   * Present when `build.weaveModeName` names a valid mode of the other fire
   * type. `weaponDps`/`dotDps` here are already weighted by `rate` -- they are
   * this mode's literal share of the top-level `weaponDps`/`dotDps` above, not
   * that mode's own bare numbers.
   */
  weave?: { modeName: string; modeType: 'Primary' | 'Secondary'; rate: number; weaponDps: number; dotDps: number };
  /** Effective stats after modifiers. Main mode only, see `weave` above. */
  stats: {
    fireRate: number;
    clipSize: number | null;
    reloadTime: number;
    damageMultiplier: number;
    weakspotMultiplier: number;
  };
  /** Per-source contributions, biggest first. */
  breakdown: { source: string; stat: string; scope: string; value: number }[];
  /** Picks whose text the DSL could not express; their effect is NOT in the number. */
  unmodeled: { name: string; reason: string }[];
  /** True when any input used estimated rate-of-fire values (it almost always is). */
  usesEstimates: boolean;
  warnings: string[];
}

/** Sum a set of damage components at the given charge level. */
function componentTotal(
  components: DamageComponent[] | null,
  kinds: DamageComponent['kind'][],
  chargeLevel: number,
): number {
  if (!components) return 0;
  let total = 0;
  for (const c of components) {
    if (!kinds.includes(c.kind)) continue;
    const value = c.min + (c.max - c.min) * chargeLevel;
    total += value * c.count;
  }
  return total;
}

const ASPECT_SLOTS = ['primary', 'secondary', 'ability'] as const;

interface ModeOutput {
  perHit: number;
  perShot: number;
  perMagazine: number;
  weaponDps: number;
  dotDps: number;
  fireRate: number;
  clipSize: number | null;
  reloadTime: number;
  damageMultiplier: number;
  weakspotMultiplier: number;
}

/**
 * Damage/rate/DoT math for one weapon mode, given modifiers already
 * accumulated from the whole build. Pure function of `mode` and `mods` so it
 * can be called once for the main mode and once more for a weave mode without
 * re-collecting any picks' effects.
 */
function computeModeOutput(
  mode: WeaponMode,
  mods: Modifiers,
  opts: SimOptions,
  abilityDamage: number,
): ModeOutput {
  const scope = mode.type.toLowerCase() as 'primary' | 'secondary';

  const baseImpact = componentTotal(mode.damageComponents, ['impact'], opts.chargeLevel);
  const baseWeakspot =
    componentTotal(mode.weakspotComponents, ['impact'], opts.chargeLevel) || baseImpact * 2;
  const baseExtra = componentTotal(
    mode.damageComponents,
    ['explosion', 'pull', 'aoe'],
    opts.chargeLevel,
  );

  const damageMult = 1 + mods.multFor('damage', scope);
  const weakspotMult = 1 + mods.multFor('weakspotDamage', scope);
  const aoeMult = 1 + mods.multFor('aoeDamage', scope);

  // Weakspot damage is already the doubled figure in the wiki's own table, so the
  // weakspot bonus scales that rather than re-applying the x2.
  const normalHit = baseImpact * damageMult;
  const weakspotHit = baseWeakspot * damageMult * weakspotMult;
  const blendedImpact =
    normalHit * (1 - opts.weakspotAccuracy) + weakspotHit * opts.weakspotAccuracy;

  const procDamage = mods.procs.reduce((sum, p) => {
    const base =
      p.of === 'flat'
        ? p.amount
        : p.of === 'onHitDamage' || p.of === 'weaponDamage'
          ? blendedImpact * p.amount
          : p.of === 'abilityDamage'
            ? abilityDamage * p.amount
            : 0;
    return sum + base * p.chance;
  }, 0);

  const perShot = (blendedImpact + baseExtra * aoeMult + procDamage) * opts.accuracy;

  const fireRate = mode.fireRate * (1 + mods.multFor('fireRate', scope));
  const reloadTime = mode.reloadTime / (1 + mods.multFor('reloadSpeed', scope));
  const clipSize =
    mode.clipSize === null
      ? null
      : Math.max(1, Math.round(mode.clipSize * (1 + mods.multFor('clipSize', scope)) +
          mods.flatFor('clipSize')));

  const shotsPerCycle = clipSize ?? fireRate; // no clip => one second of uninterrupted fire
  const cycleTime = shotsPerCycle / fireRate + (clipSize === null ? 0 : reloadTime);
  const perMagazine = perShot * shotsPerCycle;
  const weaponDps = cycleTime > 0 ? perMagazine / cycleTime : 0;

  const dotMult = 1 + mods.multFor('dotDamage', 'dot');
  const dotPerApplication = componentTotal(mode.damageComponents, ['dot'], opts.chargeLevel);
  // A DoT is refreshed by fire, so treat it as landing once per shot but not
  // stacking beyond a single application at a time.
  const dotDps = dotPerApplication > 0 ? dotPerApplication * dotMult * Math.min(fireRate, 1) : 0;

  return {
    perHit: blendedImpact,
    perShot,
    perMagazine,
    weaponDps,
    dotDps,
    fireRate,
    clipSize,
    reloadTime,
    damageMultiplier: damageMult,
    weakspotMultiplier: weakspotMult,
  };
}

export function simulate(build: Build, options: Partial<SimOptions> = {}): SimResult {
  const opts: SimOptions = { ...defaultOptions, ...options };
  const warnings: string[] = [];
  const unmodeled: { name: string; reason: string }[] = [];
  const mods = new Modifiers();

  const weapon = weaponById.get(build.weaponId);
  if (!weapon) throw new Error(`unknown weapon: ${build.weaponId}`);
  const mode = weapon.modes.find((m) => m.name === build.modeName);
  if (!mode) throw new Error(`unknown mode: ${build.modeName} on ${build.weaponId}`);

  const collect = (name: string, effects: Parameters<typeof applyEffects>[1], reason?: string) => {
    if (effects.length === 0 && reason) unmodeled.push({ name, reason });
    applyEffects(mods, effects, name, opts);
  };

  // --- Blessings, restricted to aspects actually equipped -------------------
  const equippedAspects = new Set(
    ASPECT_SLOTS.map((s) => build.aspects[s]).filter((a): a is string => a !== null),
  );
  for (const [id, rank] of Object.entries(build.blessings)) {
    const b = blessingById.get(id);
    if (!b) {
      warnings.push(`unknown blessing: ${id}`);
      continue;
    }
    if (!equippedAspects.has(b.aspect)) {
      warnings.push(`${b.name} ignored: its aspect (${b.aspect}) is not equipped`);
      continue;
    }
    collect(b.name, scaleBlessingEffects(b, rank), b.unmodeled);
  }

  for (const id of build.charmIds) {
    const c = charmById.get(id);
    if (c) collect(c.name, c.effects, c.unmodeled);
    else warnings.push(`unknown charm: ${id}`);
  }

  for (const id of build.soulSkillIds) {
    const s = soulSkillById.get(id);
    if (s) collect(s.name, s.effects, s.unmodeled);
    else warnings.push(`unknown soul skill: ${id}`);
  }

  for (const name of build.weaponUpgrades) {
    const u = weapon.forgeUpgrades.find((x) => x.name === name);
    if (u) collect(u.name, u.effects, u.unmodeled);
    else warnings.push(`${weapon.name} has no forge upgrade "${name}"`);
  }
  if (build.weaponUpgrades.length > 3) {
    warnings.push('more than 3 weapon Forge Upgrades: the game allows at most 3');
  }

  const ability = build.abilityId ? abilityById.get(build.abilityId) : undefined;
  if (ability) {
    for (const name of build.abilityUpgrades) {
      const u =
        ability.forgeUpgrades.find((x) => x.name === name) ??
        sharedAbilityUpgrades.find((x) => x.name === name);
      if (u) collect(u.name, u.effects, u.unmodeled);
      else warnings.push(`${ability.name} has no forge upgrade "${name}"`);
    }
    if (build.abilityUpgrades.length > 3) {
      warnings.push('more than 3 ability Forge Upgrades: the game allows at most 3');
    }
  } else if (build.abilityUpgrades.length > 0) {
    warnings.push('ability upgrades selected but no ability equipped');
  }

  if (build.charmIds.length > 1 && !build.soulSkillIds.includes('charm_power')) {
    warnings.push('a second Charm requires the Charm Power soul skill');
  }

  // --- Modes: main + optional weave ----------------------------------------
  const abilityDamage = ability?.damage ?? 0;
  const main = computeModeOutput(mode, mods, opts, abilityDamage);

  let weaveMode: WeaponMode | undefined;
  let weaveOutput: ModeOutput | undefined;
  if (build.weaveModeName) {
    weaveMode = weapon.modes.find((m) => m.name === build.weaveModeName);
    if (!weaveMode) {
      warnings.push(`${weapon.name} has no mode "${build.weaveModeName}" to weave in`);
    } else if (weaveMode.type === mode.type) {
      warnings.push(
        `weave mode must be the other fire type (main mode is already ${mode.type})`,
      );
      weaveMode = undefined;
    } else {
      weaveOutput = computeModeOutput(weaveMode, mods, opts, abilityDamage);
    }
  }

  const weaveRate = weaveOutput ? Math.min(Math.max(opts.weaveRate, 0), 1) : 0;
  const weaveWeaponDps = (weaveOutput?.weaponDps ?? 0) * weaveRate;
  const weaveDotDps = (weaveOutput?.dotDps ?? 0) * weaveRate;
  const weaponDps = main.weaponDps * (1 - weaveRate) + weaveWeaponDps;
  const dotDps = main.dotDps * (1 - weaveRate) + weaveDotDps;

  // --- Ability ------------------------------------------------------------
  let abilityDps = 0;
  if (ability) {
    const abilityMult =
      1 + mods.multFor('abilityDamage', 'ability') + mods.multFor('damage', 'ability');
    const charges = ability.charges + mods.flatFor('abilityCharges');
    const pulses = ability.pulses ? ability.pulses.count * ability.pulses.damage : 0;
    const perCast = ((ability.damage ?? ability.weakspotDamage ?? 0) + pulses) * abilityMult;
    // Charges refill at the end of an encounter; amortise over a nominal 30s fight.
    const encounterSeconds = 30;
    abilityDps = (perCast * charges) / encounterSeconds;
  }

  // A primary/secondary-scoped contribution is only real if that fire type is
  // actually being simulated (the main mode, or an active weave) -- otherwise
  // it's dead weight the player never sees reflected in the DPS number above.
  const activeTypes = new Set<'Primary' | 'Secondary'>([mode.type, ...(weaveMode ? [weaveMode.type] : [])]);
  const breakdown = mods.log
    .filter((entry) => {
      if (entry.scope !== 'primary' && entry.scope !== 'secondary') return true;
      return activeTypes.has(entry.scope === 'primary' ? 'Primary' : 'Secondary');
    })
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  return {
    perHit: main.perHit,
    perShot: main.perShot,
    perMagazine: main.perMagazine,
    weaponDps,
    dotDps,
    abilityDps,
    totalDps: weaponDps + dotDps + abilityDps,
    mode: { name: mode.name, type: mode.type },
    weave: weaveOutput
      ? {
          modeName: weaveMode!.name,
          modeType: weaveMode!.type,
          rate: weaveRate,
          weaponDps: weaveWeaponDps,
          dotDps: weaveDotDps,
        }
      : undefined,
    stats: {
      fireRate: main.fireRate,
      clipSize: main.clipSize,
      reloadTime: main.reloadTime,
      damageMultiplier: main.damageMultiplier,
      weakspotMultiplier: main.weakspotMultiplier,
    },
    breakdown,
    unmodeled,
    usesEstimates: mode.estimated || (weaveMode?.estimated ?? false),
    warnings,
  };
}
