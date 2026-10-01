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
  /** Shots fired per second, reloads included. */
  shotsPerSecond: number;
  /** Heat modes: share of time the trigger is held at the chosen heat strategy (1 otherwise),
   * and how hot the gun runs on average (0..1). */
  heatDuty: number;
  heatFraction: number;
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
  /** Combo Point scaling on this mode's damage, and ammo refunded per shot from outside it. */
  extra: {
    comboFactor?: number;
    extraRefund?: number;
    /** The weapon's heat system, and how hot it runs (for heat-scaled bonuses on any mode). */
    heat?: { max: number; coolPerSecond: number; overheatDuration: number };
    heatFraction?: number;
  } = {},
): ModeOutput {
  let mode = modeIn;
  // Combo Points (Harpoon) and size-scaled damage (Explosive Valve) scale the shot's damage.
  const combo =
    (extra.comboFactor ?? 1) *
    (1 + mods.flatFor('damagePerAoeSize') * mods.multFor('aoeSize', modeIn.type.toLowerCase() as 'primary' | 'secondary'));
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
  // Critical Chance (base 0; blessings add to it) turns a non-weakspot hit into a critical one,
  // the same flag a weakspot hit sets.
  const critChance = Math.min(1, mods.multFor('critChance', 'all'));
  const weakspotBase = Math.min(1, opts.weakspotAccuracy + mods.flatFor('weakspotChance'));
  const weakspotRate = weakspotBase + (1 - weakspotBase) * critChance;
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
  // Combo Points scale the shot's damage, not the displayed damage multiplier.
  const normalHit = baseImpact * damageMult * combo;
  const weakspotHit = baseWeakspot * damageMult * weakspotMult * combo;
  const plainImpact = normalHit * (1 - weakspotRate) + weakspotHit * weakspotRate;
  // Exploding hits: the struck enemy's hit counts as an explosion (area bonuses, Mr. Boom),
  // and every other enemy in the pack takes its normal damage.
  const explodingShare =
    baseImpact > 0
      ? componentTotal(
          (mode.damageComponents ?? []).filter((c) => c.explodes),
          ['impact'],
          opts.chargeLevel,
        ) * projectiles / baseImpact
      : 0;
  const explodingNormal = normalHit * explodingShare * aoeMult;
  const blendedImpact =
    plainImpact * (1 - explodingShare) + plainImpact * explodingShare * aoeMult * explosions;
  const splash = explodingNormal * explosions * (enemiesFor(opts.target) - 1);

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
  const areaDamage = baseExtra * combo * aoeMult * enemiesFor(opts.target);
  const perShot = (blendedImpact + splash + areaDamage + procDamage) * opts.accuracy;

  const baseFireRate = mode.fireRate * (1 + mods.multFor('fireRate', scope) + rampFireRate);
  // Heat-scaled bonuses (Insulated Barrel, Heat Converter) for a non-heat mode use the
  // heat the build's heat mode runs at.
  let heatFraction = extra.heatFraction ?? 0;
  let fireRate = baseFireRate * (1 + mods.flatFor('heatFireRate') * heatFraction);
  const reloadTime = mode.reloadTime / (1 + mods.multFor('reloadSpeed', scope));
  const clipSize =
    mode.clipSize === null
      ? null
      : Math.max(1, Math.round(mode.clipSize * (1 + mods.multFor('clipSize', scope)) +
          mods.flatFor('clipSize')));

  // Ammo refunds (Critical Cylinder) stretch the clip: each shot costs (1 - refund).
  const refund = Math.min(0.95, mods.flatFor('ammoRefund') + (extra.extraRefund ?? 0));
  let shotsPerCycle = clipSize === null ? fireRate : clipSize / (1 - refund); // no clip => one second of fire
  let cycleTime = shotsPerCycle / fireRate + (clipSize === null ? 0 : reloadTime);
  let shotDamage = perShot * (1 + mods.flatFor('heatDamage') * heatFraction);
  let heatDuty = 1;
  let cycleExtra = 0; // damage per cycle outside the shots (Heat Expulsion)

  if (mode.heatPerShot !== undefined && extra.heat) {
    // Heat modes spend heat, not ammo. Two ways to run them; the ideal picks the better:
    //  - feather: hold until just under max, release to cool -- the gun stays hot;
    //  - overheat: dump to max, sit out the lockout (Burst Cooling then gives free fire,
    //    Heat Expulsion explodes once per overheat).
    const hits = (mode.damageComponents ?? []).filter((c) => c.kind === 'impact').reduce((n, c) => n + c.count, 0);
    const heat = Math.max(0, mode.heatPerShot - mods.flatFor('heatReductionPerHit') * hits * projectiles * opts.accuracy);
    const max = extra.heat.max * (1 + mods.multFor('maxHeat', 'all'));
    const cool = extra.heat.coolPerSecond;
    const strategy = (fraction: number) => {
      const fr = baseFireRate * (1 + mods.flatFor('heatFireRate') * fraction);
      const dmg = perShot * (1 + mods.flatFor('heatDamage') * fraction);
      return { fr, dmg };
    };
    const f = strategy(1);
    const featherDuty = heat > 0 ? cool / (f.fr * heat + cool) : 1;
    const feather = { dps: f.fr * featherDuty * f.dmg, shots: f.fr * featherDuty, duty: featherDuty, fraction: 1, extra: 0, time: 1 };
    let best = feather;
    if (heat > 0) {
      const o = strategy(0.5);
      const burst = mods.flatFor('burstCooling');
      const shots = max / heat + o.fr * burst;
      const time = max / (heat * o.fr) + extra.heat.overheatDuration + burst;
      const expulsion = mods.flatFor('heatExpulsion') * normalHit * aoeMult * enemiesFor(opts.target);
      const overheat = {
        dps: (shots * o.dmg + expulsion) / time,
        shots: shots / time,
        duty: (time - extra.heat.overheatDuration) / time,
        fraction: 0.5,
        extra: expulsion,
        time,
      };
      if (overheat.dps > feather.dps) best = overheat;
    }
    heatDuty = best.duty;
    heatFraction = best.fraction;
    fireRate = best.shots / best.duty;
    shotDamage = best === feather ? f.dmg : strategy(0.5).dmg;
    shotsPerCycle = best.shots * best.time;
    cycleTime = best.time;
    cycleExtra = best.extra;
  }

  const perMagazine = shotDamage * shotsPerCycle + cycleExtra;
  const weaponDps = cycleTime > 0 ? perMagazine / cycleTime : 0;

  const shotsPerSecond = cycleTime > 0 ? shotsPerCycle / cycleTime : 0;
  const count = (kinds: DamageComponent['kind'][]) =>
    (mode.damageComponents ?? []).filter((c) => kinds.includes(c.kind) && !c.explodes).reduce((n, c) => n + c.count, 0);
  const explodingPerShot = (mode.damageComponents ?? []).filter((c) => c.explodes).reduce((n, c) => n + c.count, 0) * projectiles;
  // Exploding hits proc aspects as area events (every enemy is caught).
  const directPerShot = count(['impact']) * projectiles;
  const areaPerShot = count(['explosion', 'pull', 'aoe']) + explodingPerShot;
  const stream = {
    directHitsPerSecond: shotsPerSecond * directPerShot * opts.accuracy,
    directHit: directPerShot > 0 ? blendedImpact / directPerShot : 0,
    areaEventsPerSecond: shotsPerSecond * areaPerShot * opts.accuracy,
    areaHit: areaPerShot > 0 ? (baseExtra * aoeMult + explodingNormal) / areaPerShot : 0,
    procMultiplier: mode.procChance,
  };

  const dotMult = 1 + mods.multFor('dotDamage', 'dot');
  const dotPerApplication = componentTotal(mode.damageComponents, ['dot'], opts.chargeLevel);
  // A DoT is refreshed by fire, so treat it as landing once per shot but not
  // stacking beyond a single application at a time.
  const dotDps = dotPerApplication > 0 ? dotPerApplication * combo * dotMult * Math.min(fireRate, 1) : 0;

  return {
    shotsPerSecond,
    heatDuty,
    heatFraction,
    stream,
    damageStat: directPerShot > 0 ? (baseImpact / directPerShot) * damageMult : 0,
    perHit: blendedImpact,
    perShot: shotDamage,
    perMagazine,
    weaponDps,
    dotDps,
    fireRate,
    clipSize: mode.heatPerShot !== undefined && extra.heat ? null : clipSize,
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
  const heatSys = weapon.heat ? { heat: weapon.heat } : {};
  let main = computeModeOutput(mode, mods, opts, abilityDamage, heatSys);
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
      weaveOutput = computeModeOutput(weaveMode, mods, opts, abilityDamage, heatSys);
    }
  }

  const weaveRate = weaveOutput ? Math.min(Math.max(opts.weaveRate, 0), 1) : 0;
  const weaponUptime = ability ? Math.min(Math.max(opts.weaponUptime, 0), 1) : 1;

  // Harpoon Gun Combo Points: Primary hits bank one each (up to the max), a Secondary
  // spends them all and scales by its curve. The listed Secondary damage assumes 4.
  const comboMode = [mode, weaveMode].find((m) => m?.type === 'Secondary' && m.comboCurve);
  if (comboMode?.comboCurve && weapon.maxComboPoints !== undefined) {
    const mainShare = (1 - weaveRate) * weaponUptime;
    const weaveShare = weaveRate * weaponUptime;
    const [primaryOut, primaryShare] = mode.type === 'Primary' ? [main, mainShare] : [weaveOutput, weaveShare];
    const [secondaryOut, secondaryShare] = mode.type === 'Secondary' ? [main, mainShare] : [weaveOutput, weaveShare];
    const maxPoints = weapon.maxComboPoints + mods.flatFor('comboPoints');
    const primaryHits = (primaryOut?.stream.directHitsPerSecond ?? 0) * primaryShare;
    const secondaryShots = (secondaryOut?.shotsPerSecond ?? 0) * secondaryShare;
    const points = secondaryShots > 0 ? Math.min(maxPoints, primaryHits / secondaryShots) : 0;
    const curve =
      (enemiesFor(opts.target) > 1 ? comboMode.comboCurve.multi : undefined) ?? comboMode.comboCurve.single;
    const at = (cp: number) => {
      const i = Math.min(Math.max(cp, 0), curve.length - 1);
      const lo = Math.floor(i);
      const hi = Math.min(lo + 1, curve.length - 1);
      return curve[lo] + (curve[hi] - curve[lo]) * (i - lo);
    };
    // Precise Combo: spending the marked amount (on average half the max) acts as max + 1.
    const precise = mods.flatFor('preciseCombo') > 0 && points >= (maxPoints + 1) / 2;
    const value = precise ? at(maxPoints + 1) : at(points);
    const factor = value / comboMode.comboCurve.single[4];
    mods.assume(
      comboMode.name,
      `${points.toFixed(1)} of ${maxPoints} Combo Points per shot` + (precise ? ', spent on the marked amount' : ''),
    );
    // Plentiful Combo: each point spent refills one Primary round.
    const refund =
      primaryOut && primaryHits > 0
        ? Math.min(0.95, (mods.flatFor('comboAmmoRefund') * points * secondaryShots) / (primaryOut.shotsPerSecond * primaryShare))
        : 0;
    const redo = (m: WeaponMode) =>
      m === comboMode
        ? computeModeOutput(m, mods, opts, abilityDamage, { ...heatSys, comboFactor: factor })
        : computeModeOutput(m, mods, opts, abilityDamage, { ...heatSys, extraRefund: refund });
    main = redo(mode);
    if (weaveMode && weaveOutput) weaveOutput = redo(weaveMode);
  }
  // Engine Rifle heat: the heat mode sets how hot the gun runs, which other modes'
  // heat-scaled bonuses (Insulated Barrel, Heat Converter) see too.
  if (weapon.heat) {
    const heatShare = mode.heatPerShot !== undefined ? 1 - weaveRate : weaveMode?.heatPerShot !== undefined ? weaveRate : 0;
    const heatOut = mode.heatPerShot !== undefined ? main : weaveMode?.heatPerShot !== undefined ? weaveOutput : undefined;
    const fraction = heatOut && heatShare * weaponUptime > 0 ? heatOut.heatFraction : 0;
    if (heatOut) {
      mods.assume(
        heatOut === main ? mode.name : weaveMode!.name,
        heatOut.heatFraction === 1
          ? 'you feather the trigger to stay just under max Heat'
          : 'you overheat on purpose each cycle',
      );
    }
    if (mode.heatPerShot === undefined) main = computeModeOutput(mode, mods, opts, abilityDamage, { ...heatSys, heatFraction: fraction });
    if (weaveMode && weaveOutput && weaveMode.heatPerShot === undefined) {
      weaveOutput = computeModeOutput(weaveMode, mods, opts, abilityDamage, { ...heatSys, heatFraction: fraction });
    }
  }

  // A heat mode only holds the trigger heatDuty of the time when used alone; given a
  // smaller share (weaving), it fires flat out for that share while the other mode lets it cool.
  const effShare = (o: ModeOutput, share: number) =>
    o.heatDuty < 1 ? Math.min(share, o.heatDuty) / o.heatDuty : share;
  const mainShare = effShare(main, (1 - weaveRate) * weaponUptime);
  const weaveShare = weaveOutput ? effShare(weaveOutput, weaveRate * weaponUptime) : 0;
  let weaveWeaponDps = (weaveOutput?.weaponDps ?? 0) * weaveShare;
  const weaveDotDps = (weaveOutput?.dotDps ?? 0) * weaveShare;
  let weaponDps = main.weaponDps * mainShare + weaveWeaponDps;
  const dotDps = main.dotDps * mainShare + weaveDotDps;

  // --- Ability ------------------------------------------------------------
  let abilityDps = 0;
  /** Rounds per second the ability puts back into your magazine (Turret Ammo Transfer). */
  let abilityRoundsPerSecond = 0;
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
    const isArea = ability.tags.includes('aoe') || mods.flatFor('abilityArea') > 0 || !!ability.sustain?.area;
    const targetsHit = isArea ? enemiesFor(opts.target) : 1;
    if (isArea && targetsHit > 1) {
      mods.assume(ability.name, `its area catches all ${targetsHit} enemies`);
    }
    const abilityExplosions = ability.tags.includes('explosion') ? 1 + mods.flatFor('extraExplosions') : 1;
    if (abilityExplosions > 1) mods.assume(ability.name, `its explosions go off ${abilityExplosions} times`);
    // Damage of one cast: an impact (plus pulses), or a lifetime of shots/ticks.
    const sustain = ability.sustain;
    const castBase = sustain
      ? sustain.perHit * sustain.hitsPerSecond * sustain.duration
      : (ability.damage ?? ability.weakspotDamage ?? 0) + pulses;
    const perCast = castBase * abilityMult * targetsHit * abilityExplosions;

    // Casts per second: charges recharge one at a time, so the sustained rate is one
    // per recharge; clearing an encounter refills every charge (assumed every 30s);
    // the input cooldown caps how fast you can recast.
    const ENCOUNTER_SECONDS = 30;
    const cooldown =
      Math.max(1, ability.rechargeCooldown + mods.flatFor('abilityCooldownSeconds')) *
      Math.max(0.1, 1 + mods.multFor('abilityCooldown', 'ability'));
    // Kills (from your weapon; Pack only) can speed recharge up or reset it outright.
    const weaponKills =
      opts.target === 'pack' ? (weaponDps + dotDps) / enemyHealth[tierFor(opts.target)] : 0;
    const rechargeSpeed = 1 + mods.flatFor('abilityCooldownPerKill') * weaponKills;
    let castsPerSecond = rechargeSpeed / cooldown + charges / ENCOUNTER_SECONDS;
    const castKills = opts.target === 'pack' && perCast / targetsHit >= enemyHealth[tierFor(opts.target)];
    if (mods.flatFor('abilityResetOnKill') > 0 && castKills) {
      castsPerSecond = Infinity;
      mods.assume(ability.name, 'every cast kills, so its cooldown resets each time');
    }
    castsPerSecond = Math.min(castsPerSecond, 1 / ability.inputCooldown);
    mods.assume(
      ability.name,
      `a cast every ${(1 / castsPerSecond).toFixed(1)}s (one charge per ${cooldown.toFixed(1)}s recharge, ` +
        `all ${charges} refilled each ${ENCOUNTER_SECONDS}s encounter)`,
    );
    abilityDps = perCast * castsPerSecond;

    // Lasting abilities (Turret): copies alive at once, for Buddy System and Ammo Transfer.
    if (sustain) {
      const alive = castsPerSecond * sustain.duration;
      abilityDps *= 1 + mods.flatFor('damagePerOtherActive') * Math.max(0, alive - 1);
      if (alive > 1.05) mods.assume(ability.name, `${alive.toFixed(1)} out at once`);
      abilityRoundsPerSecond = mods.flatFor('ammoPerAbilityHit') * sustain.hitsPerSecond * alive;
    }

    // Smiting Spear: several spears can be out at once (each lives `lifetime`, up to
    // maxActive), which Chain Pulse and Spear Grid feed on.
    if (ability.lifetime && ability.pulses) {
      const throws = 1 + mods.flatFor('abilityProjectiles');
      // Enduring Spear: a kill (pack) near a spear restarts its life.
      const resets = mods.flatFor('enduringSpear') > 0 ? Math.min(5, weaponKills * ability.lifetime) : 0;
      const lifetime = ability.lifetime * (1 + resets);
      const maxOut = ability.maxActive ?? 1;
      const spearsOut = Math.min(maxOut, castsPerSecond * throws * lifetime);
      const chain = 1 + mods.flatFor('chainPulse') * Math.max(0, spearsOut - 1);
      const pulseShare = pulses / castBase;
      // Pulses scale with lifetime and Chain Pulse; the impact doesn't.
      const spearCast = perCast * throws * ((1 - pulseShare) + pulseShare * (1 + resets) * chain);
      const grid = (mods.flatFor('spearGrid') / 0.33) * enemiesFor(opts.target) * Math.min(1, Math.max(0, spearsOut - 1));
      abilityDps = spearCast * castsPerSecond + grid;
      mods.assume(ability.name, `${spearsOut.toFixed(1)} spears out at once` + (resets ? ', kept alive by kills' : ''));
    }

    // Each cast's impact and each pulse or shot is a hit event that can proc the ability's aspect card.
    const events = sustain ? sustain.hitsPerSecond * sustain.duration : 1 + (ability.pulses?.count ?? 0);
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

  // Automatic Detonation: Primary weakspot hits fire the Secondary for free.
  const autoSecondary = mods.flatFor('secondaryOnPrimaryWeakspot');
  if (autoSecondary > 0) {
    const [primaryOut, primaryShare] =
      mode.type === 'Primary' ? [main, mainShare] : weaveMode?.type === 'Primary' ? [weaveOutput, weaveShare] : [undefined, 0];
    const secondaryMode = mode.type === 'Secondary' ? mode : weaveMode?.type === 'Secondary' ? weaveMode : weapon.modes.find((m) => m.type === 'Secondary');
    if (primaryOut && secondaryMode) {
      const secondaryShot = computeModeOutput(secondaryMode, mods, opts, abilityDamage, heatSys).perShot;
      const weakspotHits = primaryOut.stream.directHitsPerSecond * primaryShare * Math.min(1, opts.weakspotAccuracy);
      const extra = weakspotHits * autoSecondary * secondaryShot;
      weaponDps += extra;
      mods.assume(secondaryMode.name, `fired for free on ${weakspotHits.toFixed(1)} Primary weakspot hits per second`);
    }
  }

  // Ammo Transfer: rounds handed back by the ability stretch the weapon's clip.
  if (abilityRoundsPerSecond > 0) {
    const stretch = (o: ModeOutput, share: number): ModeOutput => {
      if (o.clipSize === null || share <= 0) return o;
      const used = o.shotsPerSecond * share;
      const r = Math.min(0.95, abilityRoundsPerSecond / used);
      const before = o.clipSize / o.fireRate + o.reloadTime;
      const after = o.clipSize / (1 - r) / o.fireRate + o.reloadTime;
      const k = (o.clipSize / (1 - r) / after) / (o.clipSize / before);
      return {
        ...o,
        weaponDps: o.weaponDps * k,
        shotsPerSecond: o.shotsPerSecond * k,
        stream: {
          ...o.stream,
          directHitsPerSecond: o.stream.directHitsPerSecond * k,
          areaEventsPerSecond: o.stream.areaEventsPerSecond * k,
        },
      };
    };
    main = stretch(main, mainShare);
    if (weaveOutput) weaveOutput = stretch(weaveOutput, weaveShare);
    weaveWeaponDps = (weaveOutput?.weaponDps ?? 0) * weaveShare;
    weaponDps = main.weaponDps * mainShare + weaveWeaponDps;
    mods.assume('Ammo Transfer', `${abilityRoundsPerSecond.toFixed(1)} rounds per second back into your magazine`);
  }

  // --- Aspect payloads ------------------------------------------------------
  const streams: HitStream[] = [];
  const scaled = (m: ModeOutput, type: WeaponMode['type'], share: number): HitStream => ({
    ...m.stream,
    slot: type === 'Primary' ? 'primary' : 'secondary',
    directHitsPerSecond: m.stream.directHitsPerSecond * share,
    areaEventsPerSecond: m.stream.areaEventsPerSecond * share,
  });
  streams.push(scaled(main, mode.type, mainShare));
  if (weaveOutput && weaveMode) streams.push(scaled(weaveOutput, weaveMode.type, weaveShare));
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
    (firstPrimary ? computeModeOutput(firstPrimary, mods, opts, abilityDamage, heatSys).damageStat : 0);

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
  // Blightful Freeze: status damage to Frozen enemies goes up, so Freeze is worked out first.
  let statusDamageMult = 1;
  let weaponMult = 1;
  const ordered = [...cardsByAspect].sort(([a], [b]) => Number(b === 'Frozen') - Number(a === 'Frozen'));
  for (const [aspect, cards] of ordered) {
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
      critChance: Math.min(1, mods.multFor('critChance', 'all')),
      aoeSize: mods.multFor('aoeSize', 'all'),
    });
    for (const text of r.assumptions) mods.assume(payload.name, text);
    vulnerability *= r.vulnerability;
    weaponMult *= r.weaponMult ?? 1;
    if (r.frozenShare !== undefined) {
      statusDamageMult = 1 + (mods.payloadMods.get('frost')?.statusDamageWhileActive ?? 0) * r.frozenShare;
    } else if (payload.kind === 'dot') {
      r.dps *= statusDamageMult;
    }
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
  // Weapon DoTs are status damage as well.
  const statusDotDps = dotDps * (statusDamageMult - 1);
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
    weaponDps: weaponDps * weaponMult * vulnerability,
    dotDps: (dotDps + statusDotDps) * vulnerability,
    abilityDps: abilityDps * vulnerability,
    aspectDps,
    aspects,
    vulnerability,
    totalDps: (weaponDps * weaponMult + dotDps + statusDotDps + abilityDps) * vulnerability + aspectDps,
    mode: { name: mode.name, type: mode.type },
    weave: weaveOutput
      ? {
          modeName: weaveMode!.name,
          modeType: weaveMode!.type,
          rate: weaveRate,
          weaponDps: weaveWeaponDps * weaponMult * vulnerability,
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
