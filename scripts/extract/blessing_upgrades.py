"""Merge per-rank blessing upgrade values into data/blessings.json.

Source data comes from scripts/extract/dump_mutators (a CUE4Parse-based C# tool that
reads RCharacterMutatorPrimaryAsset instances straight out of the game's .pak, resolving
Unreal's unversioned properties via a Dumper-7-generated .usmap). See
scripts/extract/README.md for how to (re)produce that mappings file and run the dumper.

Usage:
    python scripts/extract/blessing_upgrades.py <dumped_json_dir>

<dumped_json_dir> is the outDir passed to dump_mutators, e.g. the folder containing
PrimaryAssets/CharacterMutators/**/*.uasset.json.
"""
import json
import os
import sys
import glob


def norm(s: str | None) -> str:
    return ''.join(c for c in (s or '').lower() if c.isalnum())


def load_mutators(dump_dir: str) -> list[dict]:
    files = glob.glob(os.path.join(dump_dir, 'PrimaryAssets', '**', '*.uasset.json'), recursive=True)
    entries = []
    for f in files:
        try:
            data = json.load(open(f, encoding='utf-8'))
        except Exception:
            continue
        for obj in data:
            props = obj.get('Properties', {})
            variables = props.get('MutatorDescriptionVariables', [])
            if not variables:
                continue
            name = (props.get('AssetName') or {}).get('LocalizedString')
            entries.append({
                'assetId': obj.get('Name'),
                'name': name,
                'variables': [
                    {
                        'variable': v.get('VariableName'),
                        'label': (v.get('VariableDisplayName') or {}).get('LocalizedString'),
                        'isPercent': bool(v.get('bIsPercentValue')),
                        'ranks': v.get('RankValues', []),
                    }
                    for v in variables
                    # Only keep variables that actually vary by rank; a single-entry
                    # array means the blessing isn't upgradable on that variable.
                    if len(v.get('RankValues', [])) > 1
                ],
            })
    return [e for e in entries if e['variables']]


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    dump_dir = sys.argv[1]

    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
    blessings_path = os.path.join(repo_root, 'data', 'blessings.json')
    blessings_data = json.load(open(blessings_path, encoding='utf-8'))

    mutators = load_mutators(dump_dir)
    by_name: dict[str, list[dict]] = {}
    for m in mutators:
        by_name.setdefault(norm(m['name']), []).append(m)

    matched = 0
    unmatched = []
    for b in blessings_data['blessings']:
        b.pop('upgrades', None)
        candidates = by_name.get(norm(b['name'])) or by_name.get(norm(b['id'].split('_')[-1]))
        if not candidates:
            unmatched.append(b['id'])
            continue
        b['upgrades'] = candidates[0]['variables']
        matched += 1

    json.dump(blessings_data, open(blessings_path, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    open(blessings_path, 'a', encoding='utf-8').write('\n')

    print(f"Matched {matched}/{len(blessings_data['blessings'])} blessings with upgrade data.")
    print(f"No upgrade data found for {len(unmatched)} blessings (likely non-upgradable capstones):")
    for i in unmatched:
        print(f"  {i}")


if __name__ == '__main__':
    main()
