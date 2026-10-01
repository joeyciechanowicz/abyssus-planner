import type { Effect, PayloadField, Scope, Stat } from '../model/effects';
import { enemiesFor, type SimOptions } from '../model/build';

/**
 * Accumulated modifiers for one build.
 *
 * STACKING MODEL (the central assumption of the whole simulator):
 * multipliers on the SAME stat are ADDITIVE with each other, and different stats
 * are MULTIPLICATIVE with each other. Three sources of +15% damage therefore give
 * x1.45, not x1.52. This matches how most roguelite shooters present "+N% damage"
 * and is the assumption to revisit first if the numbers drift from in-game values.
 */
export class Modifiers {
  /** stat -> scope -> summed multiplier (0.15 means +15%). */
  private mults = new Map<Stat, Map<Scope, number>>();
  /** stat -> summed flat addition, in the stat's own units. */
  private flats = new Map<Stat, number>();
  /** One-off damage additions contributed by `proc` effects. */
  readonly procs: {
    amount: number;
    of: string;
    chance: number;
    scope: Scope;
    note?: string;
    area?: boolean;
    explosion?: boolean;
  }[] = [];
  /** status -> summed damage multiplier from `statusMod`. */
  readonly statusMods = new Map<string, number>();
  /** status -> best application chance seen. */
  readonly statusApplications = new Map<string, number>();
  /** Per-source contribution log, for the breakdown the UI shows. */
  readonly log: { source: string; stat: string; scope: string; value: number }[] = [];
  /** payload id -> field -> summed value, from `payload` effects. */
  readonly payloadMods = new Map<string, Partial<Record<PayloadField, number>>>();
  /** What had to be assumed to count each pick (deduplicated), for the UI. */
  readonly assumptions: { source: string; text: string }[] = [];

  assume(source: string, text: string) {
    if (!this.assumptions.some((a) => a.source === source && a.text === text)) {
      this.assumptions.push({ source, text });
    }
  }

  addMult(stat: Stat, scope: Scope, value: number, source: string) {
    const byScope = this.mults.get(stat) ?? new Map<Scope, number>();
    byScope.set(scope, (byScope.get(scope) ?? 0) + value);
    this.mults.set(stat, byScope);
    this.log.push({ source, stat, scope, value });
  }

  addPayload(payload: string, field: PayloadField, value: number, source: string) {
    const byField = this.payloadMods.get(payload) ?? {};
    byField[field] = (byField[field] ?? 0) + value;
    this.payloadMods.set(payload, byField);
    this.log.push({ source, stat: field, scope: payload, value });
  }

  addFlat(stat: Stat, value: number, source: string) {
    this.flats.set(stat, (this.flats.get(stat) ?? 0) + value);
    this.log.push({ source, stat, scope: 'flat', value });
  }

  /**
   * Total multiplier for a stat as seen by a given scope: the stat's 'all' bucket
   * plus its scope-specific bucket. Returns the summed bonus, not 1 + bonus.
   */
  multFor(stat: Stat, scope: Scope): number {
    const byScope = this.mults.get(stat);
    if (!byScope) return 0;
    let total = byScope.get('all') ?? 0;
    if (scope !== 'all') total += byScope.get(scope) ?? 0;
    return total;
  }

  /** A scope's own bucket, without the 'all' bucket -- for payloads, whose
   * triggering hit already carried the player's general damage bonuses. */
  multForScopeOnly(stat: Stat, scope: string): number {
    return this.mults.get(stat)?.get(scope as Scope) ?? 0;
  }

  flatFor(stat: Stat): number {
    return this.flats.get(stat) ?? 0;
  }
}

/**
 * Fold one entity's effects into the accumulator.
 *
 * `conditional` and `trigger` are resolved against the player's assumptions rather
 * than simulated over time: a conditional contributes fully when its condition holds
 * under `opts`, and a trigger contributes its inner effects scaled by its chance.
 * That is what makes this a build comparator rather than a combat simulation.
 */
export function applyEffects(
  mods: Modifiers,
  effects: Effect[],
  source: string,
  opts: SimOptions,
  ctx: {
    hasAbility: boolean;
    /** Blessings of the source's own aspect in the build, for `per: 'blessing'` stacks. */
    sameAspectBlessings?: number;
  } = { hasAbility: true },
): void {
  for (const e of effects) {
    switch (e.op) {
      case 'mult':
        mods.addMult(e.stat, e.scope ?? 'all', e.value, source);
        break;

      case 'flat':
        mods.addFlat(e.stat, e.value, source);
        break;

      case 'proc':
        mods.procs.push({
          amount: e.amount,
          of: e.of,
          chance: e.chance ?? 1,
          scope: e.scope ?? 'all',
          note: e.note,
          area: e.area,
          explosion: e.explosion,
        });
        break;

      case 'payload':
        mods.addPayload(e.payload, e.field, e.value, source);
        break;

      case 'statusMod':
        // Not logged to mods.log: statusMods is never read for the DPS number
        // (no consumer exists yet), so logging it would misleadingly show up
        // as a counted Contribution when it changes nothing.
        mods.statusMods.set(e.status, (mods.statusMods.get(e.status) ?? 0) + e.value);
        break;

      case 'applyStatus': {
        const prev = mods.statusApplications.get(e.status) ?? 0;
        mods.statusApplications.set(e.status, Math.max(prev, e.chance));
        break;
      }

      case 'stacking': {
        // Assume `stackFullness` of the cap is up; uncapped effects are assumed to
        // sit at a conservative 5 stacks so they cannot dominate the result.
        if (e.per === 'affectedEnemy') {
          // One stack per enemy you've affected: bounded by how many enemies the
          // target scenario has, not by a guessed cap.
          const enemies = enemiesFor(opts.target);
          const stacks = Math.min(e.max ?? enemies, enemies) * opts.stackFullness;
          mods.addMult(e.stat, e.scope ?? 'all', e.valuePer * stacks, `${source} (${stacks.toFixed(1)} stacks)`);
          mods.assume(source, `every enemy (${fmtStacks(stacks)}) is affected`);
          break;
        }
        if (e.per === 'blessing' && ctx.sameAspectBlessings !== undefined) {
          // "Every X Blessing increases ...": one stack per blessing of that aspect you hold.
          const stacks = Math.min(e.max ?? Infinity, ctx.sameAspectBlessings);
          mods.addMult(e.stat, e.scope ?? 'all', e.valuePer * stacks, `${source} (${stacks} blessings)`);
          break;
        }
        const cap = e.max ?? 5;
        const stacks = cap * opts.stackFullness;
        mods.addMult(e.stat, e.scope ?? 'all', e.valuePer * stacks, `${source} (${stacks.toFixed(1)} stacks)`);
        mods.assume(
          source,
          e.max === null
            ? `${fmtStacks(stacks)} stacks (the card states no cap; 5 is the assumed maximum)`
            : `${fmtStacks(stacks)} of ${e.max} stacks`,
        );
        break;
      }

      case 'conditional':
        if (conditionHolds(e.when, e.threshold, opts)) {
          const why = e.when === 'assumed' ? (e.note ?? null) : assumedCondition(e.when, e.status);
          if (why) mods.assume(source, why);
          applyEffects(mods, e.then, `${source} (${e.when})`, opts, ctx);
        }
        break;

      case 'trigger': {
        // 'abilityUse' can only ever fire if an ability is actually equipped --
        // without this, an effect like "using an ability grants +50% fire
        // rate" would silently apply to builds with no ability at all.
        if (e.on === 'abilityUse' && !ctx.hasAbility) break;

        // Expected value: inner effects scaled by how often the trigger fires.
        // A 'weakspot' trigger additionally needs the player's own assumed
        // weakspot hit rate folded in -- its `chance` alone only says how
        // often the *effect* procs given a weakspot hit, not how often a
        // weakspot hit happens at all.
        const effectiveChance = e.on === 'weakspot' ? e.chance * opts.weakspotAccuracy : e.chance;
        if (effectiveChance < 1) {
          mods.assume(source, `averaged over its ${Math.round(effectiveChance * 100)}% chance per ${e.on}`);
        }
        const scaled = e.then.map((inner) => {
          if (inner.op === 'mult' || inner.op === 'payload') return { ...inner, value: inner.value * effectiveChance };
          // A nested `proc`'s own `chance` is independent of the trigger firing at
          // all -- compose them by multiplying, same expected-value math as `mult`.
          if (inner.op === 'proc') return { ...inner, chance: (inner.chance ?? 1) * effectiveChance };
          return inner;
        });
        applyEffects(mods, scaled as Effect[], `${source} (on ${e.on})`, opts, ctx);
        break;
      }
    }
  }
}

const fmtStacks = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** The assumption a holding condition rests on, if it isn't simply a player setting. */
function assumedCondition(when: string, status: string | undefined): string | null {
  switch (when) {
    case 'targetHasStatus':
      return `the target always has ${status ?? 'the status'}`;
    case 'selfHasStatus':
      return `you always have ${status ?? 'the buff'}`;
    case 'inAoe':
      return 'you or the target stay inside the area';
    default:
      return null;
  }
}

function conditionHolds(
  when: string,
  threshold: number | undefined,
  opts: SimOptions,
): boolean {
  const t = threshold ?? 0;
  switch (when) {
    case 'always':
    case 'assumed':
      return true;
    case 'targetIsEliteOrBoss':
      return opts.target === 'boss';
    case 'targetIsStandard':
      return opts.target === 'pack';
    case 'healthAbove':
      return opts.healthFraction > t;
    case 'healthBelow':
      return opts.healthFraction < t;
    case 'targetHealthAbove':
      return opts.targetHealthFraction >= t;
    case 'targetHealthBelow':
      return opts.targetHealthFraction < t;
    // Status- and position-gated conditions are assumed to hold: the player opted
    // into the build that sets them up.
    case 'targetHasStatus':
    case 'selfHasStatus':
    case 'inAoe':
      return true;
    default:
      return false;
  }
}
