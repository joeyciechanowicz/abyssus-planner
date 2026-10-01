import {
  abilityById,
  blessingById,
  blessingRankValue,
  charmById,
  enemyHealth,
  payloadByAspect,
  sharedAbilityUpgrades,
  soulSkillById,
  weaponById,
  type DamageComponent,
  type WeaponMode,
} from '../model/data';
import { defaultOptions, enemiesFor, tierFor, type Build, type SimOptions } from '../model/build';
import { Modifiers, applyEffects } from './stacking';
import { scaleBlessingEffects } from './blessingScaling';
import { payloadDamage, type HitStream } from './payloads';

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
  /** Aspect payload damage (Hemorrhage, Chain Lightning, Tentacles, ...), all payloads summed. */
  aspectDps: number;
  /** Each payload's share of aspectDps, biggest first. */
  aspects: { name: string; dps: number }[];
  /** Product of enemy damage-taken multipliers (Shadows, Hemorrhage); already applied to every *Dps. */
  vulnerability: number;
  /** weaponDps + dotDps + abilityDps + aspectDps. */
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
  /**
   * Effective `opts.weaponUptime` (1 when no ability is equipped, since it's
   * meaningless without one). `weaponDps`/`dotDps` above are already scaled by
   * it; `perHit`/`perShot`/`perMagazine`/`stats.*` are not (main-mode-only,
   * see `weave` above) -- the UI should call this out whenever it's < 1.
   */
  weaponUptime: number;
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
  /** Picks whose text the DSL could not express; their effect is NOT in the number.
   * `utility` ones have no damage effect at all, so nothing is missing. */
  unmodeled: { name: string; reason: string; utility?: boolean }[];
  /** What the number assumes to count each pick (ideal-scenario conditions, stacks, chances). */
  assumptions: { source: string; text: string }[];
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
  /** Direct (single-target) and area hit events this mode lands, for aspect procs. */
  stream: Omit<HitStream, 'slot'>;
  /** Base damage of one projectile after damage bonuses -- the game's current Damage stat. */
  damageStat: number;
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
  modeIn: WeaponMode,
  mods: Modifiers,
  opts: SimOptions,
  abilityDamage: number,
): ModeOutput {
  let mode = modeIn;
  const scope = mode.type.toLowerCase() as 'primary' | 'secondary';

  // Fan-style extra projectiles copy every direct hit; Mr. Boom-style extra
  // explosions repeat every explosion component.
  const projectiles = 1 + mods.flatFor('extraProjectiles');
  const explosions = 1 + mods.flatFor('extraExplosions');
  // Larger Battery-style extra charge steps extend a charge range by whole steps.
  const extraSteps = mods.flatFor('extraChargeSteps');
  const components = (list: DamageComponent[] | null) =>
    list && extraSteps > 0
      ? list.map((c) =>
          (c.chargeSteps ?? modeIn.chargeSteps ?? 0) > 1 && c.max > c.min
            ? { ...c, max: c.max + ((c.max - c.min) / ((c.chargeSteps ?? modeIn.chargeSteps)! - 1)) * extraSteps }
            : c,
        )
      : list;
  mode = { ...mode, damageComponents: components(mode.damageComponents), weakspotComponents: components(mode.weakspotComponents) };
  const weakspotRate = Math.min(1, opts.weakspotAccuracy + mods.flatFor('weakspotChance'));
  const baseImpact = componentTotal(mode.damageComponents, ['impact'], opts.chargeLevel) * projectiles;
  const baseWeakspot =
    (componentTotal(mode.weakspotComponents, ['impact'], opts.chargeLevel) || baseImpact / projectiles * 2) *
    projectiles;
  const baseExtra =
    componentTotal(mode.damageComponents, ['explosion'], opts.chargeLevel) * explosions +
    componentTotal(mode.damageComponents, ['pull', 'aoe'], opts.chargeLevel);

  // Ramps while the trigger is held, reset on release: average over one burst of fire.
  const burstSeconds = mode.clipSize ? mode.clipSize / mode.fireRate : 10;
  const rampDamage = mods.flatFor('damageRampPerSecond') * (burstSeconds / 2);
  const rampFireRate = mods.flatFor('fireRateRampPerSecond') * (burstSeconds / 2);
  const damageMult = 1 + mods.multFor('damage', scope) + rampDamage;
  const weakspotMult = 1 + mods.multFor('weakspotDamage', scope);
  const aoeMult = 1 + mods.multFor('aoeDamage', scope);

  // Weakspot damage is already the doubled figure in the wiki's own table, so the
  // weakspot bonus scales that rather than re-applying the x2.
  const normalHit = baseImpact * damageMult;
  const weakspotHit = baseWeakspot * damageMult * weakspotMult;
  const blendedImpact = normalHit * (1 - weakspotRate) + weakspotHit * weakspotRate;

  const procDamage = mods.procs.reduce((sum, p) => {
    const base =
      p.of === 'flat'
        ? p.amount
        : p.of === 'onHitDamage' || p.of === 'weaponDamage'
          ? blendedImpact * p.amount
          : p.of === 'abilityDamage'
            ? abilityDamage * p.amount
            : 0;
    const targets = p.area ? enemiesFor(opts.target) : 1;
    const boom = p.explosion ? explosions * aoeMult : 1;
    return sum + base * p.chance * targets * boom;
  }, 0);

  // Area components (explosions, pulls) catch every enemy in the target scenario;
  // a direct hit only ever lands on one.
  const areaDamage = baseExtra * aoeMult * enemiesFor(opts.target);
  const perShot = (blendedImpact + areaDamage + procDamage) * opts.accuracy;

  const fireRate = mode.fireRate * (1 + mods.multFor('fireRate', scope) + rampFireRate);
  const reloadTime = mode.reloadTime / (1 + mods.multFor('reloadSpeed', scope));
  const clipSize =
    mode.clipSize === null
      ? null
      : Math.max(1, Math.round(mode.clipSize * (1 + mods.multFor('clipSize', scope)) +
          mods.flatFor('clipSize')));

  // Ammo refunds (Critical Cylinder) stretch the clip: each shot costs (1 - refund).
  const refund = Math.min(0.95, mods.flatFor('ammoRefund'));
  const shotsPerCycle = clipSize === null ? fireRate : clipSize / (1 - refund); // no clip => one second of fire
  const cycleTime = shotsPerCycle / fireRate + (clipSize === null ? 0 : reloadTime);
  const perMagazine = perShot * shotsPerCycle;
  const weaponDps = cycleTime > 0 ? perMagazine / cycleTime : 0;

  const shotsPerSecond = cycleTime > 0 ? shotsPerCycle / cycleTime : 0;
  const count = (kinds: DamageComponent['kind'][]) =>
    (mode.damageComponents ?? []).filter((c) => kinds.includes(c.kind)).reduce((n, c) => n + c.count, 0);
  const directPerShot = count(['impact']) * projectiles;
  const areaPerShot = count(['explosion', 'pull', 'aoe']);
  const stream = {
    directHitsPerSecond: shotsPerSecond * directPerShot * opts.accuracy,
    directHit: directPerShot > 0 ? blendedImpact / directPerShot : 0,
    areaEventsPerSecond: shotsPerSecond * areaPerShot * opts.accuracy,
    areaHit: areaPerShot > 0 ? (baseExtra * aoeMult) / areaPerShot : 0,
    procMultiplier: mode.procChance,
  };

  const dotMult = 1 + mods.multFor('dotDamage', 'dot');
  const dotPerApplication = componentTotal(mode.damageComponents, ['dot'], opts.chargeLevel);
  // A DoT is refreshed by fire, so treat it as landing once per shot but not
  // stacking beyond a single application at a time.
  const dotDps = dotPerApplication > 0 ? dotPerApplication * dotMult * Math.min(fireRate, 1) : 0;

  return {
    stream,
    damageStat: directPerShot > 0 ? (baseImpact / directPerShot) * damageMult : 0,
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
  const unmodeled: SimResult['unmodeled'] = [];
  const mods = new Modifiers();

  const weapon = weaponById.get(build.weaponId);
  if (!weapon) throw new Error(`unknown weapon: ${build.weaponId}`);
  const mode = weapon.modes.find((m) => m.name === build.modeName);
  if (!mode) throw new Error(`unknown mode: ${build.modeName} on ${build.weaponId}`);
  const ability = build.abilityId ? abilityById.get(build.abilityId) : undefined;

  const charmRarities = build.charmIds.map((id) => charmById.get(id)?.rarity ?? '');
  const collect = (
    name: string,
    effects: Parameters<typeof applyEffects>[1],
    reason?: string,
    utility?: boolean,
    sameAspectBlessings?: number,
  ) => {
    if (effects.length === 0 && reason) unmodeled.push({ name, reason, utility });
    applyEffects(mods, effects, name, opts, { hasAbility: !!ability, sameAspectBlessings, charmRarities });
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
    const sameAspect = Object.keys(build.blessings).filter((x) => blessingById.get(x)?.aspect === b.aspect).length;
    collect(b.name, scaleBlessingEffects(b, rank), b.unmodeled, b.utility, sameAspect);
  }

  for (const id of build.charmIds) {
    const c = charmById.get(id);
    if (c) collect(c.name, c.effects, c.unmodeled, c.utility);
    else warnings.push(`unknown charm: ${id}`);
  }

  for (const id of build.soulSkillIds) {
    const s = soulSkillById.get(id);
    if (s) collect(s.name, s.effects, s.unmodeled, s.utility);
    else warnings.push(`unknown soul skill: ${id}`);
  }

  for (const name of build.weaponUpgrades) {
    const u = weapon.forgeUpgrades.find((x) => x.name === name);
    if (u) collect(u.name, u.effects, u.unmodeled, u.utility);
    else warnings.push(`${weapon.name} has no forge upgrade "${name}"`);
  }
  if (build.weaponUpgrades.length > 3) {
    warnings.push('more than 3 weapon Forge Upgrades: the game allows at most 3');
  }

  if (ability) {
    for (const name of build.abilityUpgrades) {
      const u =
        ability.forgeUpgrades.find((x) => x.name === name) ??
        sharedAbilityUpgrades.find((x) => x.name === name);
      if (u) collect(u.name, u.effects, u.unmodeled, u.utility);
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
  const areaTargets = enemiesFor(opts.target);
  if (areaTargets > 1 && mode.damageComponents?.some((c) => ['explosion', 'pull', 'aoe'].includes(c.kind))) {
    mods.assume(mode.name, `its area damage catches all ${areaTargets} enemies`);
  }

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
  const weaponUptime = ability ? Math.min(Math.max(opts.weaponUptime, 0), 1) : 1;
  const weaveWeaponDps = (weaveOutput?.weaponDps ?? 0) * weaveRate * weaponUptime;
  const weaveDotDps = (weaveOutput?.dotDps ?? 0) * weaveRate * weaponUptime;
  const weaponDps = main.weaponDps * (1 - weaveRate) * weaponUptime + weaveWeaponDps;
  const dotDps = main.dotDps * (1 - weaveRate) * weaponUptime + weaveDotDps;

  // --- Ability ------------------------------------------------------------
  let abilityDps = 0;
  let abilityStream: HitStream | null = null;
  if (ability) {
    const abilityMult =
      1 + mods.multFor('abilityDamage', 'ability') + mods.multFor('damage', 'ability');
    const charges = Math.max(
      1,
      Math.round(
        (ability.charges + mods.flatFor('abilityCharges')) *
          (1 + mods.multFor('abilityCharges', 'ability')),
      ),
    );
    const pulses = ability.pulses ? ability.pulses.count * ability.pulses.damage : 0;
    const isArea = ability.tags.includes('aoe') || mods.flatFor('abilityArea') > 0;
    const targetsHit = isArea ? enemiesFor(opts.target) : 1;
    if (isArea && targetsHit > 1) {
      mods.assume(ability.name, `its area catches all ${targetsHit} enemies`);
    }
    const abilityExplosions = ability.tags.includes('explosion') ? 1 + mods.flatFor('extraExplosions') : 1;
    if (abilityExplosions > 1) mods.assume(ability.name, `its explosions go off ${abilityExplosions} times`);
    const perCast =
      ((ability.damage ?? ability.weakspotDamage ?? 0) + pulses) * abilityMult * targetsHit * abilityExplosions;
    // Charges refill at the end of an encounter; amortise over a nominal 30s fight.
    // abilityCooldown mods shorten/lengthen the effective encounter window --
    // negative values fit more casts into the same 30s.
    const cooldownMult = Math.max(0.1, 1 + mods.multFor('abilityCooldown', 'ability'));
    const encounterSeconds = 30 * cooldownMult;
    abilityDps = (perCast * charges) / encounterSeconds;

    // Each cast's impact and each pulse is a hit event that can proc the ability's aspect card.
    const castsPerSecond = charges / encounterSeconds;
    const events = 1 + (ability.pulses?.count ?? 0);
    const perEvent = perCast / targetsHit / events;
    abilityStream = {
      slot: 'ability',
      directHitsPerSecond: isArea ? 0 : castsPerSecond * events,
      directHit: perEvent,
      areaEventsPerSecond: isArea ? castsPerSecond * events : 0,
      areaHit: perEvent,
      procMultiplier: 1,
    };
  }

  // --- Aspect payloads ------------------------------------------------------
  const streams: HitStream[] = [];
  const scaled = (m: ModeOutput, type: WeaponMode['type'], share: number): HitStream => ({
    ...m.stream,
    slot: type === 'Primary' ? 'primary' : 'secondary',
    directHitsPerSecond: m.stream.directHitsPerSecond * share,
    areaEventsPerSecond: m.stream.areaEventsPerSecond * share,
  });
  streams.push(scaled(main, mode.type, (1 - weaveRate) * weaponUptime));
  if (weaveOutput && weaveMode) streams.push(scaled(weaveOutput, weaveMode.type, weaveRate * weaponUptime));
  if (abilityStream) {
    // Double Trouble: ability-slot blessing procs sometimes trigger twice.
    abilityStream.procMultiplier *= 1 + mods.flatFor('abilityProcRepeat');
    streams.push(abilityStream);
  }

  // Hemorrhage ticks from the primary mode's Damage stat, whichever mode procs it.
  const primaryOutput =
    mode.type === 'Primary' ? main : weaveMode?.type === 'Primary' ? weaveOutput : undefined;
  const firstPrimary = weapon.modes.find((m) => m.type === 'Primary');
  const primaryModeDamage =
    primaryOutput?.damageStat ??
    (firstPrimary ? computeModeOutput(firstPrimary, mods, opts, abilityDamage).damageStat : 0);

  const cardsByAspect = new Map<string, { slot: HitStream['slot']; chance: number }[]>();
  for (const [id, rank] of Object.entries(build.blessings)) {
    const b = blessingById.get(id);
    if (!b || b.kind !== 'aspect' || !b.slot || !equippedAspects.has(b.aspect)) continue;
    // The game's own {Chance} variable wins over the card text (they disagree for
    // e.g. Tentacles: text 30%, game 40%); ability cards proc on every hit.
    const statusChance = scaleBlessingEffects(b, rank).find((e) => e.op === 'applyStatus');
    const pct = blessingRankValue(b, '{Chance}', rank);
    const chance =
      pct !== undefined ? pct / 100 : statusChance?.op === 'applyStatus' ? statusChance.chance : 1;
    cardsByAspect.set(b.aspect, [...(cardsByAspect.get(b.aspect) ?? []), { slot: b.slot, chance }]);
  }

  // Kills feed on-kill effects. Only a pack dies (a Boss fight has no kills); enemies
  // are replaced as they fall, so kills/s = damage per second / one enemy's Health.
  const killsPerSecond =
    opts.target === 'pack'
      ? (weaponDps + dotDps + abilityDps) / enemyHealth[tierFor(opts.target)]
      : 0;

  let aspectDps = 0;
  let vulnerability = 1;
  const aspects: { name: string; dps: number }[] = [];
  for (const [aspect, cards] of cardsByAspect) {
    const payload = payloadByAspect.get(aspect);
    if (!payload) {
      unmodeled.push({
        name: `${aspect} aspect`,
        reason: `the ${aspect} effect itself isn't modelled yet -- only its cards' damage bonus is counted`,
      });
      continue;
    }
    const cardStreams = cards.flatMap((card) =>
      streams
        .filter((st) => st.slot === card.slot)
        .map((st) => ({ ...st, procMultiplier: Math.min(1, card.chance * st.procMultiplier) })),
    );
    const r = payloadDamage(payload, 1, cardStreams, {
      enemies: enemiesFor(opts.target),
      primaryModeDamage,
      targetMissingHealth: 1 - opts.targetHealthFraction,
      gold: opts.gold,
      targetTier: tierFor(opts.target),
      targetMaxHealth: enemyHealth[tierFor(opts.target)],
      payloadBonus: mods.multForScopeOnly('damage', payload.id),
      statusEffectiveness: 1 + mods.multFor('statusEffectiveness', 'all'),
      mods: mods.payloadMods.get(payload.id),
      allStreams: streams,
      killsPerSecond,
    });
    for (const text of r.assumptions) mods.assume(payload.name, text);
    vulnerability *= r.vulnerability;
    if (r.dps > 0) {
      aspectDps += r.dps;
      aspects.push({ name: payload.name, dps: r.dps });
    }
  }
  // Overkill: each kill wastes about half a hit, which is carried (and multiplied) onward.
  const overkill = killsPerSecond * (main.perHit / 2) * mods.flatFor('overkillTransfer');
  if (overkill > 0) {
    aspectDps += overkill;
    aspects.push({ name: 'Overkill', dps: overkill });
    mods.assume('Overkill', 'each kill overshoots by half a hit on average');
  }
  if (vulnerability !== 1) {
    aspectDps *= vulnerability;
    for (const a of aspects) a.dps *= vulnerability;
  }
  aspects.sort((a, b) => b.dps - a.dps);

  // A primary/secondary-scoped contribution is only real if that fire type is
  // actually being simulated (the main mode, or an active weave) -- otherwise
  // it's dead weight the player never sees reflected in the DPS number above.
  // No weapon fire type is real at all when weaponUptime is zeroed out.
  const activeTypes =
    weaponUptime === 0
      ? new Set<'Primary' | 'Secondary'>()
      : new Set<'Primary' | 'Secondary'>([mode.type, ...(weaveMode ? [weaveMode.type] : [])]);
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
    weaponDps: weaponDps * vulnerability,
    dotDps: dotDps * vulnerability,
    abilityDps: abilityDps * vulnerability,
    aspectDps,
    aspects,
    vulnerability,
    totalDps: (weaponDps + dotDps + abilityDps) * vulnerability + aspectDps,
    mode: { name: mode.name, type: mode.type },
    weave: weaveOutput
      ? {
          modeName: weaveMode!.name,
          modeType: weaveMode!.type,
          rate: weaveRate,
          weaponDps: weaveWeaponDps * vulnerability,
          dotDps: weaveDotDps * vulnerability,
        }
      : undefined,
    weaponUptime,
    stats: {
      fireRate: main.fireRate,
      clipSize: main.clipSize,
      reloadTime: main.reloadTime,
      damageMultiplier: main.damageMultiplier,
      weakspotMultiplier: main.weakspotMultiplier,
    },
    breakdown,
    unmodeled,
    assumptions: mods.assumptions,
    usesEstimates: mode.estimated || (weaveMode?.estimated ?? false),
    warnings,
  };
}
