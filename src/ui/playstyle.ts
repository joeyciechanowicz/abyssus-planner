import type { Build, SimOptions } from '../model/build';
import type { Weapon, WeaponMode } from '../model/data';

/**
 * Named quick-picks over the existing weaveModeName/weaveRate/weaponUptime
 * controls -- write-only UI convenience, no persisted state of its own. See
 * detectPlaystyle()/applyPlaystyle() below.
 */
export type Playstyle =
  | 'onlyPrimary'
  | 'onlySecondary'
  | 'onlyAbility'
  | 'mainlyPrimary'
  | 'mainlySecondary'
  | 'mainlyAbility';

export const PLAYSTYLES: { id: Playstyle; label: string; requiresType?: WeaponMode['type'] }[] = [
  { id: 'onlyPrimary', label: 'Only primary', requiresType: 'Primary' },
  { id: 'onlySecondary', label: 'Only secondary', requiresType: 'Secondary' },
  { id: 'onlyAbility', label: 'Only ability' },
  {
    id: 'mainlyPrimary',
    label: 'Mainly primary, weave secondary + ability',
    requiresType: 'Primary',
  },
  { id: 'mainlySecondary', label: 'Mainly secondary, weave the other two', requiresType: 'Secondary' },
  { id: 'mainlyAbility', label: 'Mainly ability, weave the other two' },
];

const WEAVE_RATE_MAINLY = 0.2;
const ABILITY_UPTIME_MAINLY = 0.25;
const ABILITY_WEAVE_RATE = 0.5;

const close = (a: number, b: number) => Math.abs(a - b) < 0.005;

/** Which of the 6 named playstyles the current build/options actually match, if any. */
export function detectPlaystyle(build: Build, opts: SimOptions, mode: WeaponMode): Playstyle | null {
  if (close(opts.weaponUptime, 0)) return 'onlyAbility';

  if (close(opts.weaponUptime, 1)) {
    if (!build.weaveModeName) {
      return mode.type === 'Primary' ? 'onlyPrimary' : 'onlySecondary';
    }
    if (close(opts.weaveRate, WEAVE_RATE_MAINLY)) {
      return mode.type === 'Primary' ? 'mainlyPrimary' : 'mainlySecondary';
    }
    return null;
  }

  if (
    close(opts.weaponUptime, ABILITY_UPTIME_MAINLY) &&
    build.weaveModeName &&
    close(opts.weaveRate, ABILITY_WEAVE_RATE)
  ) {
    return 'mainlyAbility';
  }

  return null;
}

const otherType = (t: WeaponMode['type']): WeaponMode['type'] => (t === 'Primary' ? 'Secondary' : 'Primary');

/** Patches to apply when the player picks a named playstyle from the dropdown. */
export function applyPlaystyle(
  id: Playstyle,
  build: Build,
  weapon: Weapon,
  mode: WeaponMode,
): { buildPatch: Partial<Build>; optsPatch: Partial<SimOptions> } {
  const firstOfType = (t: WeaponMode['type']) => weapon.modes.find((m) => m.type === t)?.name ?? null;
  // Keep the current weave mode only if it's already the fire type this
  // preset wants -- otherwise a stale weave from a previously-picked preset
  // (of a different type) would silently stick around.
  const weaveOfType = (t: WeaponMode['type']) => {
    const current = weapon.modes.find((m) => m.name === build.weaveModeName);
    return current?.type === t ? current.name : firstOfType(t);
  };

  switch (id) {
    case 'onlyPrimary':
    case 'onlySecondary':
      return { buildPatch: { weaveModeName: null }, optsPatch: { weaponUptime: 1 } };
    case 'onlyAbility':
      return { buildPatch: {}, optsPatch: { weaponUptime: 0 } };
    case 'mainlyPrimary':
      return {
        buildPatch: { weaveModeName: weaveOfType('Secondary') },
        optsPatch: { weaponUptime: 1, weaveRate: WEAVE_RATE_MAINLY },
      };
    case 'mainlySecondary':
      return {
        buildPatch: { weaveModeName: weaveOfType('Primary') },
        optsPatch: { weaponUptime: 1, weaveRate: WEAVE_RATE_MAINLY },
      };
    case 'mainlyAbility':
      return {
        buildPatch: { weaveModeName: weaveOfType(otherType(mode.type)) },
        optsPatch: { weaponUptime: ABILITY_UPTIME_MAINLY, weaveRate: ABILITY_WEAVE_RATE },
      };
  }
}
