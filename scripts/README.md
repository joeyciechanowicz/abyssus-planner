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

2. codify     python scripts/codify.py

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
