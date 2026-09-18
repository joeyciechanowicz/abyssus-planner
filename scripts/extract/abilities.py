"""Build data/abilities.json.

Base stats come from each page's prose Description (they are not in a table), so
they are transcribed by hand below. The 66 Forge Upgrade descriptions come from the
card images via scripts/extract/ability_cards.py -- text read visually off the tiled
sheets and transcribed here verbatim, wiki typos included ("25% mode damage").

Run ability_cards.py first: it downloads the cards, writes the icon dedup map, and
saves the sheets this transcription was read from.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wiki import DATA, snake, wikitext, write_json
from ability_cards import SCRATCH, gallery

SOURCE = "https://abyssus.wiki.gg/wiki/Abilities"

# id -> base stats, read from each ability page's == Description ==.
BASE = {
    "frag_grenade": {
        "name": "Frag Grenade", "page": "Frag Grenade",
        "damage": 200, "weakspotDamage": 400, "charges": 3,
        "tags": ["explosion", "aoe"],
        "notes": "Counts as an explosion (benefits from Mr. Boom). Wide area.",
    },
    "anchor": {
        "name": "Anchor", "page": "Anchor",
        "damage": 600, "weakspotDamage": None, "charges": 2,
        "tags": ["explosion", "aoe", "melee"],
        "notes": "Swung from behind the player. Counts as an explosion (Mr. Boom).",
    },
    "smiting_spear": {
        "name": "Smiting Spear", "page": "Smiting Spear",
        "damage": 200, "weakspotDamage": None, "charges": 1,
        "tags": ["explosion", "aoe", "dot"],
        "pulses": {"count": 8, "damage": 50},
        "maxActive": 6,
        "notes": "200 impact damage plus 8 pulses of 50 in a medium radius. Pulses "
                 "scale with explosive damage modifiers. Up to 6 spears active at once.",
    },
    "ancient_core": {
        "name": "Ancient Core", "page": "Ancient Core",
        "damage": None, "weakspotDamage": 1000, "charges": 2,
        "tags": ["single-target"],
        "notes": "Fires a single ray dealing 1000 base weakspot damage to one enemy.",
    },
    "brine_field": {
        "name": "Brine Field", "page": "Brine Field",
        "damage": 200, "weakspotDamage": None, "charges": 1,
        "tags": ["aoe", "support", "dot"],
        "damagePerTick": 200,
        "notes": "The only support ability. 200 damage per tick and 50% damage "
                 "reduction inside its range (non-stackable).",
    },
    "turret": {
        "name": "Turret", "page": "Turret",
        "damage": 50, "weakspotDamage": None, "charges": 1,
        "tags": ["summon", "dps"],
        "damagePerShot": 50,
        "notes": "Deployed turret that fires in all directions and expires after a "
                 "short duration.",
    },
}

# Forge Upgrade text, keyed by the card's file slug. Read from the tiled sheets.
UPGRADES = {
    # Frag Grenade
    "Exposure_Blast": "Enemies hit by grenade explosions take 15% additional damage.",
    "Domino": "Enemies killed by your grenade's explosion or killed shortly after being hit by your grenade also explode, dealing 60% ability damage.",
    "Explosive_Culling": "Your grenade deals bonus damage based on enemies' missing Health.",
    "Implosive_Force": "Grenade explosions pull enemies in and stun them for 1 sec.",
    "Cluster_Bomb": "Grenades split into explosive fragments on detonation.",
    "Compact_Grenade": "Grenades deal triple damage, but the number of ability stacks is halved (rounded up).",
    "Shrapnel": "Enemies hit by grenades take 25% grenade damage continuously for 3 sec.",
    "Bouncy_Bomb": "Grenades explode each time they bounce and are no longer destroyed on impact with enemies. Bounce explosions have halved range and damage.",
    "Gas_Grenade": "Grenades leave behind a cloud of gas that deals 50% grenade damage continuously.",
    "Gashing_Shell": "Grenades deal 25% more damage to enemies suffering from status effects or that are Stunned, Slowed, Frozen or Rooted.",
    "Sharp_Shell": "Weakspot hits with grenades make the explosions deal 25% more damage and restores 25% of the cooldown.",
    # Anchor
    "Self-sustaining": "10% ability cooldown reduction for every enemy hit by the anchor.",
    "The_Thrill": "Increases movement speed by 10% for 5 sec. per enemy hit by the anchor.",
    "Grenanchor": "The anchor is now thrown.",
    "Brine": "Creates a toxic pool on the ground that repeatedly deals 25% of the anchor's damage to nearby enemies.",
    "Bulwark": "Gain brief invulnerability while swinging the anchor.",
    "Fearless": "Deal 50% more damage to enemies within 5 meters.",
    "Anchored": "Flying enemies fall when hit by the anchor, and take 100% more damage for 5 sec.",
    "Bonebreaker": "Enemies hit by the anchor deal 25% less damage for 5 sec.",
    "Mighty": "Enemies hit by the anchor are knocked back.",
    "Geyser": "Causes a delayed explosion where the anchor hits, dealing 150% of the anchor's damage.",
    "Death_Slam": "Deal 50% additional damage to enemies at full Health.",
    # Smiting Spear
    "Shockwave": "Spears create shockwaves when sticking and for every 3 hits. Shockwaves deal 40 damage.",
    "Chain_Pulse": "The pulse from one spear has a 60% chance to cause other spears to pulsate.",
    "Charmed_Spear": "Gain buffs based on your Charms.\n\nCommon: +20% pulse damage.\nRare: +50% duration.\nLegendary: +1 pulse.",
    "Sticking_Spear": "Spears that stick to enemies deal 20% increased pulse damage.",
    "Weakspot_Spear": "Spears that stick on a Weakspot have 25% increased damage and range.",
    "Fragmenting_Spear": "Spears send a fragment toward a nearby enemy when sticking, dealing 40 damage. Sends additional fragments for every spear stuck in the enemy.",
    "Spear_Grid": "Spears that are stuck create a field between them that deals 30 damage to enemies that enter it.",
    "Split_Spear": "Throw additional spears diagonally left and right.",
    "Enduring_Spear": "If an enemy dies from, or shortly after, being hit by a spear, the spear's duration resets.",
    "Environmental_Spear": "Spears that stick to the environment Slow nearby enemies and increase their damage taken by 5%.",
    "Charged_Spear": "Spears can be charged before being thrown, consuming stacks to increase damage and duration, while decreasing damage intervals, by 50% per stack.",
    # Ancient Core
    "Cone_Blast": "The blast from the Ancient Core targets all enemies in a cone instead of the first one.",
    "Gold_Blast": "Enemies killed by the blast from the Ancient Core drop Gold.",
    "Stun_Blast": "The blast from the Ancient Core also stuns on hit.",
    "Bounce_Blast": "The blast from the Ancient Core also bounces to an additional nearby enemy.",
    "Active_Reload": "Getting a kill with the Ancient Core resets its cooldown.",
    "Target_Lock": "Deal 10% more damage each time the Ancient Core hits the same enemy.",
    "Hunters_Mark": "Enemies hit by the Ancient Core are marked, increasing all Weakspot damage they receive by 25% for 5 sec.",
    "Laser_Sight": "Deal up to 50% additional damage the further away the enemy is.",
    "Death_Strike": "Deal 50% additional damage to enemies at full Health.",
    "Trigger_Happy": "Increases damage by 50% if the Ancient Core is used within 2 sec of the cooldown refreshing.",
    "Explosive_Blast": "The blast from the Ancient Core explodes on hit, dealing damage to nearby enemies equivalent to 25% of the hit.",
    # Brine Field
    "Quality_Over_Quantity": "Buffs the current active Brine Field instead of placing a new one, increasing its benefits by 20% and its area by 20%.",
    "Personal_Space": "Enemies within the Brine Field take 15% more damage from all sources.",
    "Safety_Dance(3)": "The Brine Field increases your firerate by 30%.",
    "Lingering_Field": "The effects of the Brine Field linger for 5 sec. after the player or enemy leaves it.",
    "Steady_Field": "Players deal 30% more Weakspot damage when inside the Brine Field.",
    "Mobility_Field": "Decreases the Brine Field's size by 20%, but its attached to you.",
    "End_With_a_Bang!": "The Brine Field explodes when it's destroyed, dealing 300 damage in a 10-meter radius.",
    "Time_Warp": "Brine Field Slows enemies 20% more and enemy projectiles within its area are Slowed by 70%.",
    "Noxious_Bubble": "Status effect tick at a speed of 200% on enemies within the Brine Field.",
    "Expanding_Territory": "The Brine Field continuously increases in size when placed.",
    "Sanctum": "Blessings on your Brine Field trigger 3% more frequently for every meter of the radius.",
    # Turret
    "Sniper_Mode": "Reduce the Turret's Fire Rate by 200%, but increase its damage by 500%. All its hits count as Weakspot hits.",
    "Drones": "The Turret now flies, staying in close proximity while shooting nearby enemies.",
    "Ammo_Transfer": "60% chance when the Turret shoots an enemy to reload 1 ammo into your magazine.",
    "Buddy_System": "Lowers the cooldown by 10 sec. and reduces the damage dealt by your Turret. Turrets deal increased damage for each Turret within range",
    "Unstable_Cores": "Your Turret explodes and stuns enemies in a 10-meter radius when it spawns.",
    "Sentinel": "Increases Turret Fire Rate by 20% for every player within 15-meters.",
    "Persistent": "Damage is increased by 10% and duration by 50%.",
    "Spiked_Ammunition": "Projectiles explode on hit and deal 25% additional damage.",
    "Guiding_Bullet": "You deal 25% mode damage to your Turret's target.",
    "Teamwork": "Your Fire Rate is increased by 10% when your Turrets get a kill, and your Turrets' Fire Rate is increased by 10% when you get a kill.",
    "Ricochet": "Turret projectiles bounce to another enemy. Richochets deal 50% less damage.",
}


def title_of(slug_name):
    """Card file slug -> display name ('Safety_Dance(3)' -> 'Safety Dance')."""
    n = re.sub(r"\(\d+\)$", "", slug_name)
    return n.replace("_", " ").strip()


def main():
    icon_map = json.load(open(os.path.join(SCRATCH, "ability_icon_map.json")))

    abilities, all_names = [], []
    for aid, base in BASE.items():
        cards = [f.strip().replace(" ", "_") for f in gallery(base["page"])]
        upgrades = []
        for card in cards:
            key = card[:-4] if card.lower().endswith(".png") else card
            if key not in UPGRADES:
                raise KeyError(f"{base['name']}: no transcription for {key!r}")
            name = title_of(key)
            all_names.append(name)
            upgrades.append({
                "id": snake(name),
                "name": name,
                "description": UPGRADES[key],
                "icon": icon_map.get(card),
                "effects": [],
            })

        entry = {k: v for k, v in base.items() if k != "page"}
        entry.update({"id": aid, "source": "https://abyssus.wiki.gg/wiki/" + base["page"],
                      "forgeUpgrades": upgrades})
        abilities.append(entry)

    # Every card must have its own text: shared icon art never implies shared text.
    expected = sum(len(gallery(b["page"])) for b in BASE.values())
    assert len(all_names) == expected == 66, (len(all_names), expected)
    assert len(set(all_names)) == len(all_names), "duplicate upgrade names"
    print(f"{len(abilities)} abilities, {len(all_names)} upgrades, all transcribed")

    write_json(os.path.join(DATA, "abilities.json"), {
        "source": SOURCE,
        "note": "Each ability also gets the 5 shared Forge Upgrades in "
                "data/ancient_forge.json -> abilityUpgrades.shared. Only one ability "
                "may be equipped, and at most 3 Forge Upgrades applied to it.",
        "abilities": abilities,
    })


if __name__ == "__main__":
    main()
