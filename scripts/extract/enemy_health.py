"""Write data/enemies.json: every enemy's base max Health and tier, from the game files.

Health lives in two places:
  - standard enemies and elites: the Blueprint CDO's `OverriddenAISettings.Health`
    (`InitializedAISettings` is the pre-override default, not what spawns);
  - bosses: their `RHealthComponent` subobject's `MaxHealth`.
Elites are flagged `bIsElite` on their CDO; bosses are the ones with a
component MaxHealth. DT_EnemyInfo lists which classes are real enemies, and
DT_EnemyDifficultyScaling says standard enemies gain LevelHealthIncreasePercentage
per level (bosses don't scale) -- recorded here, applied by nothing yet.

Usage: python scripts/extract/enemy_health.py <dump_kismet out dir>
       dump first: dump_kismet ... dump "Content/Data/(DT_EnemyInfo|DifficultyScalingTables/)" <out>
                   dump_kismet ... dump "Blueprints/AI/.*/BP_[^/]+\\.uasset$" <out>
"""
import glob
import json
import os
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from wiki import DATA, write_json  # noqa: E402


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    root = sys.argv[1]
    info = json.load(open(os.path.join(root, 'Data', 'DT_EnemyInfo.uasset.json'), encoding='utf-8'))[0]['Rows']
    scaling = json.load(open(os.path.join(root, 'Data', 'DifficultyScalingTables',
                                          'DT_EnemyDifficultyScaling.uasset.json'), encoding='utf-8'))[0]['Rows']
    files = {os.path.basename(f)[:-len('.uasset.json')]: f
             for f in glob.glob(os.path.join(root, 'Blueprints', '**', '*.uasset.json'), recursive=True)}

    enemies = []
    for row_id, row in info.items():
        cls = os.path.basename(row['SoftEnemyClass']['AssetPathName'].split('.')[0])
        if cls not in files:
            sys.exit(f'{row_id}: {cls} not in the dump')
        health, tier = None, 'standard'
        for e in json.load(open(files[cls], encoding='utf-8')):
            p = e.get('Properties') or {}
            if e.get('Name', '').startswith('Default__'):
                if p.get('bIsElite'):
                    tier = 'elite'
                ai = p.get('OverriddenAISettings') or {}
                if isinstance(ai.get('Health'), (int, float)):
                    health = ai['Health']
            mh = p.get('MaxHealth')
            if isinstance(mh, dict):  # FRMutableFloat
                mh = mh.get('Value')
            if 'RHealthComponent' in (e.get('Type'), e.get('Name')) and isinstance(mh, (int, float)):
                health, tier = mh, 'boss'
        if health is None:
            sys.exit(f'{row_id}: no Health found on {cls}')
        enemies.append({'id': row_id, 'name': row['EnemyName']['SourceString'], 'tier': tier, 'health': health})

    def median(tier):
        return statistics.median(e['health'] for e in enemies if e['tier'] == tier)

    doc = {
        'source': 'game files: DT_EnemyInfo + enemy Blueprint CDOs (scripts/extract/enemy_health.py)',
        'levelHealthIncreasePercent': {
            'standard': scaling['Default_Enemy']['LevelHealthIncreasePercentage'],
            'boss': scaling['Default_Boss']['LevelHealthIncreasePercentage'],
        },
        # Representative target Health per tier: the median base Health.
        'typicalHealth': {t: median(t) for t in ('standard', 'elite', 'boss')},
        'enemies': sorted(enemies, key=lambda e: (e['tier'], e['health'])),
    }
    write_json(os.path.join(DATA, 'enemies.json'), doc)
    print(doc['typicalHealth'])


if __name__ == '__main__':
    main()
