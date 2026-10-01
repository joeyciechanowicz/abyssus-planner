# Data pipeline

The JSON under `data/` and the icons under `public/` are generated from
[abyssus.wiki.gg](https://abyssus.wiki.gg). Run the steps **in this order** — each
one overwrites what the previous wrote.

```
1. extract    python scripts/extract/soul_wheel.py
              python scripts/extract/status_effects.py
              python scripts/extract/ability_cards.py   # downloads cards, builds OCR sheets
              python scripts/extract/abilities.py       # needs ability_cards.py first
              python scripts/extract/weapon_stats.py

2. codify     python scripts/codify.py                 # rules + effect_overrides.json
              python scripts/link_blessing_upgrades.py # re-link rank scaling

3. optimise   python scripts/optimize_images.py

4. verify     npm run validate && npx vitest run
```

**Why the order matters.** The extractors rebuild their entities from the wiki and
write `"effects": []`, so running one *after* `codify.py` silently discards the
codified effects — re-run `codify.py` whenever you re-extract. The extractors also
write `.png` icon paths, which `optimize_images.py` converts and repoints to
`.webp`; `codify.py` leaves icon paths alone, so it is safe in the middle.

## Gotchas worth knowing

- **A custom `User-Agent` is required.** Plain requests get HTTP 403. It is set in
  `extract/wiki.py`, which all the scripts share.
- **The image API normalises `_` to spaces** in the titles it echoes back, so a
  lookup keyed by the requested `File:Foo_Bar.png` misses. `wiki.image_urls` maps
  `query.normalized` back to the requested spelling. This bug silently skipped 36
  of 43 Soul Wheel icons and 27 of 28 status icons; the extractors now report how
  many files are **on disk** rather than how many URLs resolved.
- **Commented-out wikitable rows span several `|-` boundaries**, so strip
  `<!-- ... -->` from the whole table body before splitting rows, or placeholder
  rows ("Name | Effect") survive as real entries.
- **A shared icon never implies shared text.** Several forge upgrades reuse one
  piece of icon art but have completely different names and effects. Icon files are
  deduplicated by hashing the cropped icon region; the card *text* must still be
  read individually for every card.
- **Card text is not in the wikitext.** Blessings and forge upgrades exist only as
  card images, so their text is read visually off tiled crop sheets. There is no
  OCR binary on this machine.

## Blessing upgrade values (from the game files, not the wiki)

The wiki only shows each blessing's base (rank 1) text. The full per-rank scaling —
`upgrades` on each entry in `data/blessings.json` — is pulled directly from the
game's `.pak` instead, because the wiki simply doesn't have it. This is a separate,
heavier pipeline from the wiki extractors above and only needs re-running after a
game update changes blessing numbers:

```
1. Launch Abyssus, then inject Dumper-7 (github.com/Encryqed/Dumper-7) into the
   running RGame-Win64-Shipping.exe process. This dumps a fresh
   Mappings/<version>.usmap to C:\Dumper-7\<version>\ — required because the game
   ships Unreal's compact "unversioned" property format, which has no field names
   without this mappings file. Dumper-7 reads the live reflection data out of the
   game's memory; there is no way to generate it from the shipped files alone.

2. dotnet run --project scripts/extract/dump_mutators -- \
     "<path to>\Abyssus\RGame\Content\Paks" \
     "C:\Dumper-7\<version>\Mappings\<version>.usmap" \
     <output dir>
   This uses CUE4Parse to read every PrimaryAssets/CharacterMutators (etc.) uasset
   straight out of the pak and dumps each one's resolved properties to JSON.

3. python scripts/extract/blessing_upgrades.py <output dir>
   Matches each dumped RCharacterMutatorPrimaryAsset to a blessing in
   data/blessings.json by name and writes its MutatorDescriptionVariables (each a
   {variable, label, isPercent, ranks} tuple, `ranks` being the absolute value at
   each rank, not a delta) onto that blessing's `upgrades` field. Blessings with no
   multi-rank variable (mostly capstone-style blessings) are left without an
   `upgrades` field — that's expected, not a bug.
```

Internally, "Blessings" are called "Mutators" (class `RCharacterMutatorPrimaryAsset`,
base class `RMutatorPrimaryAsset`). Scaling numbers live on each instance's
`MutatorDescriptionVariables` array; `RankValues` holds one int per upgrade rank.
The dump_mutators output is not committed (it's large, machine/build-specific, and
regeneratable) — only the merged `upgrades` field in `data/blessings.json` is.

## Weapon mode stats (from the game files, not the wiki)

The wiki never publishes fire rate at all (every mode was `estimated: true`
for it), and reload time/clip size are guessed too. Damage is usually right
from the wiki's tables, but a handful of modes clearly had a guessed number
there as well. The real numbers come from the same `dump_mutators` tool used
for blessing upgrades, pointed at a different asset class:

```
1. Same Dumper-7 injection + usmap as the blessing-upgrade pipeline above (skip
   if you still have a `.usmap` from a previous run of this game version).

2. dotnet run --project scripts/extract/dump_mutators -- \
     "<path to>\Abyssus\RGame\Content\Paks" \
     "C:\Dumper-7\<version>\Mappings\<version>.usmap" \
     <output dir>
   `targetDirs` in Program.cs includes `RGame/Content/Blueprints/Weapons`,
   which is where every fire mode's own `RBaseWeaponSettings` data asset
   lives (named `DA_<Weapon>_<Mode>_ModStats`).

3. python scripts/extract/weapon_mod_stats.py <output dir>
   Matches each dumped asset to a `data/weapons.json` mode (normalized name,
   falling back to a small hardcoded table for ~14 modes whose internal
   codename doesn't match the wiki's display name at all — see the
   `MANUAL_PAIRS` dict in that script for the reasoning behind each one) and
   overwrites `fireRate`/`reloadTime`/`clipSize`/`estimated`, plus the impact
   damage/weakspot components when it's safe to (see the script's docstring
   for the guardrails: charge/ramp-range modes and combo-point-scaled Harpoon
   Gun secondaries are deliberately left alone rather than guessed at).
```

Unlike blessings (a plain `PrimaryDataAsset`), fire modes are backed by
`RBaseWeaponSettings` (`UDataAsset`), holding `BaseWeaponDamage`,
`BaseWeaponCriticalMultiplier` (the real weakspot multiplier — the engine's
own `x2` fallback is only used when a mode has no weakspot data at all),
`BaseRateOfFire`, `BaseReloadTime`, `BaseClipSize`, each a small struct with a
plain `BaseValue` float/int — the same shape as the Mutator `RankValues`
array, and just as easy to read via CUE4Parse. Status-effect and aspect
payload numbers (Hemorrhage, Fire, Windburst, …) were once thought
unreachable this way. They aren't: see "Blueprint logic & aspect payloads"
below.

3 of the 54 tracked fire modes have no confident match in the dump (Combat
Bow's Exploding Arrow, Tesla Gun's Spark Orb and Magnetic Storm — all have
wiki-documented multi-tier charge damage that doesn't correspond to a single
`BaseWeaponDamage` figure anywhere) and stay on their wiki-estimated numbers.

## Weapon portraits & ability icons (from the game files)

The wiki has no art for the weapons themselves or for abilities. Both come out of
the `.pak` with a sibling CUE4Parse tool, `dump_icons`. It decodes textures with the
`CUE4Parse-Conversion` package (same version as `CUE4Parse`):

```
1. dotnet run --project scripts/extract/dump_icons -- \
     "<path to>\Abyssus\RGame\Content\Paks" \
     "C:\Dumper-7\<version>\Mappings\<version>.usmap" \
     <output dir>                      [append "list" to also write paths.txt]
   Dumps every uasset under PrimaryAssets/ to <out>/assets/**.json and decodes
   every Texture2D under Art/UI/{Abilities,Weapon,Mutators,General,SkillTree} to
   <out>/textures/**.png. Uses the same .usmap as the pipelines above (needed for
   the data assets; the textures alone would decode without it).

2. python scripts/extract/game_icons.py <output dir> [--sheet contact_sheet.png]
   Writes public/weapon_portraits/<id>.png and public/abilities/<id>.png and the
   matching "icon" field in data/weapons.json / data/abilities.json.

3. python scripts/optimize_images.py
```

**Matching** goes through the data asset, never the texture filename. Every
`RPrimaryDataAsset` has an `AssetName` FText (the in-game display name) and an
`AssetIcon` texture; an entry matches the single asset whose normalised `AssetName`
equals its `name`. Weapons are `RWeaponPrimaryAsset` (`PrimaryAssets/Weapons/PA_*`,
icon `Art/UI/Weapon/T_UI_<Codename>_Icon_Partial_Rendered_0N`); abilities are
`RCharacterMutatorPrimaryAsset`s tagged `MutatorType = Mutator.ActivatableAbility`
(icon `Art/UI/Abilities/T_UI_Ability_<Codename>_Icon_Rendered_0N`). All 9 weapons
and 6 abilities match exactly by name, codenames notwithstanding (`BoomerangGun` =
Disc Thrower, `RocketLauncher` = Plasma Launcher, `DropShield` = Brine Field,
`AtlanteanCube` = Ancient Core, `AncientSpear` = Smiting Spear).

Gotchas:
- Use `AssetIcon`, not `SmallIcon`. `SmallIcon` is a flat white silhouette on black
  (an opaque mask the UI tints), not displayable art.
- **Charms have no per-charm art in the game.** All 40 `Mutator.Charm` assets point
  at one of three shared textures, `Art/UI/Mutators/Charm/T_UI_Icon_Charm_Default_01/02/03`
  (Common/Rare/Legendary), so `game_icons.py` leaves the existing rarity badges in
  place; it would only write `public/charms/<id>` for a charm with a texture of its own.
  (Its output also flags charms whose game texture disagrees with `rarity` in the data.)
- **Forge upgrades have no per-upgrade art either.** Every upgrade of one weapon or
  ability uses the same `T_UI_Mutator_{Weapon,Ability}Upgrade_<Codename>_Icon`, so
  the wiki's single shared Harpoon Gun icon is correct. The script prints this audit
  but never touches forge data.
- `game_icons.py` edits the JSON textually (inserting one `"icon"` line per entry)
  rather than re-dumping it, because abilities.json/charms.json contain hand-compacted
  effect objects that `json.dump` would reflow. It records the final `.webp` path and
  deletes any stale `.webp` before writing the new `.png`, since `optimize_images.py`
  otherwise keeps an existing `.webp` in preference to fresh art.
- The dump output is not committed, same as `dump_mutators`.

## Blueprint logic & aspect payloads (from the game files)

Aspect payloads (Hemorrhage ticks, Fire, Chain Lightning, Windburst, …) and most
blessing/charm/forge mechanics are implemented in Blueprints. `dump_kismet` is
`dump_mutators` with CUE4Parse's `ReadScriptData` switched on, so every
function's compiled bytecode is dumped alongside the class defaults:

```
dotnet run --project scripts/extract/dump_kismet -- <Paks> <usmap> list "<regex>"
dotnet run --project scripts/extract/dump_kismet -- <Paks> <usmap> dump "<regex>" <out>
python scripts/extract/kismet_pretty.py <out>/Blueprints/.../BP_X.uasset.json
```

`kismet_pretty.py` prints the class defaults, then each function as one line
of pseudo-code per statement, prefixed with its byte offset so jumps can be followed.

Where the numbers live:
- **Status-effect class defaults**, e.g. `BP_Bleed_StatusEffect`: `BaseDamage`,
  `TickScriptInterval`, `EffectDuration`.
- **Hidden per-aspect tuning** in `PA_<Aspect>GodPassive_CharacterMutator`'s
  `MutatorDescriptionVariables`. Index 0 is the blessing's visible number; the
  rest (`BaseDamage`, `DamagePercentage`, `DamageSoftCap`, …) are read by array
  index from Blueprints such as `BP_ApplyFire_Behavior_Mutator::GetDamageToDeal`.
- **Native C++ constructor defaults** (e.g. Chain Lightning's
  `ChainCount`/`Range` on `URBehaviorScriptLightning`) aren't in the pak. With
  the game running, read them from memory (read-only, no injection):
  `python scripts/extract/native_defaults.py <Dumper-7 dir> out.json <Class>...`.
  It needs a Dumper-7 dump of the same game build (for the GObjects offset and
  object indices) and verifies every object before decoding it. A Blueprint
  subclass's serialised CDO can still override a native value, so check it.

Findings per aspect: `docs/plans/kismet-spike-findings.md`.

### Aspect payloads -> data/aspects.json

```
1. dump_kismet "PrimaryAssets/(CharacterMutators|WeaponMutators|ProjectileMutators)" <out>
   dump_kismet "Blueprints/(StatusEffects_Generic|Mutators/|Player/EquippableAbilities/)" <out>
2. (game running, only after a game update)
   python scripts/extract/native_defaults.py <Dumper-7 dir> scripts/extract/native_defaults.json      RBehaviorScriptLightning RBehaviorScriptOcean RBehaviorScriptWind RBehaviorScriptBrine      RBehaviorScriptFortune RBehaviorScriptSpirit RBehaviorScriptDefender RBehaviorScriptBlood      RBehaviorScriptFrost RStatusEffectAilmentGScript RGBurningAilment ROceanGodTentacle RBaseWeaponSettings
3. python scripts/extract/aspect_payloads.py <out>
```
`native_defaults.json` is a committed snapshot, so step 3 runs without the game.
The numbers land in `data/aspects.json`; the formulas that combine them are in
`src/engine/payloads.ts`, each payload citing the Blueprint it was read from.
`weapon_mod_stats.py` also writes each fire mode's `procChance` (its multiplier
on aspect proc chances) from the same ModStats assets.
