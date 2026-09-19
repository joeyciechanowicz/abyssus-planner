"""Link each blessing's codified effects[] back to the upgrades[] variable that
scales it, and record where a variable's rank-1 value appears in the plain-text
description, so the UI can render the description at any chosen rank.

Neither `effects[]` (scripts/codify.py, regexed from the rendered rank-1
description) nor `upgrades[]` (scripts/extract/blessing_upgrades.py, pulled from
the game's own Mutator assets) carries any reference to the other. This script
derives the link purely from the numbers already sitting in data/blessings.json
-- no game/pak access needed.

Matching rule: an effect leaf (e.g. a `mult` node's `value`) is linked to an
`upgrades[]` variable when the leaf's numeric value equals that variable's
rank-1 value, either directly (flat effects) or divided by 100 (percent
effects stored as a 0..1 fraction). A leaf is linked only when exactly one
variable matches it AND that variable matches exactly one (remaining) leaf --
resolved iteratively, since assigning an unambiguous pair can make a
previously-ambiguous one unique. Anything left ambiguous, or with no match at
all, stays untagged: the UI must not silently guess a link that could produce
a wrong DPS number.

Run:  python scripts/link_blessing_upgrades.py
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "extract"))
from wiki import DATA, write_json

TOL = 1e-6

# effect op -> leaf field(s) that can carry a scalesWith link, and the JSON key
# used to store it (usually "scalesWith"; proc has two independent numbers).
LEAF_FIELDS = {
    "mult": [("value", "scalesWith")],
    "flat": [("value", "scalesWith")],
    "applyStatus": [("chance", "scalesWith")],
    "statusMod": [("value", "scalesWith")],
    "stacking": [("valuePer", "scalesWith")],
    "proc": [("amount", "scalesWith"), ("chance", "chanceScalesWith")],
    "trigger": [("chance", "scalesWith")],
}


def collect_leaves(effects, out):
    """Walk an effects tree (including conditional/trigger `then` arrays),
    appending (node_dict, value_field, link_field) for every scalable leaf."""
    for node in effects:
        op = node.get("op")
        for value_field, link_field in LEAF_FIELDS.get(op, []):
            if value_field not in node or not isinstance(node[value_field], (int, float)):
                continue
            # proc.chance is usually just the DSL's "always happens" default (1.0),
            # not a real scaling parameter -- treating it as a leaf would make it a
            # spurious candidate match for any variable whose rank-1 value is 100.
            if op == "proc" and value_field == "chance" and node[value_field] == 1.0:
                continue
            out.append((node, value_field, link_field))
        if "then" in node:
            collect_leaves(node["then"], out)


def link_effects(blessing):
    leaves = []
    collect_leaves(blessing["effects"], leaves)
    variables = [u for u in blessing["upgrades"] if u["ranks"][0] != 0]
    if not leaves or not variables:
        return 0

    unresolved_leaves = list(leaves)
    unresolved_vars = list(variables)
    linked = 0

    while True:
        # leaf -> matching variables (index into unresolved_vars)
        leaf_matches = []
        for node, field, _link_field in unresolved_leaves:
            # Compare magnitudes: a "reduces damage taken by N%" style effect is
            # stored as a negative value by codify.py, but the rank data records
            # only the positive magnitude. The sign itself doesn't need scaling --
            # scaleBlessingEffects() re-derives it from the ratio of signed values.
            v = abs(node[field])
            matches = [
                i for i, u in enumerate(unresolved_vars)
                if abs(v - u["ranks"][0]) < TOL or abs(v - u["ranks"][0] / 100) < TOL
            ]
            leaf_matches.append(matches)

        # variable -> how many unresolved leaves matched it
        var_leaf_count = [0] * len(unresolved_vars)
        for matches in leaf_matches:
            for i in matches:
                var_leaf_count[i] += 1

        progressed = False
        next_leaves = []
        used_var_idx = set()
        for (node, field, link_field), matches in zip(unresolved_leaves, leaf_matches):
            if len(matches) == 1 and var_leaf_count[matches[0]] == 1 and matches[0] not in used_var_idx:
                node[link_field] = unresolved_vars[matches[0]]["variable"]
                used_var_idx.add(matches[0])
                linked += 1
                progressed = True
            else:
                next_leaves.append((node, field, link_field))

        unresolved_vars = [u for i, u in enumerate(unresolved_vars) if i not in used_var_idx]
        unresolved_leaves = next_leaves
        if not progressed or not unresolved_leaves or not unresolved_vars:
            break

    return linked


def fmt(n):
    return str(int(n)) if float(n).is_integer() else str(n)


def link_description_spans(blessing):
    desc = blessing["description"]
    claimed = []
    linked = 0

    def find_unclaimed(token):
        for m in re.finditer(re.escape(token), desc):
            if not any(not (m.end() <= s or m.start() >= e) for s, e in claimed):
                return m
        return None

    for u in blessing["upgrades"]:
        rank0 = u["ranks"][0]
        if rank0 == 0:
            u["descriptionSpan"] = None
            continue
        variants = [fmt(rank0) + "%", fmt(rank0)] if u["isPercent"] else [fmt(rank0), fmt(rank0) + "%"]
        span = None
        for token in variants:
            m = find_unclaimed(token)
            if m:
                span = [m.start(), m.end()]
                claimed.append((m.start(), m.end()))
                break
        u["descriptionSpan"] = span
        if span:
            linked += 1
    return linked


def main():
    path = os.path.join(DATA, "blessings.json")
    data = json.load(open(path, encoding="utf-8"))
    blessings = data["blessings"]

    total_vars = 0
    linked_effect_leaves = 0
    linked_spans = 0
    fully_linked = 0
    partially_linked = 0
    unlinked = 0

    for b in blessings:
        if not b.get("upgrades"):
            continue
        total_vars += len(b["upgrades"])
        n_effect_links = link_effects(b)
        n_span_links = link_description_spans(b)
        linked_effect_leaves += n_effect_links
        linked_spans += n_span_links
        if n_effect_links == len(b["upgrades"]):
            fully_linked += 1
        elif n_effect_links > 0:
            partially_linked += 1
        else:
            unlinked += 1

    write_json(path, data)

    upgradable = fully_linked + partially_linked + unlinked
    print("\n=== blessing upgrade linkage ===")
    print(f"  blessings with upgrades:     {upgradable}")
    print(f"  fully linked to effects:     {fully_linked}")
    print(f"  partially linked:            {partially_linked}")
    print(f"  not linked to effects at all:{unlinked}")
    print(f"  upgrade variables total:     {total_vars}")
    print(f"  variables linked to an effect leaf: {linked_effect_leaves}")
    print(f"  variables linked to a description span: {linked_spans}")


if __name__ == "__main__":
    main()
