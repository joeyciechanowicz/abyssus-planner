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
export const SCOPES = [
  'all',
  'primary',
  'secondary',
  'ability',
  'melee',
  'dot',
  // Aspect payloads (data/aspects.json ids): a `damage` bonus in one of these
  // boosts that payload alone, not weapon damage.
  'hemorrhage',
  'burn',
  'chainLightning',
  'windburst',
  'tentacle',
  'goldburst',
  'shadows',
  'frost',
  'spirit',
  'brine',
  'barrier',
] as const;
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
  /** An ideal-scenario assumption the card's text depends on; `note` says what is assumed. */
  'assumed',
  /** Holds only against the Boss target (Elite & Boss bonuses). */
  'targetIsEliteOrBoss',
  /** Holds only against the Pack target ("standard enemies" effects). */
  'targetIsStandard',
  'always',
] as const;
export type Condition = (typeof CONDITIONS)[number];

const scope = z.enum(SCOPES).default('all');
const stat = z.enum(STATS);

/**
 * On a blessing effect, names the `upgrades[].variable` (e.g. `"{DamageIncrease}"`)
 * whose per-rank values scale this leaf. Set by scripts/link_blessing_upgrades.py;
 * left unset where the link is ambiguous or the blessing has no upgrades at all --
 * scaleBlessingEffects() must leave such a leaf at its baked rank-1 value rather
 * than guess. Meaningless (and always absent) outside blessings.
 */
const scalesWith = z.string().optional();

/** `{op:'mult', stat:'damage', scope:'primary', value:0.15}` = +15% primary damage. */
const multSchema = z.object({
  op: z.literal('mult'),
  stat,
  scope,
  value: z.number(),
  scalesWith,
  note: z.string().optional(),
});

/** Flat addition in the stat's own units (`maxHealth` +100, `abilityCharges` +1). */
const flatSchema = z.object({
  op: z.literal('flat'),
  stat,
  scope,
  value: z.number(),
  scalesWith,
  note: z.string().optional(),
});

/** Chance to inflict a status on hit. `chance` is 0..1. */
const applyStatusSchema = z.object({
  op: z.literal('applyStatus'),
  status: z.string(),
  chance: z.number().min(0).max(1),
  scope,
  scalesWith,
  note: z.string().optional(),
});

/** Modifies an already-applied status (e.g. "Hemorrhage deals 5% more damage"). */
const statusModSchema = z.object({
  op: z.literal('statusMod'),
  status: z.string(),
  stat,
  value: z.number(),
  scalesWith,
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
  scalesWith,
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
  scalesWith,
  /** Like `scalesWith`, but for `chance` -- a proc can scale either independently. */
  chanceScalesWith: z.string().optional(),
  note: z.string().optional(),
});

/** Payload mechanics a `payload` effect can change (see src/engine/payloads.ts). */
export const PAYLOAD_FIELDS = [
  /** +x relative proc chance (0.2 = 20% more procs). */
  'chance',
  /** Extra times each proc fires (Roaring Winds: +1). Fractional = a chance to. */
  'repeats',
  /** +x to the chain falloff percentage (Loaded Bounce: -25 turns -20%/bounce into +5%). */
  'falloffPercent',
  /** Summons: +n alive at once, +s lifetime, +x attack speed, +x attack speed per summon alive. */
  'maxActive',
  'lifetime',
  'attackSpeed',
  'attackSpeedPerActive',
  /** Vulnerability payloads: +x relative effect, and +x per affected enemy. */
  'effectiveness',
  'effectivenessPerEnemy',
  /** Goldburst: +x percentage points of Gold; +x% of the triggering hit. */
  'goldPercent',
  'triggerPercent',
  /** Expected flat damage per proc: to the struck enemy, or to every enemy. */
  'burstDamage',
  'areaBurstDamage',
  /** Flat damage per second on every afflicted enemy. */
  'dotPerSecond',
  /** Freeze: +x relative Frost buildup; +x damage taken by Frozen enemies (scaled by Frozen uptime). */
  'buildup',
  'damageTakenWhileActive',
  /** Freeze: +x relative duration; +x points of current-Health shred on Freeze, per second
   * while Frozen, and when the Freeze ends; x of the buildup kept after a Freeze. */
  'duration',
  'shredPercent',
  'shredPerSecondWhileActive',
  'shredOnEndPercent',
  'buildupRetained',
  /** Gauges (Spirit, Brine, Barrier): +x relative gauge gain; Spirits: x relative orb cost change. */
  'gaugeGain',
  'orbCost',
  /** Barrier: +x to all your damage while it's up (scaled by uptime); +x relative cooldown. */
  'damageWhileActive',
  'cooldown',
  /** Gauges: flat gauge refunded per orb / Brine Ball; chance per hit to fill the gauge outright. */
  'gaugePerOrb',
  'fullGaugeChance',
  /** Fire's Flares: +x relative chance and damage; expected flat damage per Flare to the
   * target / to every enemy; 1 = a Flare sets off every burning enemy; 1 = Fire stacks. */
  'flareChance',
  'flareDamage',
  'flareBurstDamage',
  'flareAreaDamage',
  'linkedFlares',
  'fireStacks',
  /** Tentacles' throw pool (base projectile + one per object blessing, picked at random):
   * +1 object; its extra single-target damage, extra area damage, chance to bounce;
   * +x damage per object in the pool; chance to throw every object at once. */
  'poolObjects',
  'poolDamage',
  'poolAreaDamage',
  'poolBounce',
  'damagePerPoolObject',
  'throwAllChance',
] as const;
export type PayloadField = (typeof PAYLOAD_FIELDS)[number];
const PAYLOAD_IDS = [
  'hemorrhage', 'burn', 'chainLightning', 'windburst', 'tentacle', 'goldburst', 'shadows', 'frost', 'spirit', 'brine', 'barrier',
] as const;

/** Changes how an aspect payload behaves: `{op:'payload', payload:'windburst', field:'repeats', value:1}`. */
const payloadSchema = z.object({
  op: z.literal('payload'),
  payload: z.enum(PAYLOAD_IDS),
  field: z.enum(PAYLOAD_FIELDS),
  value: z.number(),
  scalesWith,
  note: z.string().optional(),
});

export type Effect =
  | z.infer<typeof multSchema>
  | z.infer<typeof procSchema>
  | z.infer<typeof flatSchema>
  | z.infer<typeof applyStatusSchema>
  | z.infer<typeof statusModSchema>
  | z.infer<typeof stackingSchema>
  | z.infer<typeof payloadSchema>
  | { op: 'conditional'; when: Condition; threshold?: number; status?: string; then: Effect[]; note?: string }
  | { op: 'trigger'; on: Trigger; chance: number; scalesWith?: string; then: Effect[]; note?: string };

export const effectSchema: z.ZodType<Effect> = z.lazy(() =>
  z.discriminatedUnion('op', [
    multSchema,
    procSchema,
    flatSchema,
    applyStatusSchema,
    statusModSchema,
    stackingSchema,
    payloadSchema,
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
      scalesWith,
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
  /** True when the pick has no damage effect at all (economy, defence, mobility, crowd control). */
  utility: z.boolean().optional(),
});
export type Codified = z.infer<typeof codifiedSchema>;
