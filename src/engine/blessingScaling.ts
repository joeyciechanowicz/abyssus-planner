import type { Effect } from '../model/effects';
import { maxBlessingRank, type Blessing } from '../model/data';

const TOL = 1e-9;

type Variable = { ranks: number[] };

/**
 * Rescales `value` (a leaf tagged `scalesWith` -> `variable`) to its value at
 * `rank`, keeping the same ratio to `variable.ranks[0]` that `value` already has.
 * That ratio -- rather than a hardcoded percent/flat distinction -- is what makes
 * this work for both percent-as-fraction effects and negated ("reduces damage by")
 * ones: the sign and unit convention baked into `value` carry through untouched.
 */
function rescale(value: number, variable: Variable | undefined, rank: number): number {
  if (!variable) return value;
  const rank0 = variable.ranks[0];
  if (!rank0 || Math.abs(rank0) < TOL) return value;
  const clamped = Math.min(Math.max(rank, 1), variable.ranks.length);
  return variable.ranks[clamped - 1] * (value / rank0);
}

function scaleTree(effects: Effect[], variablesByName: Map<string, Variable>, rank: number): void {
  for (const node of effects) {
    switch (node.op) {
      case 'mult':
      case 'flat':
      case 'statusMod':
        if (node.scalesWith) node.value = rescale(node.value, variablesByName.get(node.scalesWith), rank);
        break;
      case 'applyStatus':
        if (node.scalesWith) node.chance = rescale(node.chance, variablesByName.get(node.scalesWith), rank);
        break;
      case 'stacking':
        if (node.scalesWith) node.valuePer = rescale(node.valuePer, variablesByName.get(node.scalesWith), rank);
        break;
      case 'proc':
        if (node.scalesWith) node.amount = rescale(node.amount, variablesByName.get(node.scalesWith), rank);
        if (node.chanceScalesWith) {
          node.chance = rescale(node.chance, variablesByName.get(node.chanceScalesWith), rank);
        }
        break;
      case 'trigger':
        if (node.scalesWith) node.chance = rescale(node.chance, variablesByName.get(node.scalesWith), rank);
        scaleTree(node.then, variablesByName, rank);
        break;
      case 'conditional':
        scaleTree(node.then, variablesByName, rank);
        break;
    }
  }
}

/**
 * Returns `blessing.effects` with every leaf tagged `scalesWith` (by
 * scripts/link_blessing_upgrades.py) replaced by its value at `rank`. Leaves
 * without a link -- ambiguous, or the blessing has no `upgrades` at all -- are
 * left untouched, same as if rank 1 had been selected.
 */
export function scaleBlessingEffects(blessing: Blessing, rank: number): Effect[] {
  const clamped = Math.min(Math.max(rank, 1), maxBlessingRank(blessing));
  if (clamped === 1) return blessing.effects;

  const variablesByName = new Map((blessing.upgrades ?? []).map((u) => [u.variable, u]));
  const cloned = structuredClone(blessing.effects) as Effect[];
  scaleTree(cloned, variablesByName, clamped);
  return cloned;
}

function collectLinkedVariables(effects: Effect[], out: Set<string>): void {
  for (const node of effects) {
    if ('scalesWith' in node && node.scalesWith) out.add(node.scalesWith);
    if (node.op === 'proc' && node.chanceScalesWith) out.add(node.chanceScalesWith);
    if ('then' in node) collectLinkedVariables(node.then, out);
  }
}

/**
 * False when a blessing has `upgrades` but at least one variable isn't tied to
 * any effect leaf -- picking a rank will change its displayed description, but
 * not (fully) the simulated number. True for capstones with no `upgrades` at
 * all, since there's no rank to pick in the first place.
 */
export function isFullyRankLinked(blessing: Blessing): boolean {
  if (!blessing.upgrades || blessing.upgrades.length === 0) return true;
  const linked = new Set<string>();
  collectLinkedVariables(blessing.effects, linked);
  return blessing.upgrades.every((u) => linked.has(u.variable));
}
