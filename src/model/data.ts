import { z } from 'zod';
import { effectSchema } from './effects';

import blessingsJson from '../../data/blessings.json';
import charmsJson from '../../data/charms.json';
import weaponsJson from '../../data/weapons.json';
import abilitiesJson from '../../data/abilities.json';
import soulWheelJson from '../../data/soul_wheel.json';
import ancientForgeJson from '../../data/ancient_forge.json';
import statusJson from '../../data/status_effects.json';

/** Shared shape for anything the codifier has annotated with effects. */
const codified = {
  name: z.string(),
  description: z.string(),
  icon: z.string().nullable().optional(),
  // Required, not defaulted: scripts/codify.py writes an effects array onto every
  // entity, so a missing one means the codifier did not run over this file.
  effects: z.array(effectSchema),
  unmodeled: z.string().optional(),
};

export const blessingSchema = z.object({
  id: z.string(),
  aspect: z.string(),
  kind: z.enum(['aspect', 'blessing']),
  // Only the 33 aspect cards carry a slot; plain blessings omit the key entirely.
  slot: z.enum(['primary', 'secondary', 'ability']).nullable().default(null),
  logbookIndex: z.number(),
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
  estimated: z.boolean(),
  comboCost: z.number().optional(),
  chargeSteps: z.number().optional(),
  variantNote: z.string().optional(),
});
export type WeaponMode = z.infer<typeof modeSchema>;

export const weaponSchema = z.object({
  id: z.string(),
  name: z.string(),
  modes: z.array(modeSchema),
  forgeUpgrades: z.array(z.object({ id: z.string().optional(), ...codified })),
});
export type Weapon = z.infer<typeof weaponSchema>;

export const abilitySchema = z.object({
  id: z.string(),
  name: z.string(),
  source: z.string(),
  damage: z.number().nullable(),
  weakspotDamage: z.number().nullable(),
  charges: z.number(),
  tags: z.array(z.string()),
  notes: z.string(),
  pulses: z.object({ count: z.number(), damage: z.number() }).optional(),
  maxActive: z.number().optional(),
  damagePerTick: z.number().optional(),
  damagePerShot: z.number().optional(),
  forgeUpgrades: z.array(z.object({ id: z.string(), ...codified })),
});
export type Ability = z.infer<typeof abilitySchema>;

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

export const blessingsByAspect = new Map<string, Blessing[]>();
for (const b of blessings) {
  const list = blessingsByAspect.get(b.aspect) ?? [];
  list.push(b);
  blessingsByAspect.set(b.aspect, list);
}

export const weaponById = new Map(weapons.map((w) => [w.id, w]));
export const abilityById = new Map(abilities.map((a) => [a.id, a]));
export const blessingById = new Map(blessings.map((b) => [b.id, b]));
export const charmById = new Map(charms.map((c) => [c.id, c]));
export const soulSkillById = new Map(soulSkills.map((s) => [s.id, s]));
