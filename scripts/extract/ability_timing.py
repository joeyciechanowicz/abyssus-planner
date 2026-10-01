"""Add real recharge timing (and sustained-damage abilities' rates) to data/abilities.json.

Every ability's Blueprint CDO (`BP_<Codename>_CharacterMutator`, an
URGAbilityCharacterMutatorScript) carries:
  StacksRechargeCooldown  seconds to recharge ONE charge (they recharge one at a time)
  MaxStacks               charges
  InputCooldown           minimum seconds between two uses
  StacksRestoredOnAllEnemiesDefeated  999 -> clearing an encounter refills every charge
Abilities that deal damage over their lifetime instead of on impact get a
`sustain` block: the Turret (BP_Turret: Damage x RateOfFire for
TurretLifeDuration minus its SpawnDelay) and the Brine Field
(BP_DropShield_AreaEffect_Script: DamagePerTick every DamageTickInterval for
the ability's EffectDuration).

Usage: python scripts/extract/ability_timing.py <dump_kismet out dir>
       (needs Blueprints/Player/EquippableAbilities and Blueprints/Mutators dumped)
"""
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from wiki import DATA, write_json  # noqa: E402

# data/abilities.json id -> the ability's Blueprint (codenames, see game_icons.py).
BLUEPRINT = {
    'frag_grenade': 'BP_FragGrenade_CharacterMutator',
    'anchor': 'BP_Anchor_CharacterMutator',
    'smiting_spear': 'BP_AncientSpear_CharacterMutatorScript',
    'ancient_core': 'BP_AtlanteanCube_CharacterMutator',
    'brine_field': 'BP_DropShield_CharacterMutator',
    'turret': 'BP_Turret_CharacterMutator',
}


def cdo(dump, name):
    hits = glob.glob(os.path.join(dump, '**', name + '.uasset.json'), recursive=True)
    if len(hits) != 1:
        sys.exit(f'expected one {name} in the dump, found {len(hits)}')
    for e in json.load(open(hits[0], encoding='utf-8')):
        if e.get('Name', '').startswith('Default__'):
            return e.get('Properties') or {}
    sys.exit(f'{name}: no class default object')


def val(v):
    return v['Value'] if isinstance(v, dict) else v


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    dump = sys.argv[1]
    path = os.path.join(DATA, 'abilities.json')
    doc = json.load(open(path, encoding='utf-8'))
    for a in doc['abilities']:
        p = cdo(dump, BLUEPRINT[a['id']])
        a['rechargeCooldown'] = val(p['StacksRechargeCooldown'])
        a['inputCooldown'] = val(p['InputCooldown'])
        if val(p['MaxStacks']) != a['charges']:
            print(f"{a['id']}: charges {a['charges']} -> {val(p['MaxStacks'])} (game)")
            a['charges'] = val(p['MaxStacks'])
        a.pop('sustain', None)

    turret = next(a for a in doc['abilities'] if a['id'] == 'turret')
    t = cdo(dump, 'BP_Turret')
    life = cdo(dump, 'BP_Turret_CharacterMutator')['TurretLifeDuration']
    turret['sustain'] = {'perHit': val(t['Damage']), 'hitsPerSecond': val(t['RateOfFire']), 'duration': life - t['SpawnDelay'],
                         'area': False}

    field = next(a for a in doc['abilities'] if a['id'] == 'brine_field')
    f = cdo(dump, 'BP_DropShield_AreaEffect_Script')
    dur = val(cdo(dump, 'BP_DropShield_CharacterMutator')['EffectDuration'])
    field['sustain'] = {'perHit': f['DamagePerTick'], 'hitsPerSecond': 1 / f['DamageTickInterval'], 'duration': dur,
                        'area': True}

    write_json(path, doc)


if __name__ == '__main__':
    main()
