"""Translate prose effect descriptions into the effect DSL (src/model/effects.ts).

Rules are ordered most-specific-first and matched against the whole description with
finditer, so a sentence like

    "Primary Fire deals 15% additional damage and has a 20% chance to cause Hemorrhage."

yields two effects. Each match claims its character span; a later, more generic rule
that overlaps an already-claimed span is skipped, which is what stops
"deals 15% additional damage" being counted twice by both the specific aspect rule
and the generic damage rule.

Anything no rule matches is left with "effects": [] and an "unmodeled" note, and is
counted in the coverage report. That number is the honest measure of how much of the
game the simulator actually knows about -- it is not supposed to reach 100%.

Run:  python scripts/codify.py
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "extract"))
from wiki import DATA, write_json

PCT = r"(\d+(?:\.\d+)?)"

# Statuses the DSL names explicitly. Anything else applyStatus sees is kept as a
# free string, which validate.ts reports but does not reject.
STATUSES = {
    "hemorrhage", "fire", "burn", "burning", "freeze", "frozen", "gold", "goldburst",
    "shadows", "tentacle", "tentacles", "spirit", "windburst", "wind", "brine",
    "barrier", "chain lightning", "lightning", "stunned", "stun", "slowed", "slow",
    "weak", "rooted", "root", "overload", "poisoned", "static", "flares",
}


# Phrases the "Every X Blessing increases <phrase> by N%" rule can land on.
STAT_WORDS = {
    "your max health": "maxHealth",
    "max health": "maxHealth",
    "status effectiveness": "statusEffectiveness",
    "gold found": "damage",
    "damage dealt to elites and bosses": "damage",
    "damage": "damage",
    "fire rate": "fireRate",
}


def norm_status(s):
    return re.sub(r"\s+", " ", s.strip().lower().rstrip(".,"))


def pct(m, i=1):
    return round(float(m.group(i)) / 100.0, 4)


def rules():
    """(regex, builder) pairs, most specific first."""
    R = []

    def rule(pattern, fn):
        R.append((re.compile(pattern, re.I), fn))

    # --- Aspect slot cards -------------------------------------------------
    # Aspect slot cards appear as both "Primary Fire deals ..." and "Your Primary
    # deals ..."; both must land on the scoped stat, not the generic one.
    rule(r"\b(?:Your )?(Primary|Secondary)(?: Fire)? deals " + PCT +
         r"% (?:additional|more) damage",
         lambda m: [{"op": "mult", "stat": "damage", "scope": m.group(1).lower(),
                     "value": pct(m, 2)}])
    rule(r"\bYour Ability deals " + PCT + r"% (?:additional|more) damage",
         lambda m: [{"op": "mult", "stat": "damage", "scope": "ability", "value": pct(m)}])

    # --- Status application ------------------------------------------------
    # Only fires for a recognised status name: "chance to trigger again" must not
    # become applyStatus(status="again").
    rule(r"\b(?:has (?:a )?)?" + PCT +
         r"% chance to (?:cause|apply|create|inflict)\s+(?:a |an |the )?([A-Za-z' ]{3,24}?)(?=\s+on hit|[.,]|$)",
         lambda m: ([{"op": "applyStatus", "status": norm_status(m.group(2)),
                      "chance": pct(m), "scope": "all"}]
                    if norm_status(m.group(2)) in STATUSES else []))
    rule(r"has (?:a )?" + PCT + r"% chance to trigger again",
         lambda m: [{"op": "trigger", "on": "hit", "chance": pct(m), "then": [],
                     "note": "triggers again"}])

    # "Windburst deals 10% more damage each time it triggers on the same enemy.
    #  Up to 5 times." -- stacking, not a flat multiplier.
    rule(r"deals? " + PCT + r"% more damage each time it triggers on the same enemy\."
         r"\s*Up to " + PCT + r" times",
         lambda m: [{"op": "stacking", "stat": "damage", "scope": "all",
                     "valuePer": pct(m), "per": "trigger",
                     "max": float(m.group(2))}])
    rule(r"deals? " + PCT + r"% more damage each time it triggers on the same enemy",
         lambda m: [{"op": "stacking", "stat": "damage", "scope": "all",
                     "valuePer": pct(m), "per": "trigger", "max": None}])

    # --- Global multipliers (Soul Wheel, charms) ---------------------------
    rule(r"Increases? (?:your )?weapon damage by " + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "damage", "scope": "all", "value": pct(m)}])
    rule(r"Increases? Area of Effect damage by " + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "aoeDamage", "scope": "all", "value": pct(m)}])
    rule(r"Damage over Time effects deal " + PCT + r"% more damage",
         lambda m: [{"op": "mult", "stat": "dotDamage", "scope": "dot", "value": pct(m)}])
    rule(r"Increases? (?:the )?Weakspot damage by " + PCT + r"%|Increases? Weakspot damage by " + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "weakspotDamage", "scope": "all",
                     "value": pct(m, 1 if m.group(1) else 2)}])
    rule(r"Weakspot damage is increased by " + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "weakspotDamage", "scope": "all", "value": pct(m)}])
    rule(r"(?:Increases?|increase) (?:weapon |your |Turret )?[Ff]ire ?[Rr]ate by (?:up to )?" + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "fireRate", "scope": "all", "value": pct(m)}])
    rule(r"[Ff]ire ?rate is increased by " + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "fireRate", "scope": "all", "value": pct(m)}])
    rule(r"Increases? reload speed by " + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "reloadSpeed", "scope": "all", "value": pct(m)}])
    rule(r"Increases the damage done by your equipped ability by " + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "abilityDamage", "scope": "ability", "value": pct(m)}])
    rule(r"Increases? Ability damage by " + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "abilityDamage", "scope": "ability", "value": pct(m)}])
    rule(r"Increases? max Health by " + PCT + r"(?!%)",
         lambda m: [{"op": "flat", "stat": "maxHealth", "scope": "all",
                     "value": float(m.group(1))}])
    rule(r"Increases? the number of charges of your equipped ability by " + PCT,
         lambda m: [{"op": "flat", "stat": "abilityCharges", "scope": "ability",
                     "value": float(m.group(1))}])
    rule(r"Gain " + PCT + r" Ability stacks",
         lambda m: [{"op": "flat", "stat": "abilityCharges", "scope": "ability",
                     "value": float(m.group(1))}])

    # --- Defensive ---------------------------------------------------------
    rule(r"Reduces damage taken by " + PCT + r"%|(?:Player |You )?takes? " + PCT + r"% less damage",
         lambda m: [{"op": "mult", "stat": "damageTaken", "scope": "all",
                     "value": -pct(m, 1 if m.group(1) else 2)}])

    # --- Crit / status effectiveness ---------------------------------------
    rule(r"Critical damage is increased by " + PCT + r"%|Increases? [Cc]ritical (?:Hit )?damage by " + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "critDamage", "scope": "all",
                     "value": pct(m, 1 if m.group(1) else 2)}])
    rule(r"Increases? [Cc]ritical (?:Hit )?[Cc]hance by " + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "critChance", "scope": "all", "value": pct(m)}])
    rule(r"Increase Status Effect effectiveness by " + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "statusEffectiveness", "scope": "all",
                     "value": pct(m)}])

    # --- Conditionals ------------------------------------------------------
    rule(r"Deal " + PCT + r"% more damage while above " + PCT + r"% Health",
         lambda m: [{"op": "conditional", "when": "healthAbove", "threshold": pct(m, 2),
                     "then": [{"op": "mult", "stat": "damage", "scope": "all",
                               "value": pct(m)}]}])
    rule(r"Deal " + PCT + r"% (?:more|additional) damage to enemies at full Health",
         lambda m: [{"op": "conditional", "when": "targetHealthAbove", "threshold": 0.999,
                     "then": [{"op": "mult", "stat": "damage", "scope": "all",
                               "value": pct(m)}]}])
    rule(r"Deal " + PCT + r"% more damage to enemies within " + PCT + r" meters",
         lambda m: [{"op": "mult", "stat": "damage", "scope": "all", "value": pct(m),
                     "note": "only within %s meters" % m.group(2)}])

    # --- Stacking ----------------------------------------------------------
    rule(r"([A-Z][\w' ]{2,24}?) deals? " + PCT +
         r"% more damage each time the same target is hit",
         lambda m: [{"op": "stacking", "stat": "dotDamage", "scope": "dot",
                     "valuePer": pct(m, 2), "per": "hit", "max": None,
                     "note": m.group(1).strip()}])
    rule(r"Increase damage by " + PCT + r"% for each hit[^.]*?[Cc]aps at " + PCT + r"%",
         lambda m: [{"op": "stacking", "stat": "damage", "scope": "all",
                     "valuePer": pct(m), "per": "hit",
                     "max": round(pct(m, 2) / pct(m), 0)}])
    rule(r"Increases? (?:player's )?damage and fire rate by " + PCT + r"% per stack",
         lambda m: [{"op": "stacking", "stat": "damage", "scope": "all",
                     "valuePer": pct(m), "per": "stack", "max": None},
                    {"op": "stacking", "stat": "fireRate", "scope": "all",
                     "valuePer": pct(m), "per": "stack", "max": None}])

    # --- Status modifiers --------------------------------------------------
    rule(r"([A-Z][\w']{2,20}) deals? " + PCT + r"% (?:more|additional|increased) damage(?! each)",
         lambda m: ([{"op": "statusMod", "status": norm_status(m.group(1)),
                      "stat": "dotDamage", "value": pct(m, 2)}]
                    if norm_status(m.group(1)) in STATUSES else []))

    # --- Enemy damage-taken amplifiers -------------------------------------
    rule(r"take " + PCT + r"% (?:more|additional|increased) damage",
         lambda m: [{"op": "mult", "stat": "damage", "scope": "all", "value": pct(m),
                     "note": "amplifier on affected enemies"}])
    rule(r"increase the damage they take by " + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "damage", "scope": "all", "value": pct(m),
                     "note": "amplifier on affected enemies"}])

    # --- Second wave: families found by auditing scripts/uncodified.txt -----

    # "Flares have a 30% chance to explode, dealing 50 damage to nearby enemies."
    rule(PCT + r"% chance to explode, dealing " + PCT + r" damage",
         lambda m: [{"op": "proc", "amount": float(m.group(2)), "of": "flat",
                     "chance": pct(m), "scope": "all", "note": "explosion"}])
    # "Hemorrhage explodes on hit, dealing 40 damage to nearby targets."
    rule(r"explodes?[^.]{0,30}, dealing " + PCT + r" damage",
         lambda m: [{"op": "proc", "amount": float(m.group(1)), "of": "flat",
                     "chance": 1.0, "scope": "all", "note": "explosion"}])
    # "...dealing 150% of the anchor's damage." / "20% of your Gold as additional damage"
    rule(r"deals? " + PCT + r"% of (?:the |your )?([\w' ]{2,24}?)(?:'s)? (?:damage|as additional damage)",
         lambda m: [{"op": "proc", "amount": pct(m), "of": "onHitDamage", "chance": 1.0,
                     "scope": "all", "note": "scales from %s" % m.group(2).strip()}])
    rule(r"dealing " + PCT + r"% (?:of )?ability damage",
         lambda m: [{"op": "proc", "amount": pct(m), "of": "abilityDamage",
                     "chance": 1.0, "scope": "ability"}])

    # "has a 20% chance to bounce/Stun/Weakspot hit/double"
    rule(r"has (?:a )?" + PCT + r"% chance to (bounce|Stun|Weakspot hit|explode|double|trigger twice)",
         lambda m: [{"op": "trigger", "on": "hit", "chance": pct(m), "then": [],
                     "note": m.group(2).lower()}])
    rule(r"have (?:a )?" + PCT + r"% chance to (Stun|explode|bounce)",
         lambda m: [{"op": "trigger", "on": "hit", "chance": pct(m), "then": [],
                     "note": m.group(2).lower()}])

    # "Every Blood Blessing increases your max Health by 5%."
    rule(r"Every (\w+) Blessing increases (?:your )?([\w ]+?) by " + PCT + r"%",
         lambda m: [{"op": "stacking",
                     "stat": STAT_WORDS.get(norm_status(m.group(2)), "damage"),
                     "scope": "all", "valuePer": pct(m, 3), "per": "blessing",
                     "max": None,
                     "note": "per %s Blessing: %s" % (m.group(1), m.group(2).strip())}])
    rule(r"Every (\w+) Blessing reduces the damage you receive by " + PCT + r"%",
         lambda m: [{"op": "stacking", "stat": "damageTaken", "scope": "all",
                     "valuePer": -pct(m, 2), "per": "blessing", "max": None}])

    # "Weakspot damage to enemies on Fire is increased by 25%."
    rule(r"Weakspot damage to enemies ([\w ]{3,20}) is increased by " + PCT + r"%",
         lambda m: [{"op": "conditional", "when": "targetHasStatus",
                     "status": norm_status(m.group(1).replace("on ", "")),
                     "then": [{"op": "mult", "stat": "weakspotDamage", "scope": "all",
                               "value": pct(m, 2)}]}])
    rule(PCT + r"% more Weakspot damage",
         lambda m: [{"op": "mult", "stat": "weakspotDamage", "scope": "all",
                     "value": pct(m)}])

    # "Enemies take 10% more Flare damage each time they Flare."
    rule(r"take " + PCT + r"% more ([\w]+) damage each time",
         lambda m: [{"op": "stacking", "stat": "dotDamage", "scope": "dot",
                     "valuePer": pct(m), "per": "application", "max": None,
                     "note": m.group(2)}])
    # "Gain 10% Fire Rate per enemy currently affected by your Fire."
    rule(r"Gain " + PCT + r"% Fire Rate per enemy",
         lambda m: [{"op": "stacking", "stat": "fireRate", "scope": "all",
                     "valuePer": pct(m), "per": "affectedEnemy", "max": None}])
    rule(r"Increase Status Effectiveness by " + PCT + r"% per enemy",
         lambda m: [{"op": "stacking", "stat": "statusEffectiveness", "scope": "all",
                     "valuePer": pct(m), "per": "affectedEnemy", "max": None}])
    rule(r"Increases? Status Effectiveness by " + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "statusEffectiveness", "scope": "all",
                     "value": pct(m)}])

    # Durations / buildup
    rule(r"(?:lasts?|are \w+) " + PCT + r"% longer",
         lambda m: [{"op": "mult", "stat": "statusDuration", "scope": "all",
                     "value": pct(m)}])
    rule(r"apply " + PCT + r"% more ([\w]+) build-?up",
         lambda m: [{"op": "mult", "stat": "statusEffectiveness", "scope": "all",
                     "value": pct(m), "note": "%s buildup" % m.group(2)}])

    # Health / movement percentages
    rule(r"increases? your max Health by " + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "maxHealth", "scope": "all", "value": pct(m)}])
    rule(r"[Mm]ovement speed is increased by " + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "movementSpeed", "scope": "all",
                     "value": pct(m)}])
    rule(r"Increases? movement speed by " + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "movementSpeed", "scope": "all",
                     "value": pct(m)}])

    # "deals 25% less damage" / "reduces ... by N%"
    rule(r"deals? " + PCT + r"% less damage",
         lambda m: [{"op": "mult", "stat": "damage", "scope": "all", "value": -pct(m)}])
    rule(r"Blessings on your \w+ trigger " + PCT + r"% more frequently",
         lambda m: [{"op": "mult", "stat": "triggerChance", "scope": "all",
                     "value": pct(m)}])
    rule(r"Blessing trigger chance",
         lambda m: [{"op": "mult", "stat": "triggerChance", "scope": "all",
                     "value": 0.0, "note": "see description for magnitude"}])

    # "Increases damage the longer you fire" style: up-to caps
    rule(r"(?:by )?up to " + PCT + r"% (?:more|additional|increased)? ?damage",
         lambda m: [{"op": "mult", "stat": "damage", "scope": "all", "value": pct(m),
                     "note": "ramping: this is the maximum"}])

    # --- Third wave: damage-relevant forge-upgrade phrasings ---------------

    rule(r"Deal " + PCT + r"% more (Primary|Secondary) damage",
         lambda m: [{"op": "mult", "stat": "damage", "scope": m.group(2).lower(),
                     "value": pct(m)}])
    rule(r"(?:deals?|dealing) " + PCT + r"% weapon damage as damage over time",
         lambda m: [{"op": "proc", "amount": pct(m), "of": "weaponDamage",
                     "chance": 1.0, "scope": "dot"}])
    rule(r"dealing " + PCT + r"% weapon damage",
         lambda m: [{"op": "proc", "amount": pct(m), "of": "weaponDamage",
                     "chance": 1.0, "scope": "all"}])
    rule(r"damage over time multiplier is increased by " + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "dotDamage", "scope": "dot", "value": pct(m)}])
    rule(r"Each consecutive Weakspot hit increases damage by " + PCT + r"%",
         lambda m: [{"op": "stacking", "stat": "damage", "scope": "all",
                     "valuePer": pct(m), "per": "weakspot", "max": None,
                     "note": "resets on reload"}])
    rule(r"Deal " + PCT + r"% more damage each time [\w ]+ hits the same enemy",
         lambda m: [{"op": "stacking", "stat": "damage", "scope": "all",
                     "valuePer": pct(m), "per": "hit", "max": None}])
    rule(r"Increases? (?:the )?max(?:imum)? clip size[^.]*?by " + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "clipSize", "scope": "all", "value": pct(m)}])
    rule(r"Increase magazine size by " + PCT + r"(?!%)",
         lambda m: [{"op": "flat", "stat": "clipSize", "scope": "all",
                     "value": float(m.group(1))}])
    rule(r"(?:increased?|increases) fire rate by up to " + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "fireRate", "scope": "all", "value": pct(m),
                     "note": "ramping: this is the maximum"}])
    rule(r"deal(?:s)? triple damage",
         lambda m: [{"op": "mult", "stat": "damage", "scope": "ability", "value": 2.0,
                     "note": "triple damage"}])
    rule(r"[Nn]ext hit damage is doubled|doubles the damage of your next hit",
         lambda m: [{"op": "trigger", "on": "kill", "chance": 1.0,
                     "then": [{"op": "mult", "stat": "damage", "scope": "all",
                               "value": 1.0, "note": "next hit only"}]}])
    rule(r"Increases? Damage by " + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "damage", "scope": "all", "value": pct(m)}])
    rule(r"increase its damage by " + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "abilityDamage", "scope": "ability",
                     "value": pct(m)}])
    rule(r"Reduce the [\w' ]+ Fire Rate by " + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "fireRate", "scope": "ability",
                     "value": -pct(m)}])
    rule(r"bonus damage based on enemies' missing Health",
         lambda m: [{"op": "conditional", "when": "targetHealthBelow", "threshold": 1.0,
                     "then": [], "note": "scales with missing Health; magnitude unstated"}])

    # --- Fourth wave: flat-damage procs and on-hit scaling -----------------

    rule(r"deals? " + PCT + r" damage every second",
         lambda m: [{"op": "proc", "amount": float(m.group(1)), "of": "flat",
                     "chance": 1.0, "scope": "dot", "note": "per second"}])
    rule(r"explodes? for " + PCT + r" damage",
         lambda m: [{"op": "proc", "amount": float(m.group(1)), "of": "flat",
                     "chance": 1.0, "scope": "all", "note": "explosion"}])
    rule(r"take " + PCT + r"% of (?:the )?on-hit damage",
         lambda m: [{"op": "proc", "amount": pct(m), "of": "onHitDamage",
                     "chance": 1.0, "scope": "all"}])
    rule(r"(?:deals?|dealing) (?:an additional )?" + PCT + r"% of the on-hit damage",
         lambda m: [{"op": "proc", "amount": pct(m), "of": "onHitDamage",
                     "chance": 1.0, "scope": "all"}])
    rule(r"take " + PCT + r"% of the [\w' ]+ damage over " + PCT + r" seconds",
         lambda m: [{"op": "proc", "amount": pct(m), "of": "statusDamage",
                     "chance": 1.0, "scope": "dot",
                     "note": "over %s seconds" % m.group(2)}])
    rule(r"dealing " + PCT + r"% additional damage in an area",
         lambda m: [{"op": "mult", "stat": "aoeDamage", "scope": "all", "value": pct(m)}])
    rule(r"deals? " + PCT + r" damage over time per",
         lambda m: [{"op": "proc", "amount": float(m.group(1)), "of": "flat",
                     "chance": 1.0, "scope": "dot", "note": "per stack"}])
    rule(r"Gain " + PCT + r"% increased ([\w]+) damage for each",
         lambda m: [{"op": "stacking", "stat": "dotDamage", "scope": "dot",
                     "valuePer": pct(m), "per": "stack", "max": None,
                     "note": m.group(2)}])
    rule(r"(?:causes? an )?explosion dealing " + PCT + r" damage",
         lambda m: [{"op": "proc", "amount": float(m.group(1)), "of": "flat",
                     "chance": 1.0, "scope": "all", "note": "explosion"}])
    rule(r"dealing " + PCT + r" damage in a " + PCT + r"-meter radius",
         lambda m: [{"op": "proc", "amount": float(m.group(1)), "of": "flat",
                     "chance": 1.0, "scope": "all",
                     "note": "%s-meter radius" % m.group(2)}])
    rule(r"has (?:a )?" + PCT + r"% chance to (?:give the player )?increased damage",
         lambda m: [{"op": "trigger", "on": "hit", "chance": pct(m), "then": [],
                     "note": "grants increased damage; magnitude unstated"}])

    # --- Generic fallbacks (last) ------------------------------------------
    rule(r"(?:Increase|Increases) all damage by " + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "damage", "scope": "all", "value": pct(m)}])
    rule(r"[Dd]amage is increased by " + PCT + r"%",
         lambda m: [{"op": "mult", "stat": "damage", "scope": "all", "value": pct(m)}])
    rule(r"deals? " + PCT + r"% (?:more|additional|increased) damage",
         lambda m: [{"op": "mult", "stat": "damage", "scope": "all", "value": pct(m)}])

    return R


RULES = rules()


def codify(description):
    """-> list of effects. Overlapping matches resolve in favour of the earlier rule."""
    claimed = []
    effects = []

    def overlaps(a, b):
        return any(not (b <= s or a >= e) for s, e in claimed)

    for rx, fn in RULES:
        for m in rx.finditer(description):
            if overlaps(m.start(), m.end()):
                continue
            built = fn(m)
            if built:
                claimed.append((m.start(), m.end()))
                effects.extend(built)
    return effects


def apply_to(entities, stats):
    for e in entities:
        desc = e.get("description") or ""
        eff = codify(desc)
        e["effects"] = eff
        stats["total"] += 1
        if eff:
            stats["codified"] += 1
            e.pop("unmodeled", None)
        else:
            e["unmodeled"] = "no numeric damage effect the DSL can express"
            stats["uncodified"].append((stats["label"], e.get("name"), desc[:80]))


def main():
    report = {}

    def run(label, path, collect):
        doc = json.load(open(os.path.join(DATA, path), encoding="utf-8"))
        stats = {"total": 0, "codified": 0, "uncodified": [], "label": label}
        apply_to(collect(doc), stats)
        write_json(os.path.join(DATA, path), doc)
        report[label] = stats

    run("blessings", "blessings.json", lambda d: d["blessings"])
    run("charms", "charms.json", lambda d: d["charms"])
    run("soul wheel", "soul_wheel.json",
        lambda d: [s for r in d["rows"] for s in r["skills"]])
    run("weapon forge", "weapons.json",
        lambda d: [u for w in d["weapons"] for u in w["forgeUpgrades"]])
    run("ability forge", "abilities.json",
        lambda d: [u for a in d["abilities"] for u in a["forgeUpgrades"]])
    run("shared ability forge", "ancient_forge.json",
        lambda d: d["abilityUpgrades"]["shared"])
    run("status effects", "status_effects.json",
        lambda d: d["enemyDebuffs"] + d["playerPositive"] + d["playerNegative"])

    print("\n=== codification coverage ===")
    grand_t = grand_c = 0
    for label, s in report.items():
        grand_t += s["total"]
        grand_c += s["codified"]
        print(f"  {label:22s} {s['codified']:3d}/{s['total']:3d}  "
              f"({100 * s['codified'] / s['total']:.0f}%)")
    print(f"  {'TOTAL':22s} {grand_c:3d}/{grand_t:3d}  ({100 * grand_c / grand_t:.0f}%)")

    with open(os.path.join(os.path.dirname(DATA), "scripts", "uncodified.txt"),
              "w", encoding="utf-8") as f:
        for label, s in report.items():
            for lbl, name, desc in s["uncodified"]:
                f.write(f"{lbl}\t{name}\t{desc}\n")
    print("\nuncodified entries listed in scripts/uncodified.txt")


if __name__ == "__main__":
    main()
