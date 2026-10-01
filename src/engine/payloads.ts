import type { AspectPayload, ScaledHit } from '../model/data';

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
  /** Gold you're carrying (Goldburst hits for a share of it). */
  gold: number;
  /** Summed +% bonuses aimed at this payload alone (e.g. a "+20% Windburst damage" blessing). */
  payloadBonus: number;
}

export interface PayloadResult {
  /** Payload damage per second, summed over all enemies. */
  dps: number;
  /** Multiplier on ALL damage the enemies take (Shadows, Hemorrhage stacks); 1 if none. */
  vulnerability: number;
  /** Procs per second across all enemies. */
  procsPerSecond: number;
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
  let procsTotal = 0;
  let procsPerTarget = 0;
  let triggerWeighted = 0;
  for (const s of streams) {
    const c = Math.min(1, chance * s.procMultiplier);
    const direct = c * s.directHitsPerSecond;
    const area = c * s.areaEventsPerSecond;
    procsTotal += direct + area * n;
    // Direct hits are assumed spread evenly over the pack (ideal: you keep every
    // enemy afflicted); an area event procs on every enemy it hits.
    procsPerTarget += direct / n + area;
    triggerWeighted += direct * s.directHit + area * n * s.areaHit;
  }
  const trigger = procsTotal > 0 ? triggerWeighted / procsTotal : 0;
  const bonus = 1 + ctx.payloadBonus;
  const assumptions: string[] = [];
  const none: PayloadResult = { dps: 0, vulnerability: 1, procsPerSecond: 0, assumptions };
  if (procsTotal === 0) return none;

  switch (p.kind) {
    case 'dot': {
      const up = uptime(procsPerTarget, p.duration);
      const tick =
        p.trigger !== undefined
          ? scaledHit(p.trigger, trigger)
          : ((p.tickBase ?? 0) + ((p.tickPercentOfPrimaryDamage ?? 0) / 100) * ctx.primaryModeDamage) *
            (p.scalesWithTargetMissingHealth ? 1 + ctx.targetMissingHealth : 1);
      const stackBonus = 1 + ((p.damagePercentPerStack ?? 0) / 100) * p.maxStacks;
      const dps = n * (tick / p.tickInterval) * stackBonus * up * bonus;
      const vulnerability = 1 + ((p.damageTakenPercentPerStack ?? 0) / 100) * p.maxStacks * up;
      assumptions.push(
        `${p.name} up ${Math.round(up * 100)}% of the time on ${n === 1 ? 'the target' : `each of ${n} enemies`}`,
      );
      return { dps, vulnerability, procsPerSecond: procsTotal, assumptions };
    }
    case 'chain': {
      const bounces = Math.min(p.chainCount, n - 1);
      let reach = 0;
      for (let i = 0; i <= bounces; i++) reach += (1 - p.falloffPercent / 100) ** i;
      if (bounces > 0) assumptions.push(`each ${p.name} bounces to ${bounces} more enemies`);
      return {
        dps: procsTotal * scaledHit(p.trigger, trigger) * reach * bonus,
        vulnerability: 1,
        procsPerSecond: procsTotal,
        assumptions,
      };
    }
    case 'burst': {
      if (n > 1) assumptions.push(`each ${p.name} catches all ${n} enemies`);
      return {
        dps: procsTotal * scaledHit(p.trigger, trigger) * n * bonus,
        vulnerability: 1,
        procsPerSecond: procsTotal,
        assumptions,
      };
    }
    case 'summon': {
      const active = Math.min(p.maxActive, procsTotal * p.lifetime);
      const attack = p.attackBase + (p.attackPercentOfTrigger / 100) * trigger;
      assumptions.push(`${active.toFixed(1)} of ${p.maxActive} ${p.name}s alive on average`);
      return {
        dps: (active * attack * bonus) / p.attackInterval,
        vulnerability: 1,
        procsPerSecond: procsTotal,
        assumptions,
      };
    }
    case 'gold': {
      assumptions.push(`you carry ${Math.round(ctx.gold)} Gold`);
      return {
        dps: procsTotal * ctx.gold * (p.goldPercent / 100) * bonus,
        vulnerability: 1,
        procsPerSecond: procsTotal,
        assumptions,
      };
    }
    case 'vulnerability': {
      assumptions.push(`${p.name} kept on every enemy you hit`);
      return { dps: 0, vulnerability: 1 + p.damageTakenPercent / 100, procsPerSecond: procsTotal, assumptions };
    }
  }
}
