"""Tag each aspect's three fixed blessings in data/blessings.json with a `role`.

Every aspect has three blessings you don't pick freely, named by their game assets:
  passive  PA_<Aspect>GodPassive_CharacterMutator  -- always active while the aspect is
           equipped ("Every Fortune Blessing increases Gold found by 5%");
  minor    PA_<Aspect>MinorBlessing_CharacterMutator -- always the 2nd blessing taken
           from that aspect (the aspect card doesn't count);
  major    PA_<Aspect>MajorBlessing_CharacterMutator -- always the 5th.
They are the last three entries of each aspect's logbook (index 17/18/19), though
for Brine the game names Brine Mitosis the Major and Bouncing Brine the Minor, the
reverse of their logbook order -- the asset name is what this script trusts.

Matched by the asset's display name (AssetName) against the blessing's name.

Usage: python scripts/extract/blessing_roles.py <dump_kismet out dir>
       (needs PrimaryAssets/CharacterMutators dumped)
"""
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from wiki import DATA, write_json  # noqa: E402

ROLES = (('GodPassive', 'passive'), ('MinorBlessing', 'minor'), ('MajorBlessing', 'major'))


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    found = {}
    for f in glob.glob(os.path.join(sys.argv[1], 'PrimaryAssets', '**', '*.uasset.json'), recursive=True):
        base = os.path.basename(f)
        role = next((r for key, r in ROLES if key in base), None)
        if not role:
            continue
        for e in json.load(open(f, encoding='utf-8')):
            name = ((e.get('Properties') or {}).get('AssetName') or {}).get('SourceString')
            if name:
                found[name] = role

    path = os.path.join(DATA, 'blessings.json')
    doc = json.load(open(path, encoding='utf-8'))
    per_aspect = {}
    for b in doc['blessings']:
        b.pop('role', None)
        if b['name'] in found:
            b['role'] = found[b['name']]
            per_aspect.setdefault(b['aspect'], []).append(b['role'])
    for aspect in {b['aspect'] for b in doc['blessings']}:
        if sorted(per_aspect.get(aspect, [])) != ['major', 'minor', 'passive']:
            sys.exit(f'{aspect}: expected one passive, minor and major, found {per_aspect.get(aspect)}')
    write_json(path, doc)


if __name__ == '__main__':
    main()
