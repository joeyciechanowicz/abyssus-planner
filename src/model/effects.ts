import { z } from 'zod';

/**
 * The effect DSL.
 *
 * Every blessing, charm, forge upgrade and soul-wheel skill carries an `effects[]`
 * array of these operations, translated from its prose description. The engine is a
 * generic interpreter over them, so game data stays editable without touching code.
 *
 * The vocabularies below are deliberately closed: scripts/validate.ts rejects any
 * stat/scope/trigger string outside them, which is what stops the DSL decaying back
 * into free text.
 */

/** What a modifier acts on. Multipliers are summed per-stat, then applied. */
export const STATS = [
  'damage',
  'fireRate',
  'reloadSpeed',
  'clipSize',
  'critChance',
  'critDamage',
  'weakspotDamage',
  'aoeDamage',
  'aoeSize',
  'dotDamage',
  'abilityDamage',
  'abilityCooldown',
  'abilityCharges',
  'maxHealth',
  'damageTaken',
  'statusEffectiveness',
  'statusDuration',
  'triggerChance',
  'movementSpeed',
] as const;
export type Stat = (typeof STATS)[number];

/** Which damage source a modifier applies to. */
export const SCOPES = ['all', 'primary', 'secondary', 'ability', 'melee', 'dot'] as const;
export type Scope = (typeof SCOPES)[number];

/** Events an effect can hang off. */
export const TRIGGERS = [
  'hit',
  'weakspot',
  'crit',
  'kill',
  'reload',
  'dash',
  'abilityUse',
  'damageTaken',
  'encounterStart',
] as const;
export type Trigger = (typeof TRIGGERS)[number];

/** Conditions gating a conditional effect. Engine resolves these against SimContext. */
export const CONDITIONS = [
  'healthAbove',
  'healthBelow',
  'targetHealthAbove',
  'targetHealthBelow',
  'targetHasStatus',
  'selfHasStatus',
  'inAoe',
  'always',
] as const;
export type Condition = (typeof CONDITIONS)[number];

const scope = z.enum(SCOPES).default('all');
const stat = z.enum(STATS);

/** `{op:'mult', stat:'damage', scope:'primary', value:0.15}` = +15% primary damage. */
const multSchema = z.object({
  op: z.literal('mult'),
  stat,
  scope,
  value: z.number(),
  note: z.string().optional(),
});

/** Flat addition in the stat's own units (`maxHealth` +100, `abilityCharges` +1). */
const flatSchema = z.object({
  op: z.literal('flat'),
  stat,
  scope,
  value: z.number(),
  note: z.string().optional(),
});

/** Chance to inflict a status on hit. `chance` is 0..1. */
const applyStatusSchema = z.object({
  op: z.literal('applyStatus'),
  status: z.string(),
  chance: z.number().min(0).max(1),
  scope,
  note: z.string().optional(),
});

/** Modifies an already-applied status (e.g. "Hemorrhage deals 5% more damage"). */
const statusModSchema = z.object({
  op: z.literal('statusMod'),
  status: z.string(),
  stat,
  value: z.number(),
  note: z.string().optional(),
});

/**
 * A per-stack modifier: `valuePer` per unit of `per`, capped at `max` stacks.
 * "5% more damage each time the same target is hit" => valuePer 0.05, per 'hit'.
 */
const stackingSchema = z.object({
  op: z.literal('stacking'),
  stat,
  scope,
  valuePer: z.number(),
  per: z.string(),
  max: z.number().nullable().default(null),
  note: z.string().optional(),
});

/**
 * A one-off burst of damage: "dealing 40 damage to nearby targets" (`of: 'flat'`)
 * or "deals 20% of your Gold as additional damage" (`of` names the base it scales
 * from). Distinct from `mult`, which scales an existing hit rather than adding one.
 */
const procSchema = z.object({
  op: z.literal('proc'),
  amount: z.number(),
  of: z.enum(['flat', 'weaponDamage', 'abilityDamage', 'statusDamage', 'onHitDamage']),
  chance: z.number().min(0).max(1).default(1),
  scope,
  note: z.string().optional(),
});

export type Effect =
  | z.infer<typeof multSchema>
  | z.infer<typeof procSchema>
  | z.infer<typeof flatSchema>
  | z.infer<typeof applyStatusSchema>
  | z.infer<typeof statusModSchema>
  | z.infer<typeof stackingSchema>
  | { op: 'conditional'; when: Condition; threshold?: number; status?: string; then: Effect[]; note?: string }
  | { op: 'trigger'; on: Trigger; chance: number; then: Effect[]; note?: string };

export const effectSchema: z.ZodType<Effect> = z.lazy(() =>
  z.discriminatedUnion('op', [
    multSchema,
    procSchema,
    flatSchema,
    applyStatusSchema,
    statusModSchema,
    stackingSchema,
    z.object({
      op: z.literal('conditional'),
      when: z.enum(CONDITIONS),
      threshold: z.number().optional(),
      status: z.string().optional(),
      then: z.array(effectSchema),
      note: z.string().optional(),
    }),
    z.object({
      op: z.literal('trigger'),
      on: z.enum(TRIGGERS),
      chance: z.number().min(0).max(1),
      then: z.array(effectSchema),
      note: z.string().optional(),
    }),
  ]) as z.ZodType<Effect>,
);

/**
 * Anything carrying codified effects. `unmodeled` explains why `effects` is empty
 * for an entity whose text genuinely cannot be expressed in the DSL -- the UI badges
 * those so a build's number is never silently wrong.
 */
export const codifiedSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string().nullable().optional(),
  effects: z.array(effectSchema),
  unmodeled: z.string().optional(),
});
export type Codified = z.infer<typeof codifiedSchema>;
