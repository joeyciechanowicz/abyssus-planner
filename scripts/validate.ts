/**
 * Validates every data file against the schemas and prints codification coverage.
 *
 * Importing ../src/model/data runs the Zod parse of all seven data files, so a
 * malformed file or an unknown stat/scope/status fails here before it can reach
 * the engine or the UI.
 *
 * Run: npm run validate
 */
import {
  abilities,
  blessings,
  charms,
  sharedAbilityUpgrades,
  soulSkills,
  weapons,
} from '../src/model/data';
import { STATUSES_SEEN, collectStatuses } from './statuses';

// `effects` is optional in the inferred type because its schema carries .default([]).
interface Group {
  label: string;
  items: { name: string; effects?: unknown[]; unmodeled?: string }[];
}

const effectsOf = (i: { effects?: unknown[] }) => i.effects ?? [];

const groups: Group[] = [
  { label: 'blessings', items: blessings },
  { label: 'charms', items: charms },
  { label: 'soul wheel', items: soulSkills },
  { label: 'weapon forge', items: weapons.flatMap((w) => w.forgeUpgrades) },
  { label: 'ability forge', items: abilities.flatMap((a) => a.forgeUpgrades) },
  { label: 'shared ability forge', items: sharedAbilityUpgrades },
];

console.log('all data files parsed against their schemas\n');
console.log('=== codification coverage ===');

let total = 0;
let codified = 0;
for (const g of groups) {
  const c = g.items.filter((i) => effectsOf(i).length > 0).length;
  total += g.items.length;
  codified += c;
  const pct = ((100 * c) / g.items.length).toFixed(0);
  console.log(`  ${g.label.padEnd(22)} ${String(c).padStart(3)}/${String(g.items.length).padStart(3)}  (${pct}%)`);
}
console.log(
  `  ${'TOTAL'.padEnd(22)} ${String(codified).padStart(3)}/${String(total).padStart(3)}  ` +
    `(${((100 * codified) / total).toFixed(0)}%)`,
);

// Entities with neither effects nor an explanation are a codifier bug, not an
// honest gap -- they would silently contribute nothing with no warning in the UI.
const silent = groups.flatMap((g) =>
  g.items.filter((i) => effectsOf(i).length === 0 && !i.unmodeled).map((i) => `${g.label}: ${i.name}`),
);
if (silent.length > 0) {
  console.error(`\n${silent.length} entities have no effects AND no unmodeled reason:`);
  for (const s of silent) console.error('  ' + s);
  process.exit(1);
}

// Fire-mode sanity.
const modes = weapons.flatMap((w) => w.modes.map((m) => ({ w: w.id, m })));
const unparsed = modes.filter((x) => x.m.damageParsed === 'unparsed');
if (unparsed.length > 0) {
  console.error(`\n${unparsed.length} fire modes have unparsed damage:`);
  for (const x of unparsed) console.error(`  ${x.w}/${x.m.name}: ${x.m.damage}`);
  process.exit(1);
}
const estimated = modes.filter((x) => x.m.estimated).length;
console.log(`\n${modes.length} fire modes parsed; ${estimated} use estimated rate-of-fire values`);

// Statuses referenced by effects but not named in the status vocabulary. Reported,
// not fatal: the wiki names aspect mechanics that its own Status effects page omits.
collectStatuses(groups.flatMap((g) => g.items.flatMap((i) => effectsOf(i))));
const unknown = [...STATUSES_SEEN].sort();
if (unknown.length > 0) {
  console.log(`\nstatuses referenced by effects (${unknown.length}): ${unknown.join(', ')}`);
}
