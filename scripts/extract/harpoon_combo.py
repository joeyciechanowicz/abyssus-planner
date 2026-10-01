"""Add the Harpoon Gun's Combo Point curves to data/weapons.json.

Primary harpoons add a Combo Point per hit (BP_HarpoonGun_Script::AddComboPoint,
capped at MaxComboPoints = 4); a Secondary consumes them all
(ConsumeComboPoints) and scales its damage by the mode's curve asset,
C_<Mode>_DamageMultiPerComboPoint_Curve: multiplier by points spent, 0..6.
The wiki's Secondary damage numbers already assume 4 points, so the engine
scales them by curve(points) / curve(4).

Binding Harpoons has two curves: one for a single target, one per target when
it pulls several. Brine-Powered Harpoons is the "Railgun" asset.

Usage: python scripts/extract/harpoon_combo.py <dump_kismet out dir>
       (needs Blueprints/Weapons/HarpoonGun dumped)
"""
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from wiki import DATA, write_json  # noqa: E402

# mode name -> {target scenario: curve asset}
CURVES = {
    'Barbed Harpoons': {'single': 'C_BarbedHarpoons_DamageMultiPerComboPoint_Curve'},
    'Binding Harpoons': {'single': 'C_BindingHarpoons_SingleTargetDamageMultiPerComboPoint_Curve',
                         'multi': 'C_BindingHarpoons_MultiTargetDamageMultiPerComboPoint_Curve'},
    'Brine-Powered Harpoons': {'single': 'C_RailgunHarpoons_DamageMultiPerComboPoint_Curve'},
}


def curve(dump, name):
    hits = glob.glob(os.path.join(dump, '**', name + '.uasset.json'), recursive=True)
    if len(hits) != 1:
        sys.exit(f'expected one {name} in the dump, found {len(hits)}')
    for e in json.load(open(hits[0], encoding='utf-8')):
        fc = (e.get('Properties') or {}).get('FloatCurve') or e.get('FloatCurve')
        if fc:
            keys = sorted(fc['Keys'], key=lambda k: k['Time'])
            if [k['Time'] for k in keys] != list(range(len(keys))):
                sys.exit(f'{name}: expected one key per whole Combo Point')
            return [round(k['Value'], 4) for k in keys]
    sys.exit(f'{name}: no FloatCurve')


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    dump = sys.argv[1]
    hits = glob.glob(os.path.join(dump, '**', 'BP_HarpoonGun_Script.uasset.json'), recursive=True)
    max_points = next(e['Properties']['MaxComboPoints']['Value'] for e in json.load(open(hits[0], encoding='utf-8'))
                      if e.get('Name', '').startswith('Default__'))
    path = os.path.join(DATA, 'weapons.json')
    doc = json.load(open(path, encoding='utf-8'))
    harpoon = next(w for w in doc['weapons'] if w['id'] == 'Harpoon_Gun')
    harpoon['maxComboPoints'] = max_points
    for mode in harpoon['modes']:
        mode.pop('comboCurve', None)
        if mode['name'] in CURVES:
            mode['comboCurve'] = {k: curve(dump, v) for k, v in CURVES[mode['name']].items()}
    write_json(path, doc)


if __name__ == '__main__':
    main()
