import { z } from 'zod';

/** A loadout. Ids reference entries in data/*.json via the maps in ./data. */
export const buildSchema = z.object({
  weaponId: z.string(),
  modeName: z.string(),
  /** A second mode (of the other fire type) to occasionally fire, e.g. to apply
   * a blessing effect, then return to `modeName`. Null means single-mode, as
   * before this field existed. */
  weaveModeName: z.string().nullable().default(null),
  /** One aspect per slot; a slot may be left empty. */
  aspects: z.object({
    primary: z.string().nullable().default(null),
    secondary: z.string().nullable().default(null),
    ability: z.string().nullable().default(null),
  }),
  /**
   * Equipped blessing id -> selected rank (1-based). Only blessings belonging to
   * an equipped aspect are counted; rank is clamped to the blessing's own range.
   */
  blessings: z.record(z.string(), z.number()).default({}),
  /** 1 charm, or 2 with the Charm Power soul skill. */
  charmIds: z.array(z.string()).default([]),
  abilityId: z.string().nullable().default(null),
  /** Up to 3 per the Ancient Forge rules. */
  weaponUpgrades: z.array(z.string()).default([]),
  abilityUpgrades: z.array(z.string()).default([]),
  soulSkillIds: z.array(z.string()).default([]),
});
export type Build = z.infer<typeof buildSchema>;

/** Assumptions the player controls; none of these are knowable from the wiki. */
export interface SimOptions {
  /** Fraction of shots that land on a weakspot. */
  weakspotAccuracy: number;
  /** Fraction of shots that hit at all. */
  accuracy: number;
  /** Player health fraction, for conditionals like "while above 80% Health". */
  healthFraction: number;
  /** Target health fraction, for "enemies at full Health" style conditionals. */
  targetHealthFraction: number;
  /** How many stacks of a stacking effect to assume are up (0..1 of its cap). */
  stackFullness: number;
  /** Charge-based modes: 0 = tap, 1 = fully charged. */
  chargeLevel: number;
  /** Fraction of the time spent firing `weaveModeName` instead of `modeName`.
   * Meaningless (and ignored) when no weave mode is set. */
  weaveRate: number;
}

export const defaultOptions: SimOptions = {
  weakspotAccuracy: 0.5,
  accuracy: 0.95,
  healthFraction: 1.0,
  targetHealthFraction: 1.0,
  stackFullness: 0.5,
  chargeLevel: 1.0,
  weaveRate: 0.2,
};

export const emptyBuild: Build = {
  weaponId: 'Engine_Rifle',
  modeName: 'Automatic Fire',
  weaveModeName: null,
  aspects: { primary: null, secondary: null, ability: null },
  blessings: {},
  charmIds: [],
  abilityId: null,
  weaponUpgrades: [],
  abilityUpgrades: [],
  soulSkillIds: [],
};
