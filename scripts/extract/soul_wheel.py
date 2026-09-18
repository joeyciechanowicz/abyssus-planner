"""Extract the Soul Wheel skill tree.

Plain wikitable, no OCR needed. Row dividers are header cells of the shape
  ! colspan="3" | '''Row 3 | Cost per point: 6'''
so we walk the table top-to-bottom and attach each data row to the last divider seen.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wiki import DATA, PUBLIC, clean, download, image_urls, slug, snake, wikitext, write_json

SOURCE = "https://abyssus.wiki.gg/wiki/Soul_Wheel"
DIVIDER = re.compile(r"Row\s*(\d+)\s*\|\s*Cost per point:\s*(\d+)")


def main():
    wt = wikitext("Soul Wheel")
    body = re.search(r'\{\|\s*class="wikitable sortable".*?\n\|\}', wt, re.S).group(0)

    rows, current, icons = [], None, {}
    for chunk in re.split(r"\n\|-", body):
        m = DIVIDER.search(chunk)
        if m:
            current = {"row": int(m.group(1)), "costPerPoint": int(m.group(2)), "skills": []}
            rows.append(current)
            continue
        cells = [c.strip() for c in re.split(r"\n\|(?!\})", chunk)[1:]]
        if len(cells) < 3 or current is None:
            continue
        img, name, effect = cells[0], clean(cells[1]), clean(cells[2])
        if not name:
            continue
        f = re.search(r"\[\[File:([^|\]]+)", img)
        icon = None
        if f:
            fname = f.group(1).strip().replace(" ", "_")
            icons["File:" + fname] = fname
            icon = "soulwheel/" + fname
        current["skills"].append({
            "id": snake(name),
            "name": name,
            "description": effect,
            "icon": icon,
            "effects": [],
        })

    total = sum(len(r["skills"]) for r in rows)
    print(f"{len(rows)} rows, {total} skills")
    for r in rows:
        print(f"  row {r['row']} (cost {r['costPerPoint']}): {len(r['skills'])} skills")

    write_json(os.path.join(DATA, "soul_wheel.json"),
               {"source": SOURCE,
                "note": "Row N requires a minimum number of points invested in lower rows. "
                        "Enhanced Weapons / Abyssal Stamina / Ability Abundance / Bountiful Bottles "
                        "have separate I and II entries that stack.",
                "rows": rows})

    urls = image_urls(icons.keys())
    for title, fname in icons.items():
        if title in urls:
            dest = os.path.join(PUBLIC, "soulwheel", fname)
            if not os.path.exists(dest):
                download(urls[title], dest)
    print(f"icons: {len(icons)} referenced, {len(urls)} resolved")


if __name__ == "__main__":
    main()
