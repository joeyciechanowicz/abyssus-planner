"""Weapon portraits, ability icons (and a charm/forge icon audit) from the game files.

Input is the output dir of the `dump_icons` CUE4Parse tool (see scripts/README.md,
"Weapon portraits & ability icons (from the game files)"):

    <dump>/assets/PrimaryAssets/**.json   every primary data asset, properties resolved
    <dump>/textures/Art/UI/**.png         every UI Texture2D under the dumped dirs

Matching never guesses from texture filenames. Every RPrimaryDataAsset carries an
`AssetName` FText (the in-game display name) and an `AssetIcon` Texture2D reference;
mutators and weapons additionally carry a `SmallIcon`. An entry in data/*.json is
matched to the single asset whose normalised `AssetName` equals its own `name`, and
the texture copied is the one that asset's `AssetIcon` points at:

    weapons    RWeaponPrimaryAsset                      -> public/weapon_portraits/<id>
    abilities  RCharacterMutatorPrimaryAsset with
               MutatorType == Mutator.ActivatableAbility -> public/abilities/<id>
    charms     MutatorType == Mutator.Charm             -> public/charms/<id>, but ONLY
               if the charm's icon texture is its own. In the current build every charm
               points at one of three shared rarity textures (T_UI_Icon_Charm_Default_0N),
               so nothing is written and the existing rarity badges stay.

`AssetIcon` is the full-colour rendered art the game shows in its loadout screens;
`SmallIcon` is a flat white silhouette mask (tinted at runtime), so it is not used.

Forge upgrades are only audited (printed), never written: the game gives every
upgrade of one weapon/ability the same `AssetIcon` (one "category" texture per
weapon), so there is no per-upgrade art to recover.

Each icon is written as a .png (deleting any stale .webp of the same name, which
optimize_images.py would otherwise keep in preference to the new art) but the JSON
records the final .webp path -- run scripts/optimize_images.py afterwards to convert.
The JSON is edited textually (one "icon" line inserted/replaced per entry) because
abilities.json and charms.json contain hand-compacted effect objects that a
json.dump round-trip would reflow.

Run:  python scripts/extract/game_icons.py <dump dir> [--sheet out.png]
"""
import glob
import json
import os
import re
import shutil
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wiki import DATA, PUBLIC

ENTRY_INDENT = " " * 6   # top-level entries of weapons[] / abilities[] / charms[]


def norm(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def tex_ref(v):
    """{'ObjectPath': 'RGame/Content/Art/UI/X/T_Foo.0'} -> 'Art/UI/X/T_Foo'."""
    if not isinstance(v, dict) or "ObjectPath" not in v:
        return None
    path = v["ObjectPath"].rsplit(".", 1)[0]
    return path[len("RGame/Content/"):] if path.startswith("RGame/Content/") else path


def short(tex):
    return tex.rsplit("/", 1)[-1] if tex else "-"


def load_assets(dump):
    out = []
    root = os.path.join(dump, "assets")
    for f in glob.glob(os.path.join(root, "**", "*.json"), recursive=True):
        for exp in json.load(open(f, encoding="utf-8")):
            p = exp.get("Properties") or {}
            name = p.get("AssetName")
            if not isinstance(name, dict) or not name.get("LocalizedString"):
                continue
            out.append({
                "file": os.path.relpath(f, root).replace(os.sep, "/"),
                "type": exp.get("Type"),
                "name": name["LocalizedString"],
                "tag": (p.get("MutatorType") or {}).get("TagName", ""),
                "assetIcon": tex_ref(p.get("AssetIcon")),
                "smallIcon": tex_ref(p.get("SmallIcon")),
            })
    if not out:
        raise SystemExit(f"no named assets under {root} -- is this a dump_icons output dir?")
    return out


def index(assets, pred):
    by = defaultdict(list)
    for a in assets:
        if pred(a):
            by[norm(a["name"])].append(a)
    return by


def tex_png(dump, tex):
    return os.path.join(dump, "textures", tex + ".png")


def copy_icon(dump, tex, folder, ident):
    """Copy a decoded texture to public/<folder>/<ident>.png and return the .webp
    path to record in the JSON (optimize_images.py converts it), or None."""
    src = tex_png(dump, tex)
    if not os.path.exists(src):
        return None
    dst = os.path.join(PUBLIC, folder, ident + ".png")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    stale = os.path.splitext(dst)[0] + ".webp"
    if os.path.exists(stale):
        os.remove(stale)
    shutil.copyfile(src, dst)
    return f"{folder}/{ident}.webp"


def set_icon(text, name, icon):
    """Set the "icon" of the top-level entry whose "name" is `name`, editing the JSON
    text: replace that entry's existing icon line, else insert one after its name."""
    ind = ENTRY_INDENT
    name_line = f'{ind}"name": {json.dumps(name, ensure_ascii=False)},\n'
    pos = text.find(name_line)
    if pos < 0 or text.find(name_line, pos + 1) >= 0:
        raise SystemExit(f"expected exactly one top-level entry named {name!r}")
    start = pos + len(name_line)
    end_m = re.compile("^" + ind[:-2] + r"\}", re.M).search(text, start)
    end = end_m.start() if end_m else len(text)
    icon_m = re.compile("^" + ind + r'"icon": [^\n]*\n', re.M).search(text, start, end)
    line = f'{ind}"icon": {json.dumps(icon)},\n'
    if icon_m:
        if not icon_m.group(0).rstrip().endswith(","):
            line = line.replace(",\n", "\n")
        return text[:icon_m.start()] + line + text[icon_m.end():]
    return text[:start] + line + text[start:]


def write_text(path, text):
    json.loads(text)  # must still be valid JSON
    crlf = b"\r\n" in open(path, "rb").read()  # keep the file's line endings
    with open(path, "w", encoding="utf-8", newline="\r\n" if crlf else "\n") as f:
        f.write(text)


def match_list(path, key, idx, kind, dump, folder, sheet):
    text = open(path, encoding="utf-8").read()
    entries = json.loads(text)[key]
    matched, unmatched = 0, []
    for e in entries:
        hits = idx.get(norm(e["name"]), [])
        if len(hits) != 1 or not hits[0]["assetIcon"]:
            unmatched.append(f"{e['name']} ({len(hits)} candidate assets)")
            continue
        tex = hits[0]["assetIcon"]
        icon = copy_icon(dump, tex, folder, e["id"])
        if not icon:
            unmatched.append(f"{e['name']} (texture {tex} not in dump)")
            continue
        text = set_icon(text, e["name"], icon)
        sheet.append((tex_png(dump, tex), f"{kind}: {e['name']}", short(tex)))
        matched += 1
    write_text(path, text)
    print(f"{kind}: matched {matched}/{len(entries)}")
    for u in unmatched:
        print("   unmatched:", u)


def charms(dump, assets, sheet):
    path = os.path.join(DATA, "charms.json")
    text = open(path, encoding="utf-8").read()
    entries = json.loads(text)["charms"]
    idx = index(assets, lambda a: a["tag"] == "Mutator.Charm")
    users = defaultdict(int)
    for hits in idx.values():
        for a in hits:
            users[a["assetIcon"]] += 1

    written, shared, unmatched = 0, defaultdict(list), []
    for c in entries:
        hits = idx.get(norm(c["name"]), [])
        if len(hits) != 1:
            unmatched.append(f"{c['name']} ({len(hits)} candidate assets)")
            continue
        tex = hits[0]["assetIcon"]
        if users[tex] > 1:
            # A rarity texture shared with other charms, not this charm's own art.
            shared[tex].append((c["name"], c["rarity"]))
            continue
        icon = copy_icon(dump, tex, "charms", c["id"])
        if icon:
            text = set_icon(text, c["name"], icon)
            sheet.append((tex_png(dump, tex), f"charm: {c['name']}", short(tex)))
            written += 1

    print(f"charms: {written}/{len(entries)} have their own icon in the game files")
    for tex, names in sorted(shared.items()):
        by_rarity = defaultdict(list)
        for n, r in names:
            by_rarity[r].append(n)
        major = max(by_rarity, key=lambda r: len(by_rarity[r]))
        print(f"   {len(names)} charms share {short(tex)} (the {major} rarity texture)")
        for r, ns in sorted(by_rarity.items()):
            if r != major:
                print(f"      rarity mismatch: data says {r} for {', '.join(ns)}")
        sheet.append((tex_png(dump, tex), f"shared by {len(names)} charms", short(tex)))
    for u in unmatched:
        print("   unmatched:", u)
    if written:
        write_text(path, text)


def forge_audit(assets):
    groups = defaultdict(set)
    for a in assets:
        if a["tag"] in ("Mutator.Upgrade.Weapon", "Mutator.Upgrade.Ability"):
            groups[a["file"].rsplit("/", 2)[-2]].add(short(a["assetIcon"]))
    print("forge upgrades: distinct AssetIcon textures per asset folder")
    for folder, icons in sorted(groups.items()):
        print(f"   {folder:22s} {len(icons)}: {', '.join(sorted(icons))}")


def contact_sheet(items, out):
    from PIL import Image, ImageDraw
    cols, cell = 6, 200
    rows = (len(items) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell, rows * (cell + 34)), (48, 48, 56))
    d = ImageDraw.Draw(sheet)
    for i, (path, label, tex) in enumerate(items):
        im = Image.open(path).convert("RGBA")
        im.thumbnail((cell - 12, cell - 12))
        x, y = (i % cols) * cell, (i // cols) * (cell + 34)
        sheet.paste(im, (x + 6, y + 6), im)
        d.text((x + 4, y + cell - 4), label[:32], fill="white")
        d.text((x + 4, y + cell + 10), tex[:34], fill=(255, 220, 90))
    sheet.save(out)
    print("contact sheet:", out)


def main():
    args = sys.argv[1:]
    sheet_out = None
    if "--sheet" in args:
        i = args.index("--sheet")
        sheet_out = args[i + 1]
        del args[i:i + 2]
    if len(args) != 1:
        raise SystemExit(__doc__)
    dump = args[0]
    assets = load_assets(dump)
    sheet = []

    match_list(os.path.join(DATA, "weapons.json"), "weapons",
               index(assets, lambda a: a["type"] == "RWeaponPrimaryAsset"),
               "weapons", dump, "weapon_portraits", sheet)
    match_list(os.path.join(DATA, "abilities.json"), "abilities",
               index(assets, lambda a: a["tag"] == "Mutator.ActivatableAbility"),
               "abilities", dump, "abilities", sheet)
    charms(dump, assets, sheet)
    forge_audit(assets)

    if sheet_out:
        contact_sheet(sheet, sheet_out)


if __name__ == "__main__":
    main()
