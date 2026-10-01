import type { AspectPayload, ScaledHit } from '../model/data';
import type { PayloadField } from '../model/effects';

/**
 * Aspect payload damage: what an aspect card's proc deals on top of the hit that
 * triggered it (a Hemorrhage DoT, a Chain Lightning, a Windburst, a Tentacle...).
 *
 * Numbers come from data/aspects.json (game files); the formulas below were read
 * from each payload's Blueprint bytecode -- see the `evidence` field on each entry
 * and docs/plans/kismet-spike-findings.md. Everything is an expected rate, not a
 * fight simulation: a proc chance becomes procs per second, and a DoT's uptime is
 * the chance it was re-applied within its duration.
 */

/** Hits from one source (a fire mode or the ability) that can proc a card in its slot. */
export interface HitStream {
  slot: 'primary' | 'secondary' | 'ability';
  /** Single-target hits per second, across all enemies. */
  directHitsPerSecond: number;
  /** Average damage of one such hit. */
  directHit: number;
  /** Area events per second; each one hits every enemy. */
  areaEventsPerSecond: number;
  /** Average damage an area event deals to one enemy. */
  areaHit: number;
  /** The fire mode's multiplier on proc chances (1 for the ability). */
  procMultiplier: number;
}

export interface PayloadContext {
  enemies: number;
  /** The primary fire mode's current damage stat (Hemorrhage ticks scale from it). */
  primaryModeDamage: number;
  /** 0..1, how much Health the target is missing (Hemorrhage scales with it). */
  targetMissingHealth: number;
  /** Which game table the targets use, and their max Health. */
  targetTier: 'standard' | 'elite' | 'boss';
  targetMaxHealth: number;
  /** Gold you're carrying (Goldburst hits for a share of it). */
  gold: number;
  /** Summed +% bonuses aimed at this payload alone (e.g. a "+20% Windburst damage" blessing). */
  payloadBonus: number;
  /** Your area-size bonus (+x relative), for size-scaled payload damage. */
  aoeSize?: number;
  /** Your Critical Chance (0..1; base 0 -- only blessings add to it). */
  critChance?: number;
  /** Status Effect effectiveness (1 = base): scales DoT/Flare damage, Shadows' bonus and
   * Frost buildup -- the game applies StatusEffectEffectiveness as a coefficient on them. */
  statusEffectiveness?: number;
  /** Mechanic changes from `payload` effects (more repeats, more summons, ...). */
  mods?: Partial<Record<PayloadField, number>>;
  /** Enemies killed per second (0 against a Boss), for on-kill effects. */
  killsPerSecond?: number;
  /** Every hit stream in the build, whatever its slot (Flares trigger off any direct hit).
   * `procMultiplier` here is the fire mode's own, without any card chance. */
  allStreams?: HitStream[];
}

export interface PayloadResult {
  /** Payload damage per second, summed over all enemies. */
  dps: number;
  /** Multiplier on ALL damage the enemies take (Shadows, Hemorrhage stacks); 1 if none. */
  vulnerability: number;
  /** Procs per second across all enemies. */
  procsPerSecond: number;
  /** Freeze: share of the time enemies are Frozen. */
  frozenShare?: number;
  /** Multiplier on your weapon damage alone (Blood Orbs redirect weapon hits). */
  weaponMult?: number;
  assumptions: string[];
}

/** The shared "base + X% of the hit up to a soft cap, Y% beyond it" payload formula. */
export function scaledHit(f: ScaledHit, hit: number): number {
  const below = Math.min(hit, f.softCap);
  const above = Math.max(0, hit - f.softCap);
  return f.base + (f.percent / 100) * below + (f.percentAboveCap / 100) * above;
}

/** Chance a status re-applied at `rate`/s (Poisson) is up at a random moment. */
function uptime(ratePerSecond: number, duration: number): number {
  return 1 - Math.exp(-ratePerSecond * duration);
}

export function payloadDamage(
  p: AspectPayload,
  chance: number,
  streams: HitStream[],
  ctx: PayloadContext,
): PayloadResult {
  const n = Math.max(1, ctx.enemies);
  const m = (f: PayloadField) => ctx.mods?.[f] ?? 0;
  let procsTotal = 0;
  let procsPerTarget = 0;
  let triggerWeighted = 0;
  /** Damage per second landing on one enemy from these streams (Frost buildup). */
  let damagePerTarget = 0;
  /** Hit events per second across all enemies (for per-hit gauge chances). */
  let hitsTotal = 0;
  for (const s of streams) {
    const c = Math.min(1, chance * s.procMultiplier * (1 + m('chance')));
    const direct = c * s.directHitsPerSecond;
    const area = c * s.areaEventsPerSecond;
    procsTotal += direct + area * n;
    // Direct hits are assumed spread evenly over the pack (ideal: you keep every
    // enemy afflicted); an area event procs on every enemy it hits.
    procsPerTarget += direct / n + area;
    triggerWeighted += direct * s.directHit + area * n * s.areaHit;
    damagePerTarget += c * ((s.directHitsPerSecond * s.directHit) / n + s.areaEventsPerSecond * s.areaHit);
    hitsTotal += c * (s.directHitsPerSecond + s.areaEventsPerSecond * n);
  }
  const kills = ctx.killsPerSecond ?? 0;
  if (kills > 0 && m('killProcs') > 0) {
    // On-kill procs land on a fresh enemy with the average hit as their trigger.
    const avgHit = procsTotal > 0 ? triggerWeighted / procsTotal : 0;
    procsTotal += kills * m('killProcs');
    procsPerTarget += (kills * m('killProcs')) / n;
    triggerWeighted += kills * m('killProcs') * avgHit;
  }
  const trigger = procsTotal > 0 ? triggerWeighted / procsTotal : 0;
  const bonus = 1 + ctx.payloadBonus;
  const assumptions: string[] = [];
  const none: PayloadResult = { dps: 0, vulnerability: 1, procsPerSecond: 0, assumptions };
  if (procsTotal === 0) return none;

  const repeats = 1 + m('repeats');
  const eff = ctx.statusEffectiveness ?? 1;
  /** Seconds to fill a gauge of `size`, given refunds and a per-hit chance to fill it outright. */
  const fillTime = (size: number, rate: number, refund: number) => {
    const needed = Math.max(0, size - refund);
    const byDamage = rate > 0 ? rate / Math.max(needed, 1e-9) : 0;
    const byChance = m('fullGaugeChance') * hitsTotal;
    return byDamage + byChance > 0 ? 1 / (byDamage + byChance) : Infinity;
  };
  // Extra flat damage some blessings hang off each proc (an explosion, a Thunderstrike);
  // a gauge payload's "proc" is its activation.
  const result = core();
  const extras =
    (result.procsPerSecond * (m('burstDamage') + m('areaBurstDamage') * n) +
      kills * (m('killBurstDamage') + m('killAreaDamage') * n)) *
    bonus;
  if (kills > 0 && (m('killBurstDamage') || m('killAreaDamage') || m('killProcs') || m('killGauge'))) {
    result.assumptions.push(`${kills.toFixed(2)} kills per second from a pack of ${Math.round(ctx.targetMaxHealth)} HP enemies`);
  }
  return { ...result, dps: result.dps + extras };

  function core(): PayloadResult {
  switch (p.kind) {
    case 'dot': {
      const up = uptime(procsPerTarget, p.duration);
      // Flares: direct hits (any source) on a burning enemy roll the Flare chance,
      // and each Flare locks the next out for a moment.
      let flareDps = 0;
      let flaresPerTarget = 0;
      if (p.flare) {
        const all = ctx.allStreams ?? streams;
        const rolls = all.reduce(
          (sum, s) => sum + (s.directHitsPerSecond / n + s.areaEventsPerSecond) *
            Math.min(1, (p.flare!.chancePercent / 100) * s.procMultiplier * (1 + m('flareChance'))),
          0,
        );
        const attempts = rolls * up;
        flaresPerTarget = attempts / (1 + attempts * p.flare.lockout);
        const linked = m('linkedFlares') > 0 ? n : 1;
        const perFlare =
          p.flare.damage * (1 + m('flareDamage')) * linked + m('flareBurstDamage') + m('flareAreaDamage') * n;
        flareDps = n * flaresPerTarget * perFlare;
        if (flaresPerTarget > 0) {
          assumptions.push(`${(flaresPerTarget).toFixed(2)} Flares per second on each burning enemy`);
        }
      }
      // Stacking Flames: every application and every Flare inside the duration is a stack.
      const stacks = m('fireStacks') > 0 ? Math.max(1, (procsPerTarget + flaresPerTarget) * p.duration) : p.maxStacks;
      const tick =
        p.trigger !== undefined
          ? scaledHit(p.trigger, trigger)
          : ((p.tickBase ?? 0) + ((p.tickPercentOfPrimaryDamage ?? 0) / 100) * ctx.primaryModeDamage) *
            (p.scalesWithTargetMissingHealth ? 1 + ctx.targetMissingHealth : 1);
      const stackBonus = 1 + ((p.damagePercentPerStack ?? 0) / 100) * stacks;
      const dps = (n * (tick / p.tickInterval) * stackBonus * up + flareDps) * bonus * eff;
      const vulnerability = 1 + ((p.damageTakenPercentPerStack ?? 0) / 100) * p.maxStacks * up;
      // Blood Orbs: while one is up you shoot it instead, for orbDamage x the hit to its enemy
      // (or, with Bloodsplosions, an explosion over every enemy).
      let weaponMult = 1;
      if (m('orbChance') > 0) {
        const orbUp = uptime(procsPerTarget * m('orbChance'), m('orbDuration'));
        const gain = m('orbDamage') * (m('orbArea') > 0 ? n : 1) - 1;
        weaponMult = 1 + gain * orbUp;
        assumptions.push(`a Blood Orb up ${Math.round(orbUp * 100)}% of the time, and you shoot it`);
      }
      assumptions.push(
        `${p.name} up ${Math.round(up * 100)}% of the time on ${n === 1 ? 'the target' : `each of ${n} enemies`}`,
      );
      return { dps, vulnerability, procsPerSecond: procsTotal, weaponMult, assumptions };
    }
    case 'chain': {
      // Crits: your Critical Chance plus Lightning bonuses, at x2 (the native crit
      // multiplier; Lightning's own isn't exposed) plus crit-damage bonuses.
      const crit = Math.min(1, (ctx.critChance ?? 0) + m('critChance'));
      const critMult = 2 + m('critDamage');
      const hitMult = 1 + crit * (critMult - 1);
      const falloff = (p.falloffPercent + m('falloffPercent')) / 100;
      // Bounces: one per other enemy, up to ChainCount; Static Repetition-style extra
      // bounces on crits can re-hit enemies (so a lone Boss can be hit again), up to BounceCap.
      const baseBounces = Math.min(p.chainCount, n - 1);
      const extraPerHit = crit * m('critExtraBounces');
      const extra = extraPerHit > 0 ? Math.min(8 - baseBounces, (baseBounces + 1) * extraPerHit / (1 - Math.min(0.9, extraPerHit))) : 0;
      const bounces = baseBounces + extra;
      let reach = 0;
      for (let i = 0; i <= Math.floor(bounces); i++) reach += (1 - falloff) ** i;
      reach += (bounces - Math.floor(bounces)) * (1 - falloff) ** (Math.floor(bounces) + 1);
      // Forks on crits: each crit spawns another (fallen-off) arc, in a pack.
      reach *= 1 + (n > 1 ? crit * m('critForks') : 0);
      let dmgMult = hitMult;
      if (m('lastBounceCrit') > 0 && baseBounces === p.chainCount) {
        // The last bounce is a guaranteed crit once the chain reaches its maximum.
        const lastShare = (1 - falloff) ** baseBounces / reach;
        dmgMult += lastShare * (critMult - hitMult);
      }
      if (bounces > 0) assumptions.push(`each ${p.name} bounces ${bounces.toFixed(1)} times`);
      if (crit > 0) assumptions.push(`${Math.round(crit * 100)}% of Chain Lightning hits crit, at x${critMult.toFixed(2)}`);
      reach *= dmgMult;
      return {
        dps: procsTotal * scaledHit(p.trigger, trigger) * reach * repeats * bonus,
        vulnerability: 1,
        procsPerSecond: procsTotal,
        assumptions,
      };
    }
    case 'burst': {
      if (n > 1) assumptions.push(`each ${p.name} catches all ${n} enemies`);
      // Raging Storm: damage x (1 + scaling x total size increase). Repeat bursts are
      // larger (x1.4, x1.8 radius for the 2nd and 3rd), which counts too.
      let sizeMult = 1;
      if (m('radiusDamageScaling') > 0) {
        const extraBursts = Math.round(m('repeats'));
        let burstSize = 0;
        for (let i = 0; i <= extraBursts; i++) burstSize += Math.min(i, 2) * 0.4;
        const size = m('radius') + (ctx.aoeSize ?? 0) + burstSize / (extraBursts + 1);
        sizeMult = 1 + m('radiusDamageScaling') * size;
      }
      return {
        dps: procsTotal * scaledHit(p.trigger, trigger) * n * repeats * sizeMult * bonus,
        vulnerability: 1,
        procsPerSecond: procsTotal,
        assumptions,
      };
    }
    case 'summon': {
      const maxActive = p.maxActive + m('maxActive');
      const active = Math.min(maxActive, procsTotal * (p.lifetime + m('lifetime')));
      // The throw pool: the base projectile plus one per object blessing, chosen at random.
      const pool = 1 + m('poolObjects');
      const objectBonus = m('poolDamage') + m('poolAreaDamage') * n + m('poolBounce') * Math.min(1, n - 1);
      const poolMult =
        (1 + objectBonus / pool + m('throwAllChance') * objectBonus) * (1 + m('damagePerPoolObject') * pool);
      if (pool > 1) assumptions.push(`${pool} objects in the Tentacles' throw pool, picked at random`);
      const attack = (p.attackBase + (p.attackPercentOfTrigger / 100) * trigger) * poolMult * (1 + m('extraThrows'));
      const speed = 1 + m('attackSpeed') + m('attackSpeedPerActive') * active;
      assumptions.push(`${active.toFixed(1)} of ${maxActive} ${p.name}s alive on average`);
      return {
        dps: (active * attack * speed * bonus) / p.attackInterval,
        vulnerability: 1,
        procsPerSecond: procsTotal,
        assumptions,
      };
    }
    case 'spirit': {
      const gaugeRate = damagePerTarget * n * (1 + m('gaugeGain')) + kills * m('killGauge');
      if (gaugeRate <= 0) return none;
      // Orbs one full gauge pays for, each costing more than the last. The game spawns
      // while any gauge is left and subtracts afterwards, so the last orb may overdraw.
      const cost = p.orbCost * (1 + m('orbCost'));
      let orbs = 0;
      for (let left = p.maxGauge; left > 0 && cost > 0; orbs++) {
        left -= cost * (1 + (p.orbCostIncrementPercent / 100) * orbs);
      }
      const cycle = fillTime(p.maxGauge, gaugeRate, orbs * m('gaugePerOrb')) + orbs * p.orbInterval;
      assumptions.push(`${orbs} Spirits per full gauge, every ${cycle.toFixed(1)}s`);
      const orbRate = orbs / cycle;
      // Aggression Possession: each orb hit adds a 5s DoT stack on its target.
      const stacksPerTarget = Math.min(100, (orbRate * 5) / n);
      const orbDot = m('orbDotPerSecond') * stacksPerTarget * n;
      // Friendly Possession: 20% of orbs grant you a 10s damage stack, up to 10.
      const possession = 1 + m('possessionDamage') * Math.min(10, orbRate * 0.2 * 10);
      return {
        dps: ((orbs * scaledHit(p.orb, trigger)) / cycle + orbDot) * bonus,
        vulnerability: possession,
        procsPerSecond: orbs / cycle,
        assumptions,
      };
    }
    case 'brine': {
      const fillRate = damagePerTarget * n * (1 + m('gaugeGain'));
      if (fillRate <= 0) return none;
      const balls = 1 / fillTime(p.vialCapacity, fillRate, m('gaugePerOrb') * n);
      const explosion = p.explosionBase + (p.explosionPercentOfTrigger / 100) * trigger;
      assumptions.push(
        `a Brine Ball thrown every ${(1 / balls).toFixed(1)}s, as soon as a vial fills (1:1 with damage dealt)`,
      );
      if (n > 1) assumptions.push(`each Brine Ball catches all ${n} enemies`);
      // Mucous Brine: enemies hit take more damage for 5s (the native default duration).
      const mucous = 1 + m('damageTakenWhileActive') * Math.min(1, balls * 5);
      return { dps: balls * explosion * n * repeats * bonus, vulnerability: mucous, procsPerSecond: balls, assumptions };
    }
    case 'barrier': {
      const fillRate = damagePerTarget * n * (1 + m('gaugeGain'));
      if (fillRate <= 0) return none;
      const duration = p.duration * (1 + m('duration'));
      const cycle = fillTime(p.maxGauge, fillRate, 0) + duration + p.cooldown * (1 + m('cooldown'));
      const up = duration / cycle;
      assumptions.push(`Barrier up ${Math.round(up * 100)}% of the time`);
      return {
        dps: m('dotPerSecond') * n * up * bonus,
        vulnerability: 1 + m('damageWhileActive') * up,
        procsPerSecond: 1 / cycle,
        assumptions,
      };
    }
    case 'gold': {
      assumptions.push(`you carry ${Math.round(ctx.gold)} Gold`);
      const perProc = ctx.gold * ((p.goldPercent + m('goldPercent')) / 100) + (m('triggerPercent') / 100) * trigger;
      return {
        dps: procsTotal * perProc * repeats * bonus,
        vulnerability: 1,
        procsPerSecond: procsTotal,
        assumptions,
      };
    }
    case 'freeze': {
      const tier = ctx.targetTier;
      const hp = ctx.targetMaxHealth;
      const threshold =
        Math.min((p.thresholdPercent[tier] / 100) * hp, p.thresholdCap[tier]) * (1 - m('buildupRetained'));
      const buildRate = damagePerTarget * (1 + m('buildup')) * eff;
      if (buildRate <= 0) return none;
      const frozenFor = p.freezeDuration * (1 + m('duration'));
      // Buildup is blocked while Frozen, so each cycle is build-up time + Freeze.
      const cycle = threshold / buildRate + frozenFor;
      // Shred scales with current Health; averaged over a fight that is half of max.
      const current = hp * 0.5;
      const shredPct = p.shredPercentOfCurrent[tier] + m('shredPercent');
      const shred =
        Math.max((p.minShredPercentOfMax / 100) * hp, (shredPct / 100) * current) +
        ((m('shredPerSecondWhileActive') * frozenFor + m('shredOnEndPercent')) / 100) * current;
      const frozenShare = frozenFor / cycle;
      assumptions.push(
        `${Math.round(hp).toLocaleString()} HP ${tier === 'boss' ? 'boss' : 'enemies'}: Frozen every ` +
          `${cycle.toFixed(1)}s, shredded at half Health on average`,
      );
      return {
        dps: (n * shred * bonus) / cycle,
        vulnerability: 1 + m('damageTakenWhileActive') * frozenShare,
        procsPerSecond: n / cycle,
        frozenShare,
        assumptions,
      };
    }
    case 'vulnerability': {
      assumptions.push(`${p.name} kept on every enemy you hit`);
      const effect = 1 + m('effectiveness') + m('effectivenessPerEnemy') * n;
      return {
        dps: m('dotPerSecond') * n * bonus,
        vulnerability: 1 + (p.damageTakenPercent / 100) * effect * eff,
        procsPerSecond: procsTotal,
        assumptions,
      };
    }
  }
  }
}
