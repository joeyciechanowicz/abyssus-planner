"""Add the Engine Rifle's heat system to data/weapons.json.

From BP_EngineRifle_Script's class defaults and graph:
  - each shot of a heat mode adds HeatCostPerShot (IncreaseHeat); Concentrated
    Shot adds its ExtraOverheatPerShot on top (BP_EngineRifle_ConcentratedShot_ModScript);
  - heat cools by HeatReductionPerTick every TickScriptInterval, but only while
    you are NOT holding a heat mode's trigger (IsHoldingOverheatingModFire);
  - reaching MaxHeat overheats the gun for OverheatDuration (a timer to
    RemoveOverheat), blocking the heat modes.
The heat modes are the Secondaries ("increases Heat"); they use no ammo
(BaseAmmoCost 0), so their clip/reload numbers do not apply.

Usage: python scripts/extract/engine_rifle_heat.py <dump_kismet out dir>
       (needs Blueprints/Weapons/EngineRifle dumped)
"""
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from wiki import DATA, write_json  # noqa: E402

HEAT_MODES = {'Engine Rev': None, 'Split Shot': None, 'Concentrated Shot': 'BP_EngineRifle_ConcentratedShot_ModScript'}


def cdo(dump, name):
    hits = glob.glob(os.path.join(dump, '**', name + '.uasset.json'), recursive=True)
    if len(hits) != 1:
        sys.exit(f'expected one {name} in the dump, found {len(hits)}')
    for e in json.load(open(hits[0], encoding='utf-8')):
        if e.get('Name', '').startswith('Default__'):
            return e.get('Properties') or {}
    sys.exit(f'{name}: no class default object')


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    dump = sys.argv[1]
    s = cdo(dump, 'BP_EngineRifle_Script')
    path = os.path.join(DATA, 'weapons.json')
    doc = json.load(open(path, encoding='utf-8'))
    rifle = next(w for w in doc['weapons'] if w['id'] == 'Engine_Rifle')
    rifle['heat'] = {
        'max': s['MaxHeat']['Value'],
        'coolPerSecond': s['HeatReductionPerTick'] / s['TickScriptInterval'],
        'overheatDuration': s['OverheatDuration'],
    }
    for mode in rifle['modes']:
        mode.pop('heatPerShot', None)
        if mode['name'] in HEAT_MODES:
            extra = HEAT_MODES[mode['name']]
            mode['heatPerShot'] = s['HeatCostPerShot'] + (cdo(dump, extra)['ExtraOverheatPerShot'] if extra else 0)
    write_json(path, doc)
    print(rifle['heat'], {m['name']: m.get('heatPerShot') for m in rifle['modes']})


if __name__ == '__main__':
    main()
