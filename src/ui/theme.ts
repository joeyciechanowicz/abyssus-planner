import type { Charm } from '../model/data';

/** URL for an icon path stored in data/*.json (relative to public/). */
export function asset(path: string | null | undefined): string | null {
  return path ? `${import.meta.env.BASE_URL}${path}` : null;
}

/**
 * Each aspect's glow colour, sampled from its blessing icon's art so the board
 * columns read as the same element the player sees in game.
 */
const ASPECT_COLORS: Record<string, string> = {
  Barrier: '#2CD6E0',
  Blood: '#F0505E',
  Brine: '#C9D24E',
  'Chain Lightning': '#8EBBFF',
  Flares: '#F5893A',
  Frozen: '#BFE0F5',
  Goldburst: '#F2BC35',
  Shadows: '#B07AF0',
  Spirit: '#7BE8B0',
  Tentacles: '#22C7B8',
  Windburst: '#D8E6EC',
};

const NEUTRAL = '#93A3A6';

export function aspectColor(aspect: string | null | undefined): string {
  return (aspect && ASPECT_COLORS[aspect]) || NEUTRAL;
}

/**
 * The game draws every charm with one of three shared pendant pictures, one per
 * rarity (there is no per-charm art -- see scripts/extract/game_icons.py).
 */
const CHARM_ART: Record<Charm['rarity'], string> = {
  Common: 'charms/Pendant_Common.webp',
  Rare: 'charms/Pendant_Rare.webp',
  Legendary: 'charms/Pendant_Legendary.webp',
};

export function charmArt(charm: Charm): string | null {
  return asset(CHARM_ART[charm.rarity]);
}

const STAT_LABELS: Record<string, string> = {
  damage: 'Damage',
  fireRate: 'Fire rate',
  reloadSpeed: 'Reload speed',
  clipSize: 'Clip size',
  critChance: 'Critical chance',
  critDamage: 'Critical damage',
  weakspotDamage: 'Weakspot damage',
  aoeDamage: 'Area damage',
  aoeSize: 'Area size',
  dotDamage: 'Damage over time',
  abilityDamage: 'Ability damage',
  abilityCooldown: 'Ability cooldown',
  abilityCharges: 'Ability charges',
  maxHealth: 'Max health',
  damageTaken: 'Damage taken by enemies',
  statusEffectiveness: 'Status effectiveness',
  statusDuration: 'Status duration',
  triggerChance: 'Trigger chance',
  movementSpeed: 'Movement speed',
  // Aspect payload mechanics (`payload` effects).
  chance: 'Proc chance',
  repeats: 'Extra triggers',
  falloffPercent: 'Bounce falloff (points)',
  maxActive: 'Max alive',
  lifetime: 'Lifetime (s)',
  attackSpeed: 'Attack speed',
  attackSpeedPerActive: 'Attack speed per one alive',
  effectiveness: 'Effect',
  effectivenessPerEnemy: 'Effect per afflicted enemy',
  goldPercent: 'Gold dealt as damage (points)',
  triggerPercent: 'Share of the hit (points)',
  burstDamage: 'Extra damage per proc',
  areaBurstDamage: 'Extra area damage per proc',
  dotPerSecond: 'Damage per second',
};

/** Payload fields counted in their own units rather than as a +% bonus. */
export const FLAT_FIELDS = new Set([
  'repeats', 'falloffPercent', 'maxActive', 'lifetime', 'goldPercent', 'triggerPercent',
  'burstDamage', 'areaBurstDamage', 'dotPerSecond',
]);

const SCOPE_LABELS: Record<string, string> = {
  primary: 'primary fire',
  secondary: 'secondary fire',
  ability: 'ability',
  melee: 'melee',
  dot: 'damage over time',
  hemorrhage: 'Hemorrhage',
  burn: 'Fire',
  chainLightning: 'Chain Lightning',
  windburst: 'Windburst',
  tentacle: 'Tentacles',
  goldburst: 'Goldburst',
  shadows: 'Shadows',
};

/** "Damage, primary fire" -- a breakdown row's stat in plain words. */
export function statLabel(stat: string, scope: string): string {
  const base = STAT_LABELS[stat] ?? stat;
  const where = SCOPE_LABELS[scope];
  return where && !base.toLowerCase().includes(where) ? `${base}, ${where}` : base;
}

export const fmt = (n: number) =>
  n >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(n < 10 ? 1 : 0);
