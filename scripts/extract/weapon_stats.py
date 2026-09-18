"""Enrich data/weapons.json with parsed damage and hand-authored rate-of-fire stats.

Two jobs:

1. Parse the wiki's free-text Damage / Weakspot Damage strings into structured
   components. The strings take several shapes:
       "32"                          single hit
       "40 x3"                       3 projectiles per shot
       "50 x8 (400)"                 8 pellets, wiki's own total in parens
       "70 - 440"                    charge range (min - max)
       "19>32>40"                    discrete charge steps
       "100 (Hit) / 25 x6 (DoT)"     labelled components
   A few Harpoon Gun / Tesla modes are too irregular to parse safely and are
   hand-authored in MANUAL below rather than guessed at.

2. Attach fireRate / clipSize / reloadTime. THE WIKI PUBLISHES NONE OF THESE --
   its Statistics tables carry damage only. Every value here is an estimate read
   off the mode's own description, flagged "estimated": true in the output so it
   can be replaced with measured values later without touching engine code.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wiki import DATA, write_json

# (fireRate shots/sec, clipSize, reloadTime sec). clipSize None = no ammo cost
# (melee / heat-gated). fireRate counts trigger pulls, not projectiles.
RATES = {
    "Engine_Rifle": {
        "Automatic Fire": (10.0, 100, 2.2),
        "Burst Fire": (2.6, 99, 2.2),
        "Gatling Fire": (12.0, 100, 2.2),
        "Engine Rev": (13.0, 120, 2.5),      # heat-gated, clip = heat budget
        "Split Shot": (6.0, 60, 2.5),
        "Concentrated Shot": (2.2, 30, 2.5),
    },
    "Shotgun": {
        "Semi-automatic": (1.6, 6, 2.6),
        "Full-automatic": (3.0, 12, 3.0),    # description: magazine 6 -> 12
        "Superheavy Slug": (1.2, 6, 2.6),
        "Buckshot": (0.8, 2, 2.6),
        "Unload": (4.0, 6, 2.6),
        "Pressure Shot": (0.9, 2, 2.6),
    },
    "Tesla_Gun": {
        "Electrical Beam": (12.0, 150, 2.0),  # continuous beam, rate = damage ticks
        "Charge Beam": (12.0, 150, 2.0),
        "Unstable Coil": (6.0, 120, 2.0),
        "Spark Orb": (0.8, 30, 2.2),
        "Charge Orb": (0.6, 30, 2.2),
        "Magnetic Storm": (0.7, 30, 2.2),
    },
    "Brine_Revolver": {
        "Semi-automatic": (3.5, 8, 1.8),
        "Burst Fire": (1.8, 9, 1.8),
        "Large Caliber": (1.6, 5, 2.0),
        "Steady Scope": (1.0, 5, 2.0),
        "Quick Scope": (1.4, 5, 2.0),
        "Charge Scope": (0.7, 5, 2.0),
    },
    "Disc_Thrower": {
        "Automatic": (4.0, 20, 2.0),
        "Fan Fire": (2.0, 21, 2.0),
        "Dynamo": (3.0, 20, 2.0),
        "Inferno Discs": (2.0, 12, 2.2),
        "Electron Conductors": (2.0, 12, 2.2),
        "Search and Destroy": (2.5, 12, 2.2),
    },
    "Combat_Bow": {
        "Precision Shot": (1.1, 20, 1.5),     # rate is draw time, not trigger speed
        "Pierce": (1.0, 20, 1.5),
        "Return Arrow": (1.3, 20, 1.5),
        "Multi-Shot": (0.9, 20, 1.5),
        "Smart Arrow": (1.1, 20, 1.5),
        "Exploding Arrow": (0.9, 20, 1.5),
    },
    "Plasma_Launcher": {
        "Semi-automatic": (1.3, 6, 2.8),
        "Flak Cannon": (2.5, 10, 2.8),
        "Seekers": (0.5, 10, 2.8),
        "Disintegration Beam": (0.8, 4, 3.0),
        "Void Infusion": (1.0, 5, 3.0),
        "Adhesive Compound": (1.2, 6, 3.0),
    },
    "Fish_Deity": {
        "Rapid Goo": (1.5, 9, 2.4),
        "Fish Spit": (1.2, 7, 2.4),           # description: magazine 9 -> 7
        "Hazardous Goo": (1.4, 9, 2.4),
        "Piercing Stab": (1.3, None, 0.0),    # melee, no ammo
        "Wide Stab": (1.0, None, 0.0),
        "Chainsaw": (4.0, None, 0.0),
    },
    "Harpoon_Gun": {
        "Piercing Harpoons": (1.2, 8, 2.2),
        "Ricocheting Harpoons": (1.2, 8, 2.2),
        "Pinning Harpoons": (1.2, 8, 2.2),
        "Barbed Harpoons": (0.5, 4, 2.2),     # gated by Combo Points, not ammo
        "Binding Harpoons": (0.5, 4, 2.2),
        "Brine-Powered Harpoons": (0.5, 4, 2.2),
    },
}

# Modes whose damage string the parser cannot safely decompose. Components are
# {label, kind, min, max, count}; kind is impact | dot | explosion | pull | aoe.
MANUAL = {
    ("Tesla_Gun", "Charge Orb"): {
        "damage": [
            {"label": "Explosion", "kind": "explosion", "min": 97, "max": 165, "count": 1},
            {"label": "DoT", "kind": "dot", "min": 20, "max": 32, "count": 10},
        ],
        "weakspotDamage": [
            {"label": "Explosion", "kind": "explosion", "min": 97, "max": 165, "count": 1},
            {"label": "DoT", "kind": "dot", "min": 20, "max": 32, "count": 10},
        ],
        "chargeSteps": 4,
    },
    ("Harpoon_Gun", "Binding Harpoons"): {
        "damage": [
            {"label": "Hit", "kind": "impact", "min": 100, "max": 100, "count": 1},
            {"label": "Pull (single target)", "kind": "pull", "min": 1000, "max": 1000, "count": 1},
        ],
        "weakspotDamage": [
            {"label": "Hit", "kind": "impact", "min": 200, "max": 200, "count": 1},
            {"label": "Pull (single target)", "kind": "pull", "min": 2000, "max": 2000, "count": 1},
        ],
        "comboCost": 4,
        "variantNote": "Against multiple targets the pull deals 450 instead "
                       "(200/450 on weakspot hits).",
    },
    ("Harpoon_Gun", "Brine-Powered Harpoons"): {
        "damage": [
            {"label": "Hit", "kind": "impact", "min": 1200, "max": 1200, "count": 1},
            {"label": "AoE", "kind": "aoe", "min": 1200, "max": 1200, "count": 1},
        ],
        "weakspotDamage": [
            {"label": "Hit", "kind": "impact", "min": 2400, "max": 2400, "count": 1},
            {"label": "AoE", "kind": "aoe", "min": 1200, "max": 1200, "count": 1},
        ],
        "comboCost": 4,
    },
    ("Harpoon_Gun", "Barbed Harpoons"): {
        "damage": [
            {"label": "Hit", "kind": "impact", "min": 50, "max": 50, "count": 1},
            {"label": "DoT", "kind": "dot", "min": 600, "max": 600, "count": 3},
        ],
        "weakspotDamage": [
            {"label": "Hit", "kind": "impact", "min": 100, "max": 100, "count": 1},
            {"label": "DoT", "kind": "dot", "min": 600, "max": 600, "count": 3},
        ],
        "comboCost": 4,
    },
}

KIND_OF = {"dot": "dot", "explosion": "explosion", "pull": "pull", "aoe": "aoe"}
NUM = r"\d+(?:\.\d+)?"


def parse_component(text):
    """'25 x6 (DoT)' -> {label, kind, min, max, count}, or None."""
    text = text.strip()
    if not text or text.upper() == "N/A":
        return None

    label, kind = None, "impact"
    for group in re.findall(r"\(([^)]*)\)", text):
        g = group.strip()
        if re.fullmatch(NUM, g):
            continue                      # the wiki's own precomputed total
        label = g
        key = re.sub(r"[^a-z]", "", g.lower())
        kind = KIND_OF.get(key, "impact")
    text = re.sub(r"\([^)]*\)", " ", text)

    count = 1
    m = re.search(r"x\s*(\d+)", text)
    if m:
        count = int(m.group(1))
        text = text[:m.start()] + text[m.end():]

    nums = [float(n) for n in re.findall(NUM, text)]
    if not nums:
        return None
    sep = re.sub(r"[\d.\s]", "", text)
    if not set(sep) <= {"-", ">", ""}:
        return None                       # unrecognised punctuation: don't guess

    lo, hi = min(nums), max(nums)
    out = {"label": label, "kind": kind,
           "min": int(lo) if lo.is_integer() else lo,
           "max": int(hi) if hi.is_integer() else hi,
           "count": count}
    if ">" in sep:
        out["chargeSteps"] = len(nums)
    return out


def parse_damage(s):
    if not s or s.strip().upper() == "N/A":
        return None
    parts = [p for p in re.split(r"\s/\s", s) if p.strip()]
    comps = []
    for p in parts:
        # "100 (Hit) + 1000 (Pull)" -- additive components within one variant
        for sub in re.split(r"\s\+\s", p):
            c = parse_component(sub)
            if c is None:
                return None
            comps.append(c)
    return comps or None


def main():
    path = os.path.join(DATA, "weapons.json")
    doc = json.load(open(path, encoding="utf-8"))

    unparsed, total = [], 0
    for weapon in doc["weapons"]:
        wid = weapon["id"]
        for mode in weapon["modes"]:
            total += 1
            key = (wid, mode["name"])
            manual = MANUAL.get(key)

            if manual:
                mode["damageComponents"] = manual["damage"]
                mode["weakspotComponents"] = manual["weakspotDamage"]
                for extra in ("comboCost", "chargeSteps", "variantNote"):
                    if extra in manual:
                        mode[extra] = manual[extra]
                mode["damageParsed"] = "manual"
            else:
                d = parse_damage(mode["damage"])
                w = parse_damage(mode["weakspotDamage"])
                mode["damageComponents"] = d
                mode["weakspotComponents"] = w
                mode["damageParsed"] = "auto" if d else "unparsed"
                if not d:
                    unparsed.append(f"{wid} / {mode['name']}: {mode['damage']!r}")
                if d and any("chargeSteps" in c for c in d):
                    mode["chargeSteps"] = max(c.get("chargeSteps", 1) for c in d)

            rate, clip, reload_ = RATES[wid][mode["name"]]
            mode["fireRate"] = rate
            mode["clipSize"] = clip
            mode["reloadTime"] = reload_
            mode["projectilesPerShot"] = max(
                (c["count"] for c in (mode["damageComponents"] or [])
                 if c["kind"] == "impact"), default=1)
            mode["estimated"] = True

    doc["rateNote"] = ("fireRate (shots/sec), clipSize and reloadTime are NOT published "
                       "by the wiki -- they are estimates, flagged per mode with "
                       "\"estimated\": true. Damage values are from the wiki.")
    write_json(path, doc)

    print(f"{total} modes; {len(unparsed)} unparsed")
    for u in unparsed:
        print("  !!", u)


if __name__ == "__main__":
    main()
