"""Convert the icon set under public/ to WebP and repoint data/*.json at it.

The icons are only 256x256, but they were saved as straight RGB/RGBA PNGs of
cropped card art. That art is full of fine background noise and gradients, which
PNG cannot compress -- re-running PNG optimisation saves nothing (measured: 74KB
-> 74KB). WebP handles it in about a tenth of the space.

Also caps any icon larger than 256px (the Soul Wheel set comes off the wiki at
512x512), since nothing displays them above that.

Idempotent: run it after any extraction script. Already-converted icons are left
alone, and icon paths in data/*.json are rewritten from .png to .webp.

Run:  python scripts/optimize_images.py
"""
import json
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "extract"))
from wiki import DATA, PUBLIC, write_json

MAX_EDGE = 256
QUALITY = 90          # visually indistinguishable at icon sizes; q95 costs ~60% more
METHOD = 6            # slowest/best encoder effort

DATA_FILES = [
    "blessings.json",
    "charms.json",
    "weapons.json",
    "abilities.json",
    "soul_wheel.json",
    "status_effects.json",
    "ancient_forge.json",
]


def convert_all():
    before = after = 0
    converted = skipped = 0

    for root, _dirs, files in os.walk(PUBLIC):
        for name in sorted(files):
            if not name.lower().endswith(".png"):
                continue
            src = os.path.join(root, name)
            dst = os.path.splitext(src)[0] + ".webp"

            size = os.path.getsize(src)
            before += size

            if os.path.exists(dst):
                after += os.path.getsize(dst)
                os.remove(src)
                skipped += 1
                continue

            im = Image.open(src)
            # Keep alpha where it exists; palette images carry it in 'transparency'.
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGBA" if "transparency" in im.info else "RGB")
            if max(im.size) > MAX_EDGE:
                im.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)

            im.save(dst, format="WEBP", quality=QUALITY, method=METHOD)
            after += os.path.getsize(dst)
            os.remove(src)
            converted += 1

    return before, after, converted, skipped


def repoint(obj):
    """Rewrite every 'icon' string ending in .png to .webp, in place."""
    changed = 0
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key == "icon" and isinstance(value, str) and value.endswith(".png"):
                obj[key] = value[:-4] + ".webp"
                changed += 1
            else:
                changed += repoint(value)
    elif isinstance(obj, list):
        for item in obj:
            changed += repoint(item)
    return changed


def main():
    before, after, converted, skipped = convert_all()
    print(f"converted {converted} icons ({skipped} already webp)")
    if before:
        print(f"  {before / 1048576:.2f} MB -> {after / 1048576:.2f} MB "
              f"({100 * (1 - after / before):.0f}% smaller)")

    total = 0
    for name in DATA_FILES:
        path = os.path.join(DATA, name)
        doc = json.load(open(path, encoding="utf-8"))
        n = repoint(doc)
        if n:
            write_json(path, doc)
            total += n
    print(f"repointed {total} icon paths to .webp")

    # Every icon path must resolve, or the UI silently renders a broken image.
    missing = []
    for name in DATA_FILES:
        doc = json.load(open(os.path.join(DATA, name), encoding="utf-8"))
        missing.extend(check(doc))
    if missing:
        print(f"\n!! {len(missing)} icon paths point at files that do not exist:")
        for m in sorted(set(missing))[:20]:
            print("   ", m)
        raise SystemExit(1)
    print("all icon paths resolve")


def check(obj):
    out = []
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key == "icon" and isinstance(value, str):
                if not os.path.exists(os.path.join(PUBLIC, value)):
                    out.append(value)
            else:
                out.extend(check(value))
    elif isinstance(obj, list):
        for item in obj:
            out.extend(check(item))
    return out


if __name__ == "__main__":
    main()
