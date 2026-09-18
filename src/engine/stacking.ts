import type { Effect, Scope, Stat } from '../model/effects';
import type { SimOptions } from '../model/build';

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
  readonly procs: { amount: number; of: string; chance: number; scope: Scope; note?: string }[] = [];
  /** status -> summed damage multiplier from `statusMod`. */
  readonly statusMods = new Map<string, number>();
  /** status -> best application chance seen. */
  readonly statusApplications = new Map<string, number>();
  /** Per-source contribution log, for the breakdown the UI shows. */
  readonly log: { source: string; stat: string; scope: string; value: number }[] = [];

  addMult(stat: Stat, scope: Scope, value: number, source: string) {
    const byScope = this.mults.get(stat) ?? new Map<Scope, number>();
    byScope.set(scope, (byScope.get(scope) ?? 0) + value);
    this.mults.set(stat, byScope);
    this.log.push({ source, stat, scope, value });
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
        });
        break;

      case 'statusMod':
        mods.statusMods.set(e.status, (mods.statusMods.get(e.status) ?? 0) + e.value);
        mods.log.push({ source, stat: `status:${e.status}`, scope: 'dot', value: e.value });
        break;

      case 'applyStatus': {
        const prev = mods.statusApplications.get(e.status) ?? 0;
        mods.statusApplications.set(e.status, Math.max(prev, e.chance));
        break;
      }

      case 'stacking': {
        // Assume `stackFullness` of the cap is up; uncapped effects are assumed to
        // sit at a conservative 5 stacks so they cannot dominate the result.
        const cap = e.max ?? 5;
        const stacks = cap * opts.stackFullness;
        mods.addMult(e.stat, e.scope ?? 'all', e.valuePer * stacks, `${source} (${stacks.toFixed(1)} stacks)`);
        break;
      }

      case 'conditional':
        if (conditionHolds(e.when, e.threshold, opts)) {
          applyEffects(mods, e.then, `${source} (${e.when})`, opts);
        }
        break;

      case 'trigger': {
        // Expected value: inner effects scaled by how often the trigger fires.
        const scaled = e.then.map((inner) =>
          inner.op === 'mult' ? { ...inner, value: inner.value * e.chance } : inner,
        );
        applyEffects(mods, scaled as Effect[], `${source} (on ${e.on})`, opts);
        break;
      }
    }
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
      return true;
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
