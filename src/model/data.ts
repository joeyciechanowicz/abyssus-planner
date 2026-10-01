import { z } from 'zod';
import { effectSchema } from './effects';

import blessingsJson from '../../data/blessings.json';
import charmsJson from '../../data/charms.json';
import weaponsJson from '../../data/weapons.json';
import abilitiesJson from '../../data/abilities.json';
import soulWheelJson from '../../data/soul_wheel.json';
import ancientForgeJson from '../../data/ancient_forge.json';
import statusJson from '../../data/status_effects.json';
import aspectsJson from '../../data/aspects.json';
import enemiesJson from '../../data/enemies.json';

/** Shared shape for anything the codifier has annotated with effects. */
const codified = {
  name: z.string(),
  description: z.string(),
  icon: z.string().nullable().optional(),
  // Required, not defaulted: scripts/codify.py writes an effects array onto every
  // entity, so a missing one means the codifier did not run over this file.
  effects: z.array(effectSchema),
  unmodeled: z.string().optional(),
  // No damage effect at all (economy, defence, mobility, crowd control): shown as
  // utility rather than as a modelling gap. Set in scripts/effect_overrides.json.
  utility: z.boolean().optional(),
};

/** One scaling variable on a blessing, e.g. "{DamageIncrease}" going 15/30/45/60%... by rank. */
export const blessingUpgradeVariableSchema = z.object({
  variable: z.string(),
  label: z.string().nullable(),
  isPercent: z.boolean(),
  // Absolute value at each rank (not deltas), rank 1 first. Scaling is not linear.
  ranks: z.array(z.number()),
  // [start, end) offset of this variable's rank-1 value inside `description`, so
  // renderBlessingDescription() can substitute in a different rank's value. Null
  // when scripts/link_blessing_upgrades.py couldn't find an unambiguous match.
  descriptionSpan: z.tuple([z.number(), z.number()]).nullable().optional(),
});
export type BlessingUpgradeVariable = z.infer<typeof blessingUpgradeVariableSchema>;

export const blessingSchema = z.object({
  id: z.string(),
  aspect: z.string(),
  kind: z.enum(['aspect', 'blessing']),
  // Only the 33 aspect cards carry a slot; plain blessings omit the key entirely.
  slot: z.enum(['primary', 'secondary', 'ability']).nullable().default(null),
  logbookIndex: z.number(),
  // Absent for capstone-style blessings that have no per-rank scaling variables.
  upgrades: z.array(blessingUpgradeVariableSchema).optional(),
  ...codified,
});
export type Blessing = z.infer<typeof blessingSchema>;

export const charmSchema = z.object({
  id: z.string(),
  rarity: z.enum(['Common', 'Rare', 'Legendary']),
  unlockedByDefault: z.boolean(),
  unlockCondition: z.string().nullable(),
  ...codified,
});
export type Charm = z.infer<typeof charmSchema>;

/** One parsed piece of a mode's damage string, e.g. the DoT half of "100 / 25 x6". */
export const damageComponentSchema = z.object({
  label: z.string().nullable(),
  kind: z.enum(['impact', 'dot', 'explosion', 'pull', 'aoe']),
  min: z.number(),
  max: z.number(),
  count: z.number(),
  chargeSteps: z.number().optional(),
  // An impact that also explodes (Plasma Launcher orbs): the struck enemy takes the hit,
  // everything nearby the explosion.
  explodes: z.boolean().optional(),
});
export type DamageComponent = z.infer<typeof damageComponentSchema>;

export const modeSchema = z.object({
  name: z.string(),
  type: z.enum(['Primary', 'Secondary']),
  damage: z.string(),
  weakspotDamage: z.string(),
  special: z.string(),
  icon: z.string().nullable(),
  unlockedByDefault: z.boolean(),
  unlockCondition: z.string().nullable(),
  damageComponents: z.array(damageComponentSchema).nullable(),
  weakspotComponents: z.array(damageComponentSchema).nullable(),
  damageParsed: z.enum(['auto', 'manual', 'unparsed']),
  // Rate-of-fire values are estimates: the wiki publishes none of them.
  fireRate: z.number(),
  clipSize: z.number().nullable(),
  reloadTime: z.number(),
  projectilesPerShot: z.number(),
  // The mode's multiplier on aspect proc chances (BaseProcChance in its game asset):
  // slow, heavy modes roll at x2-x4. 1 when the game asset leaves it at its default.
  procChance: z.number().default(1),
  estimated: z.boolean(),
  comboCost: z.number().optional(),
  chargeSteps: z.number().optional(),
  variantNote: z.string().optional(),
  // Harpoon Gun Secondaries: damage multiplier by Combo Points spent (index = points),
  // single target and, where it differs, per target when several are hit.
  comboCurve: z.object({ single: z.array(z.number()), multi: z.array(z.number()).optional() }).optional(),
  // Engine Rifle Secondaries spend heat instead of ammo (scripts/extract/engine_rifle_heat.py).
  heatPerShot: z.number().optional(),
});
export type WeaponMode = z.infer<typeof modeSchema>;

export const weaponSchema = z.object({
  id: z.string(),
  name: z.string(),
  // Portrait art from the game files (scripts/extract/game_icons.py).
  icon: z.string().nullable().optional(),
  modes: z.array(modeSchema),
  // Harpoon Gun: Combo Points banked by Primary hits, spent by Secondaries.
  maxComboPoints: z.number().optional(),
  // Engine Rifle: heat cap, cooling per second while no heat mode is held, overheat lockout.
  heat: z.object({ max: z.number(), coolPerSecond: z.number(), overheatDuration: z.number() }).optional(),
  forgeUpgrades: z.array(z.object({ id: z.string().optional(), ...codified })),
});
export type Weapon = z.infer<typeof weaponSchema>;

export const abilitySchema = z.object({
  id: z.string(),
  name: z.string(),
  source: z.string(),
  // Ability art from the game files (scripts/extract/game_icons.py).
  icon: z.string().nullable().optional(),
  damage: z.number().nullable(),
  weakspotDamage: z.number().nullable(),
  charges: z.number(),
  tags: z.array(z.string()),
  notes: z.string(),
  pulses: z.object({ count: z.number(), damage: z.number() }).optional(),
  maxActive: z.number().optional(),
  // Smiting Spear: seconds each spear stays out (its pulses spread over it).
  lifetime: z.number().optional(),
  damagePerTick: z.number().optional(),
  damagePerShot: z.number().optional(),
  // From the ability's Blueprint (scripts/extract/ability_timing.py): seconds to recharge one
  // charge (charges recharge one at a time) and the minimum seconds between two uses.
  rechargeCooldown: z.number(),
  inputCooldown: z.number(),
  // Abilities that deal their damage over a lifetime (Turret, Brine Field) instead of on impact.
  sustain: z
    .object({ perHit: z.number(), hitsPerSecond: z.number(), duration: z.number(), area: z.boolean() })
    .optional(),
  forgeUpgrades: z.array(z.object({ id: z.string(), ...codified })),
});
export type Ability = z.infer<typeof abilitySchema>;

/** "base + percent% of the triggering hit, percentAboveCap% beyond softCap" -- the shared payload formula. */
const scaledHitSchema = z.object({
  base: z.number(),
  percent: z.number(),
  softCap: z.number(),
  percentAboveCap: z.number(),
});
export type ScaledHit = z.infer<typeof scaledHitSchema>;

const payloadCommon = { id: z.string(), aspect: z.string(), name: z.string(), evidence: z.string() };

/**
 * What an aspect card's proc actually does, from the game files
 * (scripts/extract/aspect_payloads.py). Formulas live in src/engine/payloads.ts.
 */
export const aspectPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    ...payloadCommon,
    kind: z.literal('dot'),
    // Either a fixed tick from the primary mode's damage (Hemorrhage) ...
    tickBase: z.number().optional(),
    tickPercentOfPrimaryDamage: z.number().optional(),
    scalesWithTargetMissingHealth: z.boolean().optional(),
    // ... or a tick equal to a scaled triggering hit (Fire).
    trigger: scaledHitSchema.optional(),
    tickInterval: z.number(),
    duration: z.number(),
    maxStacks: z.number(),
    damageTakenPercentPerStack: z.number().optional(),
    damagePercentPerStack: z.number().optional(),
    // Fire only: Flares on burning enemies.
    flare: z.object({ chancePercent: z.number(), damage: z.number(), lockout: z.number() }).optional(),
  }),
  z.object({
    ...payloadCommon,
    kind: z.literal('chain'),
    trigger: scaledHitSchema,
    chainCount: z.number(),
    falloffPercent: z.number(),
    range: z.number(),
  }),
  z.object({ ...payloadCommon, kind: z.literal('burst'), trigger: scaledHitSchema, radius: z.number() }),
  z.object({
    ...payloadCommon,
    kind: z.literal('summon'),
    attackBase: z.number(),
    attackPercentOfTrigger: z.number(),
    attackInterval: z.number(),
    lifetime: z.number(),
    maxActive: z.number(),
  }),
  z.object({ ...payloadCommon, kind: z.literal('vulnerability'), damageTakenPercent: z.number() }),
  z.object({
    ...payloadCommon,
    kind: z.literal('freeze'),
    thresholdPercent: z.object({ standard: z.number(), elite: z.number(), boss: z.number() }),
    thresholdCap: z.object({ standard: z.number(), elite: z.number(), boss: z.number() }),
    shredPercentOfCurrent: z.object({ standard: z.number(), elite: z.number(), boss: z.number() }),
    minShredPercentOfMax: z.number(),
    freezeDuration: z.number(),
  }),
  z.object({
    ...payloadCommon,
    kind: z.literal('spirit'),
    maxGauge: z.number(),
    orbCost: z.number(),
    orbCostIncrementPercent: z.number(),
    orbInterval: z.number(),
    orb: scaledHitSchema,
  }),
  z.object({
    ...payloadCommon,
    kind: z.literal('brine'),
    vialCapacity: z.number(),
    explosionBase: z.number(),
    explosionPercentOfTrigger: z.number(),
  }),
  z.object({ ...payloadCommon, kind: z.literal('barrier'), maxGauge: z.number(), duration: z.number(), cooldown: z.number() }),
  // Damage = your current Gold x goldPercent%, to the struck enemy.
  z.object({ ...payloadCommon, kind: z.literal('gold'), goldPercent: z.number(), sphereRadius: z.number() }),
]);
export type AspectPayload = z.infer<typeof aspectPayloadSchema>;

export const soulSkillSchema = z.object({ id: z.string(), ...codified });
export type SoulSkill = z.infer<typeof soulSkillSchema>;

export const soulRowSchema = z.object({
  row: z.number(),
  costPerPoint: z.number(),
  skills: z.array(soulSkillSchema),
});

// Generic over the schema, not its output type: schemas using .default() have an
// input type that differs from their output, which z.ZodType<T> cannot express.
function parse<S extends z.ZodTypeAny>(schema: S, value: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`${what} failed validation:\n${result.error.toString()}`);
  }
  return result.data;
}

export const blessings = parse(z.array(blessingSchema), blessingsJson.blessings, 'blessings');
export const aspects: string[] = blessingsJson.aspects;
export const charms = parse(z.array(charmSchema), charmsJson.charms, 'charms');
export const weapons = parse(z.array(weaponSchema), weaponsJson.weapons, 'weapons');
export const abilities = parse(z.array(abilitySchema), abilitiesJson.abilities, 'abilities');
export const soulWheel = parse(z.array(soulRowSchema), soulWheelJson.rows, 'soul wheel');
export const soulSkills = soulWheel.flatMap((r) => r.skills);
export const sharedAbilityUpgrades = parse(
  z.array(z.object({ ...codified })),
  ancientForgeJson.abilityUpgrades.shared,
  'shared ability upgrades',
);
export const statusEffects = statusJson;
export const aspectPayloads = parse(z.array(aspectPayloadSchema), aspectsJson.payloads, 'aspect payloads');
export const payloadByAspect = new Map(aspectPayloads.map((p) => [p.aspect, p]));

/** Enemies' typical base max Health by tier, from the game files (scripts/extract/enemy_health.py). */
export const enemyHealth = parse(
  z.object({ standard: z.number(), elite: z.number(), boss: z.number() }),
  enemiesJson.typicalHealth,
  'enemy health',
);

export const blessingsByAspect = new Map<string, Blessing[]>();
for (const b of blessings) {
  const list = blessingsByAspect.get(b.aspect) ?? [];
  list.push(b);
  blessingsByAspect.set(b.aspect, list);
}

/**
 * Highest selectable rank for a blessing; 1 for capstones with no `upgrades`.
 * A blessing's variables don't always share one rank count (e.g. Golden Skin's
 * Gold-threshold variable has 11 steps but its damage-reduction variable only 2),
 * so this is the longest of them -- shorter variables just clamp at their own max.
 */
export function maxBlessingRank(b: Blessing): number {
  if (!b.upgrades || b.upgrades.length === 0) return 1;
  return Math.max(...b.upgrades.map((u) => u.ranks.length));
}

/**
 * `b.description` with each upgrade variable's placeholder substituted for its
 * value at `rank` (1-based, clamped to the blessing's range). Variables without a
 * `descriptionSpan` (scripts/link_blessing_upgrades.py couldn't place them
 * unambiguously) are left as their rank-1 text.
 */
/** A blessing's value for `variable` at `rank` (clamped), or undefined if it has no such variable. */
export function blessingRankValue(b: Blessing, variable: string, rank: number): number | undefined {
  const u = b.upgrades?.find((x) => x.variable === variable);
  if (!u) return undefined;
  return u.ranks[Math.min(Math.max(rank, 1), u.ranks.length) - 1];
}

export function renderBlessingDescription(b: Blessing, rank: number): string {
  const upgrades = b.upgrades ?? [];
  const spans = upgrades
    .filter((u) => u.descriptionSpan)
    .map((u) => ({ ...u, descriptionSpan: u.descriptionSpan! }))
    .sort((a, b2) => b2.descriptionSpan[0] - a.descriptionSpan[0]);

  let text = b.description;
  for (const u of spans) {
    const clamped = Math.min(Math.max(rank, 1), u.ranks.length);
    const value = u.ranks[clamped - 1];
    const rendered = u.isPercent ? `${value}%` : `${value}`;
    const [start, end] = u.descriptionSpan;
    text = text.slice(0, start) + rendered + text.slice(end);
  }
  return text;
}

export const weaponById = new Map(weapons.map((w) => [w.id, w]));
export const abilityById = new Map(abilities.map((a) => [a.id, a]));
export const blessingById = new Map(blessings.map((b) => [b.id, b]));
export const charmById = new Map(charms.map((c) => [c.id, c]));
export const soulSkillById = new Map(soulSkills.map((s) => [s.id, s]));
