"""Merge real per-fire-mode weapon stats into data/weapons.json.

The wiki never publishes fire rate (every mode in data/weapons.json is
`estimated: true` for it), and reload time/clip size are guessed too. Damage
is usually right from the wiki's own tables, but a few modes clearly have a
guessed number there as well. This pulls the *real* numbers straight from the
game's own data instead: each fire mode has its own `RBaseWeaponSettings`
game asset (a plain `UDataAsset`, not Blueprint graph logic -- unlike the
status-effect DoT magnitudes, which turned out to be a dead end), named
`DA_<Weapon>_<Mode>_ModStats`, holding `BaseWeaponDamage`,
`BaseWeaponCriticalMultiplier` (the real weakspot multiplier), `BaseRateOfFire`,
`BaseReloadTime`, `BaseClipSize`.

Source data comes from scripts/extract/dump_mutators (the same CUE4Parse tool
used for blessing upgrade values), with its `targetDirs` extended to include
`RGame/Content/Blueprints/Weapons`. See scripts/README.md.

Usage:
    python scripts/extract/weapon_mod_stats.py <dumped_json_dir>

<dumped_json_dir> is the outDir passed to dump_mutators, e.g. the folder
containing Blueprints/Weapons/**/*.uasset.json.

Safety rules, deliberately conservative:
  - fireRate/reloadTime/clipSize are always overwritten when the dump has a
    value -- these are plain scalars, no ambiguity.
  - The impact damage component (and, via the crit multiplier, the weakspot
    component) is only overwritten when it currently has `min == max` --
    i.e. the mode has no existing charge/ramp range. Several bow- and
    charge-based modes deliberately spread `min`/`max` to drive
    `opts.chargeLevel` scaling; the single flat `BaseWeaponDamage` figure
    doesn't reliably correspond to either end of that range (confirmed by a
    counterexample: Combat Bow's Pierce has BaseWeaponDamage=150, which is
    neither of its current range endpoints 75 or 300), so those are left
    untouched rather than guessed at.
  - The human-readable `damage`/`weakspotDamage` display strings are only
    rewritten when the *whole* string is the simple `"N"` or `"N xM"` shape
    (a plain regex substitution). Compound strings ("100 (Hit) / 100 x7
    (DoT)") keep their wiki text even when the underlying Hit component's
    number changes underneath -- regenerating those reliably isn't worth the
    risk of corrupting a carefully wiki-transcribed compound description for
    a purely cosmetic label.
"""
import json
import os
import re
import sys
import glob

WEAPON_FOLDER_TO_ID = {
    "EngineRifle": "Engine_Rifle",
    "Shotgun": "Shotgun",
    "TeslaRifle": "Tesla_Gun",
    "BrineRifle": "Brine_Revolver",
    "DiscThrower": "Disc_Thrower",
    "CombatBow": "Combat_Bow",
    "PlasmaLauncher": "Plasma_Launcher",
    "FishDiety": "Fish_Deity",
    "HarpoonGun": "Harpoon_Gun",
}

# Codename -> display-name pairings the normalizer can't find on its own,
# each reasoned from an exact/thematic name match and/or an exact damage-value
# match (see scripts/README.md for the full writeup). All but the last are
# high confidence.
MANUAL_PAIRS = {
    ("Engine_Rifle", "windup"): "Gatling Fire",  # dmg 35 == 35; "increases fire rate the longer you shoot" = a wind-up
    ("Brine_Revolver", "chargedscope"): "Charge Scope",  # dmg 70 == low end of wiki's "70 - 440"
    ("Brine_Revolver", "rapidburst"): "Burst Fire",  # dmg 64 == 64
    ("Brine_Revolver", "rapidfire"): "Semi-automatic",  # dmg 70 == 70
    ("Disc_Thrower", "flame"): "Inferno Discs",  # dmg 80 == 80, thematically identical
    ("Disc_Thrower", "lightningconductors"): "Electron Conductors",  # dmg 80 == 80, "Conductors" matches
    ("Plasma_Launcher", "disintigrationbeam"): "Disintegration Beam",  # dmg 350 == 350, same name (game's own typo)
    ("Tesla_Gun", "chargedbeam"): "Charge Beam",  # dmg 16 == 16, same name
    ("Tesla_Gun", "lightningbeam"): "Electrical Beam",  # dmg 20 == 20, thematically identical
    ("Harpoon_Gun", "bindingharpoon"): "Binding Harpoons",  # dmg 100 == 100 (Hit), same name
    ("Harpoon_Gun", "ricochetharpoon"): "Ricocheting Harpoons",  # dmg 200 == 200, same name
    ("Harpoon_Gun", "pincushion"): "Pinning Harpoons",  # dmg 100 == 100 (Hit), thematically identical
    ("Harpoon_Gun", "harpoon"): "Piercing Harpoons",  # dmg 200 == 200; last unclaimed pairing by elimination
    ("Harpoon_Gun", "railgunharpoon"): "Brine-Powered Harpoons",  # last unclaimed pairing by elimination
    # Lower confidence: no name resemblance, only the low end of the wiki's
    # "30 - 75" range matches (30). Included per explicit decision to flag
    # rather than skip -- keeps `estimated: True` regardless of what else
    # this script would normally clear it to.
    ("Fish_Deity", "piledriver"): "Chainsaw",
}
LOW_CONFIDENCE_PAIRS = {("Fish_Deity", "piledriver")}

SIMPLE_DAMAGE_RE = re.compile(r'^-?\d+(?:\.\d+)?(?: x(\d+))?(?: \(-?\d+(?:\.\d+)?\))?$')


def rewrite_simple_damage_string(old, new_value):
    """Rewrites a "N", "N xM", or "N xM (total)" string to use `new_value`,
    recomputing the parenthesised total (= new_value * M) if present. Returns
    None if `old` isn't one of those shapes (caller should leave it alone)."""
    m = SIMPLE_DAMAGE_RE.match(old or '')
    if not m:
        return None
    count = int(m.group(1)) if m.group(1) else None
    text = f"{new_value:g}"
    if count:
        text += f" x{count} ({new_value * count:g})"
    return text


def norm(s):
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


def load_dumped(dump_dir):
    files = glob.glob(os.path.join(dump_dir, 'Blueprints', 'Weapons', '**', '*_ModStats.uasset.json'), recursive=True)
    entries = []
    for path in files:
        rel = os.path.relpath(path, os.path.join(dump_dir, 'Blueprints', 'Weapons'))
        folder = rel.split(os.sep)[0]
        weapon_id = WEAPON_FOLDER_TO_ID.get(folder)
        if not weapon_id:
            continue
        m = re.match(r'DA_(.+?)_(.+?)_ModStats\.uasset\.json$', os.path.basename(path), re.IGNORECASE)
        if not m:
            continue
        mode_code = m.group(2)
        with open(path, encoding='utf-8') as f:
            arr = json.load(f)
        props = arr[0].get('Properties', {})
        entries.append({
            'weapon_id': weapon_id,
            'code': mode_code,
            'dmg': props.get('BaseWeaponDamage', {}).get('BaseValue'),
            'crit': props.get('BaseWeaponCriticalMultiplier', {}).get('BaseValue'),
            'rof': props.get('BaseRateOfFire', {}).get('BaseValue'),
            'reload': props.get('BaseReloadTime', {}).get('BaseValue'),
            'clip': props.get('BaseClipSize', {}).get('BaseValue'),
        })
    return entries


def find_component(components, kind):
    return next((c for c in (components or []) if c.get('kind') == kind), None)


def apply_entry(mode, entry):
    """Returns a short description of what changed, or None."""
    changes = []
    is_low_confidence = (entry['weapon_id'], norm(entry['code'])) in LOW_CONFIDENCE_PAIRS

    if entry['rof'] is not None and entry['rof'] != mode['fireRate']:
        changes.append(f"fireRate {mode['fireRate']}->{entry['rof']}")
        mode['fireRate'] = entry['rof']
        mode['estimated'] = False

    if entry['reload'] is not None and entry['reload'] != mode.get('reloadTime'):
        changes.append(f"reload {mode.get('reloadTime')}->{entry['reload']}")
        mode['reloadTime'] = entry['reload']

    if entry['clip'] is not None:
        clip = int(entry['clip'])
        if clip != mode.get('clipSize'):
            changes.append(f"clip {mode.get('clipSize')}->{clip}")
            mode['clipSize'] = clip

    # A display string qualified by "(N Combo Points)" (Harpoon Gun's
    # combo-scaled secondaries) means the current number already assumes some
    # typical banked combo count -- BaseWeaponDamage is the pre-combo raw
    # value, not a like-for-like replacement, so leave the damage/weakspot
    # figures alone even though there's no range spread to protect against.
    combo_scaled = 'combo point' in (mode['damage'] or '').lower()

    impact = find_component(mode.get('damageComponents'), 'impact')
    if entry['dmg'] is not None and impact is not None and impact['min'] == impact['max'] and not combo_scaled:
        if impact['min'] != entry['dmg']:
            changes.append(f"dmg {impact['min']}->{entry['dmg']}")
            impact['min'] = impact['max'] = entry['dmg']
            rewritten = rewrite_simple_damage_string(mode['damage'], entry['dmg'])
            if rewritten is not None:
                mode['damage'] = rewritten

    weak_impact = find_component(mode.get('weakspotComponents'), 'impact')
    if entry['crit'] is not None and impact is not None and weak_impact is not None and weak_impact['min'] == weak_impact['max'] and not combo_scaled:
        new_weak = impact['min'] * entry['crit']
        if abs(weak_impact['min'] - new_weak) > 0.001:
            changes.append(f"weakspot {weak_impact['min']}->{new_weak:g}")
            weak_impact['min'] = weak_impact['max'] = new_weak
            rewritten = rewrite_simple_damage_string(mode['weakspotDamage'], new_weak)
            if rewritten is not None:
                mode['weakspotDamage'] = rewritten

    if is_low_confidence:
        mode['estimated'] = True

    return changes, is_low_confidence


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    dump_dir = sys.argv[1]

    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
    weapons_path = os.path.join(repo_root, 'data', 'weapons.json')
    data = json.load(open(weapons_path, encoding='utf-8'))
    weapons_by_id = {w['id']: w for w in data['weapons']}

    dumped = load_dumped(dump_dir)

    updated = 0
    low_confidence = []
    untouched = []
    for weapon in data['weapons']:
        matched_mode_names = set()
        for entry in dumped:
            if entry['weapon_id'] != weapon['id']:
                continue
            mode_norm = norm(entry['code'])
            mode = None
            for candidate in weapon['modes']:
                cn = norm(candidate['name'])
                if cn == mode_norm or cn.replace('fire', '') == mode_norm.replace('fire', ''):
                    mode = candidate
                    break
            if mode is None:
                target_name = MANUAL_PAIRS.get((weapon['id'], mode_norm))
                if target_name:
                    mode = next(m for m in weapon['modes'] if m['name'] == target_name)
            if mode is None:
                continue
            changes, is_low_confidence = apply_entry(mode, entry)
            matched_mode_names.add(mode['name'])
            if changes:
                updated += 1
                tag = " [LOW CONFIDENCE PAIRING]" if is_low_confidence else ""
                print(f"{weapon['id']:16} {mode['name']:24} <- {entry['code']:20} {'; '.join(changes)}{tag}")
                if is_low_confidence:
                    low_confidence.append(f"{weapon['id']}/{mode['name']}")

        for mode in weapon['modes']:
            if mode['name'] not in matched_mode_names:
                untouched.append(f"{weapon['id']}/{mode['name']}")

    json.dump(data, open(weapons_path, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    open(weapons_path, 'a', encoding='utf-8').write('\n')

    print(f"\nUpdated {updated} fire modes with real game data.")
    print(f"Low-confidence pairing (kept estimated=True): {', '.join(low_confidence) or 'none'}")
    print(f"No confident match found, left untouched ({len(untouched)}):")
    for u in untouched:
        print(f"  {u}")


if __name__ == '__main__':
    main()
