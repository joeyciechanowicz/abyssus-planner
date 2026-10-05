import type { Build } from './build';
import { blessingById, blessingsByAspect, type Blessing } from './data';

/** A blessing the player picks by hand: not an aspect card, not one of the fixed three. */
export const isPickable = (b: Blessing) => b.kind === 'blessing' && !b.role;

/**
 * The Minor is always the 2nd blessing taken from an aspect and the Major the 5th (the
 * aspect card doesn't count). So with n hand-picked blessings you've passed the Minor's
 * turn once n >= 2 (pick 1, Minor, pick 2) and the Major's once n >= 4.
 */
export const MINOR_AFTER = 1;
export const MAJOR_AFTER = 3;

export interface HeldBlessing {
  blessing: Blessing;
  rank: number;
  /** Added by the rules rather than picked (the passive, Minor and Major). */
  auto: boolean;
}

/**
 * Every blessing held from one aspect, in the order the board shows them: the aspect
 * card(s), the passive, then the picks with the Minor and Major in their turn.
 * Ranks come from build.blessings; an auto blessing without an entry is rank 1.
 */
export function heldBlessings(build: Build, aspect: string): HeldBlessing[] {
  const pool = blessingsByAspect.get(aspect) ?? [];
  const held = (b: Blessing, auto: boolean): HeldBlessing => ({ blessing: b, rank: build.blessings[b.id] ?? 1, auto });
  const role = (r: Blessing['role']) => pool.find((b) => b.role === r);

  // Keep the player's pick order (object insertion order).
  const picks = Object.keys(build.blessings)
    .map((id) => blessingById.get(id))
    .filter((b): b is Blessing => !!b && b.aspect === aspect && isPickable(b))
    .map((b) => held(b, false));
  const out: HeldBlessing[] = [];
  picks.forEach((p, i) => {
    out.push(p);
    const minor = role('minor');
    const major = role('major');
    if (i === MINOR_AFTER - 1 && picks.length > MINOR_AFTER && minor) out.push(held(minor, true));
    if (i === MAJOR_AFTER - 1 && picks.length > MAJOR_AFTER && major) out.push(held(major, true));
  });
  const cards = pool.filter((b) => b.kind === 'aspect' && build.blessings[b.id] !== undefined).map((b) => held(b, false));
  const passive = role('passive');
  return [...cards, ...(passive ? [held(passive, true)] : []), ...out];
}

/** "Every Fortune Blessing ...": the blessings that count, i.e. picks plus the Minor and Major. */
export const countedForAspect = (held: HeldBlessing[]) =>
  held.filter((h) => h.blessing.kind === 'blessing' && h.blessing.role !== 'passive').length;

/** The most blessings one aspect can hold at once, counted as countedForAspect() does. */
export const MAX_BLESSINGS_PER_ASPECT = 11;

/** How many more blessings can be hand-picked from `aspect`; the Minor and Major take room as they join. */
export function picksLeft(build: Build, aspect: string): number {
  const pool = blessingsByAspect.get(aspect) ?? [];
  const picks = Object.keys(build.blessings).filter((id) => {
    const b = blessingById.get(id);
    return !!b && b.aspect === aspect && isPickable(b);
  }).length;
  const fixed = pool.filter((b) => b.role === 'minor' || b.role === 'major').length;
  const unpicked = pool.filter((b) => isPickable(b) && build.blessings[b.id] === undefined).length;
  return Math.max(0, Math.min(unpicked, MAX_BLESSINGS_PER_ASPECT - fixed - picks));
}
