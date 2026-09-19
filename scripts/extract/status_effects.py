"""Extract the Status effects tables.

Three tables under differently-nested headings:
  === Negative Status Effects ===            (enemy debuffs)   cols: Image Name Effect Sources
  ==== Positive ==== / ==== Negative ====    (player effects)  cols: Image Name Effect Stackable Sources

The player tables carry a Stackable column like "Yes [Max 10 stacks]" which the
engine needs as a real number, so it is parsed out into maxStacks.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wiki import DATA, PUBLIC, clean, download, image_urls, snake, wikitext, write_json

SOURCE = "https://abyssus.wiki.gg/wiki/Status_effects"
ICONS = {}


def parse_table(body, has_stackable):
    # Commented-out template rows span several |- boundaries, so the comments have
    # to go before the split or their placeholder rows survive as real entries.
    body = re.sub(r"<!--.*?-->", "", body, flags=re.S)
    out = []
    for chunk in re.split(r"\n\|-", body):
        cells = [c.strip() for c in re.split(r"\n\|(?!\})", chunk)[1:]]
        if len(cells) < (5 if has_stackable else 4):
            continue
        name = clean(cells[1])
        if not name:
            continue
        entry = {"id": snake(name), "name": name, "description": clean(cells[2])}
        if has_stackable:
            raw = clean(cells[3])
            entry["stackable"] = raw.lower().startswith("yes")
            m = re.search(r"Max\s*(\d+)", raw)
            entry["maxStacks"] = int(m.group(1)) if m else None
            entry["sources"] = clean(cells[4])
        else:
            entry["stackable"] = None
            entry["maxStacks"] = None
            entry["sources"] = clean(cells[3])
        f = re.search(r"\[\[File:([^|\]]+)", cells[0])
        if f:
            fname = f.group(1).strip().replace(" ", "_")
            ICONS["File:" + fname] = fname
            entry["icon"] = "status/" + fname
        else:
            entry["icon"] = None
        entry["effects"] = []
        out.append(entry)
    return out


def section(wt, heading):
    """Body of the first wikitable following a heading."""
    i = wt.index(heading)
    m = re.search(r'\{\|\s*class="wikitable.*?\n\|\}', wt[i:], re.S)
    return m.group(0)


def main():
    wt = wikitext("Status effects")
    enemy = parse_table(section(wt, "=== Negative Status Effects ==="), False)
    pos = parse_table(section(wt, "==== Positive ===="), True)
    try:
        neg = parse_table(section(wt, "==== Negative ===="), True)
    except ValueError:
        neg = []

    print(f"enemy {len(enemy)}, player positive {len(pos)}, player negative {len(neg)}")
    for e in enemy + pos + neg:
        print(" ", e["name"], "|", e["description"][:70])

    write_json(os.path.join(DATA, "status_effects.json"), {
        "source": SOURCE,
        "enemyDebuffs": enemy,
        "playerPositive": pos,
        "playerNegative": neg,
    })

    # Count files on disk, not resolved URLs -- see the note in soul_wheel.py.
    urls = image_urls(ICONS.keys())
    have = unresolved = 0
    for title, fname in ICONS.items():
        dest = os.path.join(PUBLIC, "status", fname)
        if not os.path.exists(dest) and os.path.exists(dest[:-4] + ".webp"):
            have += 1
            continue
        if title not in urls:
            print("  !! unresolved:", title)
            unresolved += 1
            continue
        if not os.path.exists(dest):
            download(urls[title], dest)
        have += 1
    print(f"icons: {len(ICONS)} referenced, {have} on disk, {unresolved} unresolved")


if __name__ == "__main__":
    main()
