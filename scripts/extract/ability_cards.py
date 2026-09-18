"""Download the 66 ability Forge Upgrade cards and tile their text bands into sheets.

The card text is baked into the artwork and no OCR binary is installed, so the text
is read visually off tiled sheets (8 cards per sheet => 9 reads instead of 66).

IMPORTANT: a shared icon does NOT mean shared text. Every card's text band must be
read individually even when two cards' icon art hashes identically -- skipping the
"duplicates" is what produced the KeyError: 'Greased Barrel' bug in the weapon pass.
Icon-art dedup is still applied, but only to decide which icon FILES to keep.
"""
import hashlib
import os
import re
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wiki import PUBLIC, download, image_urls, wikitext

SCRATCH = os.path.join(os.environ["TEMP"], "claude",
                       "C--Users-bodyl-git-abyssus-planner",
                       "2d84c0c6-040a-445e-8fae-734b5fc66f43", "scratchpad")
CARDS = os.path.join(SCRATCH, "ability_cards")
SHEETS = os.path.join(SCRATCH, "ability_sheets")

ABILITIES = ["Frag Grenade", "Anchor", "Smiting Spear", "Ancient Core", "Brine Field", "Turret"]

# Fractions of card height/width, matched to the weapon forge-upgrade pass.
ICON_BOX = (0.30, 0.10, 0.70, 0.32)
TEXT_BOX = (0.03, 0.33, 0.97, 0.88)
PER_SHEET = 8


def gallery(page):
    wt = wikitext(page)
    sec = re.search(r"== Forge Upgrades ==(.*?)(?=\n== )", wt, re.S).group(1)
    return [f.strip() for f in re.findall(r"File:([^\n|\]]+)", sec)]


def fetch_all():
    """-> list of (ability, filename, local path), downloading anything missing."""
    os.makedirs(CARDS, exist_ok=True)
    wanted = []
    for ab in ABILITIES:
        for fname in gallery(ab):
            wanted.append((ab, fname.replace(" ", "_"), "File:" + fname))
    urls = image_urls([t for _, _, t in wanted])
    out = []
    for ab, fname, title in wanted:
        dest = os.path.join(CARDS, fname)
        if not os.path.exists(dest):
            if title not in urls:
                print("!! unresolved:", title)
                continue
            download(urls[title], dest)
        out.append((ab, fname, dest))
    return out


def crop(im, box):
    w, h = im.size
    return im.crop((int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h)))


def build_sheets(cards):
    os.makedirs(SHEETS, exist_ok=True)
    tiles = []
    for ab, fname, path in cards:
        band = crop(Image.open(path).convert("RGB"), TEXT_BOX)
        band.thumbnail((760, 760))
        tiles.append((fname, band))

    sheets = []
    for i in range(0, len(tiles), PER_SHEET):
        group = tiles[i:i + PER_SHEET]
        w = max(t.width for _, t in group)
        h = sum(t.height for _, t in group)
        sheet = Image.new("RGB", (w, h), (0, 0, 0))
        y = 0
        for _, t in group:
            sheet.paste(t, (0, y))
            y += t.height
        p = os.path.join(SHEETS, "sheet_%02d.png" % (i // PER_SHEET))
        sheet.save(p)
        sheets.append((p, [n for n, _ in group]))
    return sheets


def icon_hashes(cards):
    groups = {}
    for ab, fname, path in cards:
        icon = crop(Image.open(path).convert("RGB"), ICON_BOX).resize((256, 256))
        h = hashlib.md5(icon.tobytes()).hexdigest()
        groups.setdefault(h, []).append((fname, icon))
    return groups


def main():
    cards = fetch_all()
    print(f"{len(cards)} cards downloaded")
    im = Image.open(cards[0][2])
    print("card size:", im.size)

    groups = icon_hashes(cards)
    print(f"{len(groups)} unique icon images across {len(cards)} cards")
    os.makedirs(os.path.join(PUBLIC, "forge"), exist_ok=True)
    icon_of = {}
    for members in groups.values():
        rep, icon = members[0]
        dest = os.path.join(PUBLIC, "forge", rep)
        if not os.path.exists(dest):
            icon.save(dest)
        for fname, _ in members:
            icon_of[fname] = "forge/" + rep

    import json
    with open(os.path.join(SCRATCH, "ability_icon_map.json"), "w") as f:
        json.dump(icon_of, f, indent=1)

    for path, names in build_sheets(cards):
        print(path, "->", ", ".join(names))


if __name__ == "__main__":
    main()
