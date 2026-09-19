# Abyssus Build Simulator

A static React app that estimates weapon/blessing/charm/ability build DPS for
[Abyssus](https://store.steampowered.com/app/1721110), so you can compare loadouts without
grinding them out in-game. It is a **build comparator, not a combat sim**: rate of
fire, clip size and reload time are nowhere in the wiki and are hand-estimated, and
plenty of text effects can't be expressed in the model at all (see
[Honesty conventions](#honesty-conventions)). Deployed to GitHub Pages from `main`
on every push (`.github/workflows/deploy.yml`).

This document is the map of the repo: what lives where, how data flows from the
game into the UI, and which invariants matter. `scripts/README.md` has the
step-by-step data-extraction commands; this file is everything around that.

## Quick start

```
npm install
npm run dev        # Vite dev server
npm test           # vitest
npm run validate   # tsx scripts/validate.ts -- schema-parses every data/*.json,
                    # prints codification coverage, fails on a silent gap
npm run build      # tsc -b && vite build -> dist/
```

There is nothing to configure — no backend, no env vars, no API keys. A "build"
is just a JSON object round-tripped through the URL hash (`src/ui/share.ts`), so
sharing a loadout is sharing a link.

## How data flows through the project

```
abyssus.wiki.gg              Abyssus.exe (running, injected)
      |                              |
      v                              v
scripts/extract/*.py      Dumper-7 -> .usmap -> dump_mutators (C#/CUE4Parse)
 (OCR card crops,                    |
  wikitext tables)                   v
      |                  scripts/extract/blessing_upgrades.py
      v                              |
data/*.json  <-----------------------+   ("effects": [] at this point --
      |                                   extractors don't write the DSL)
      v
scripts/codify.py            (prose description -> src/model/effects.ts DSL,
      |                       ordered-regex, ~50% coverage by design)
      v
scripts/link_blessing_upgrades.py   (links a blessing's effect leaves to the
      |                              upgrades[] rank variable that scales them)
      v
data/*.json                  (final, committed -- this is what ships)
      |
      v
src/model/*.ts                (zod schemas parse + validate data/*.json
      |                        at import time; throws immediately if malformed)
      v
src/engine/*.ts                (stacking.ts accumulates modifiers, blessingScaling.ts
      |                         rescales a blessing to its picked rank, simulate.ts
      |                         orchestrates one DPS number)
      v
src/ui/*.tsx                   (App.tsx owns Build state, BlessingBoard.tsx /
      |                         Results.tsx render it)
      v
src/ui/share.ts                 (Build <-> base64 JSON in the URL hash)
```

The two extraction pipelines feeding `data/*.json` are independent and run on
different cadences: the wiki scrapers (re-run after a wiki edit) and the
game-file dump (re-run only after a game update changes numbers — it needs the
game running and DLL injection, see `scripts/README.md`).

## Directory guide

```
data/*.json             Committed, generated game data. Never hand-edit; re-run
                         the producing script instead (see scripts/README.md).
                         Each file's top-level shape is validated by a zod schema
                         in src/model/data.ts.

public/                 Icons referenced by data/*.json `icon` fields (webp,
                         deduped by cropped-region hash -- see
                         scripts/README.md and the wiki-source memory for why
                         there are far fewer icon files than entries).

scripts/
  codify.py             Prose description -> effects[] DSL, ordered regex rules.
                         Run after any wiki re-extraction (extractors overwrite
                         effects: [] when they regenerate an entity).
  link_blessing_upgrades.py
                         Links effects[] leaves to the upgrades[] rank variable
                         that scales them, and locates each variable's rank-1
                         value inside `description` for live text rendering.
                         Pure data-massaging over data/blessings.json -- no
                         network or game access. Ambiguous matches are left
                         unlinked on purpose (see "Blessing ranks" below).
  validate.ts            npm run validate. Parses every data file against its
                         schema, reports codification coverage, fails the build
                         on an entity with neither effects nor an `unmodeled`
                         reason (a silent gap the UI couldn't badge).
  optimize_images.py     .png -> .webp, repoints icon paths.
  extract/               One script per wiki page/section (wiki.py holds the
                         shared HTTP helpers -- custom User-Agent required, the
                         wiki 403s a default one) plus dump_mutators/, a C#
                         CUE4Parse tool that reads Mutator (blessing) assets
                         straight out of the game's .pak. Its build output and
                         the Dumper-7 .usmap it needs are gitignored --
                         machine-specific, regenerable, see scripts/README.md.
  uncodified.txt          codify.py's coverage report: every entity it left
                         un-codified, for auditing which rules are worth adding.

src/model/               Types + zod schemas. No React, no engine logic.
  effects.ts             The effect DSL: a closed vocabulary (STATS / SCOPES /
                         TRIGGERS / CONDITIONS) of ops (mult, flat, applyStatus,
                         statusMod, stacking, proc, conditional, trigger) that
                         every blessing/charm/forge-upgrade/soul-skill's prose
                         gets translated into. Closed on purpose -- validate.ts
                         rejects anything outside it, which is what stops the
                         DSL decaying back into free text.
  data.ts                Parses all seven data/*.json files at import time
                         (throws on a schema mismatch) and exports typed
                         arrays/maps (`blessingById`, `blessingsByAspect`, ...)
                         plus blessing-rank helpers (`maxBlessingRank`,
                         `renderBlessingDescription`).
  build.ts               `Build`: the shape of one loadout (weapon, mode,
                         equipped aspects, blessing ranks, charms, forge
                         upgrades, soul skills). `SimOptions`: the player-
                         controlled assumptions (weakspot accuracy, stack
                         fullness, ...) that make a static build produce one
                         DPS number.

src/engine/               Pure functions, no React. Given a Build, produce a
                         SimResult.
  stacking.ts             `Modifiers` accumulator + `applyEffects`. THE central
                         assumption: multipliers on the same stat are additive,
                         different stats are multiplicative (three +15% damage
                         sources -> x1.45, not x1.52). Change here first if
                         numbers drift from in-game values.
  blessingScaling.ts       `scaleBlessingEffects(blessing, rank)`: rescales a
                         blessing's effects to a chosen rank via the ratio of
                         its baked rank-1 value to upgrades[].ranks[0] (handles
                         percent-as-fraction and negated effects generically).
                         `isFullyRankLinked`: whether every upgrade variable on
                         a blessing actually reached an effect leaf.
  simulate.ts              Orchestrator: walks a Build's picks, folds their
                         effects into one Modifiers, computes per-shot/DPS
                         numbers from the weapon mode's parsed damage
                         components. Returns unmodeled picks and warnings
                         alongside the number, never just the number.

src/ui/
  App.tsx                  Owns the one piece of state (`Build` + `SimOptions`),
                         wires every picker to it, decodes/encodes the URL hash.
  BlessingBoard.tsx         The primary/secondary/ability blessing board (mirrors
                         the in-game loadout screen): each column's own aspect
                         card is pinned and auto-equipped, additional blessings
                         are added/ranked/removed as tiles.
  Results.tsx               Renders a SimResult: DPS headline, stacked bar,
                         per-source contribution breakdown, unmodeled/warning
                         call-outs.
  share.ts                  Build <-> URL hash (base64 of JSON, validated
                         through buildSchema on decode).
  styles.css                One dark theme, CSS custom properties in :root.

.github/workflows/deploy.yml
                         Test -> validate -> build -> deploy to GitHub Pages on
                         push to main. The same three commands you'd run locally.
```

## Core concepts worth understanding before changing code

**The effect DSL is a closed, generic interpreter, not per-entity code.** Every
blessing, charm, forge upgrade and soul-skill description gets translated (by
`codify.py`, or by hand for the ~50% the regex rules don't cover) into a small
list of `effects[]` ops from `src/model/effects.ts`. `simulate.ts` and
`stacking.ts` know nothing about "Blood" or "Hemorrhage" specifically -- they
only walk the DSL. This is what makes the game data editable without touching
engine code, and what `validate.ts`'s closed vocabulary protects.

**An entity with no effects must say why.** `unmodeled: string` is required
whenever `effects: []` for something whose text genuinely can't be expressed
(an economy effect, a mechanic-changing effect like "the anchor is now
thrown"). `validate.ts` fails the build if an entity has neither -- that
combination would silently contribute nothing with no indication in the UI
(`.not-simulated` badge). Don't add a new codify.py rule "for coverage" if the
translation would be wrong; an honest `unmodeled` beats a wrong number.

**Blessing ranks (`build.blessings: Record<id, rank>`).** Blessings carry
per-rank scaling pulled from the game's own files (`upgrades[]`, see
`scripts/README.md`'s "Blessing upgrade values" section) -- something the wiki
doesn't publish at all. Nothing in `data/blessings.json` records *which*
`effects[]` leaf a given `upgrades[]` variable scales, though: `codify.py`
regexes the rendered rank-1 description, `blessing_upgrades.py` pulls ranks
from the game's Mutator assets, and neither script has ever seen the other's
output. `scripts/link_blessing_upgrades.py` derives that missing link purely
from the numbers already in the file (an effect leaf's value must equal a
variable's rank-1 value, either directly or divided by 100) and only commits a
link when it's unambiguous. A blessing can therefore be:
- **fully linked** (`isFullyRankLinked` true) -- picking a rank changes the
  simulated DPS;
- **partially/not linked** -- picking a rank still updates the rendered
  description text (`renderBlessingDescription`) but the simulated value stays
  at rank 1; the UI shows this with the same `.not-simulated` dotted-underline
  convention as an unmodeled pick, via a `(rank shown for reference...)` note.

Re-run `link_blessing_upgrades.py` any time `blessings.json`'s `effects` or
`upgrades` change (a `codify.py` rule edit, a re-dump from the game). It's
idempotent and non-destructive to unrelated fields.

**Stacking is additive-same-stat, multiplicative-cross-stat.** See
`stacking.ts`'s module doc. This is the one modeling assumption most likely to
need revisiting if a computed number disagrees with what you see in-game.

**`conditional`/`trigger` are resolved statically against `SimOptions`, not
simulated over time.** A conditional contributes fully when its condition
holds under the player's stated assumptions; a trigger contributes its inner
effect scaled by its chance. There is no time axis, no fight simulation loop --
this is deliberately a comparator, not a combat model.

## Testing & validation

- `npx vitest run` -- `src/engine/*.test.ts`. Covers modifier stacking rules,
  end-to-end `simulate()` cases per weapon/mode, blessing rank scaling, and a
  few data-integrity assertions (expected entity counts, every fire mode
  parsed, every entity has effects-or-unmodeled).
- `npm run validate` -- schema-parses every `data/*.json` (throws with a full
  zod diff on mismatch), prints codification coverage, fails on a silent gap
  or an unparsed fire mode.
- Both run in CI (`.github/workflows/deploy.yml`) before every deploy; a
  broken data file or failing test never reaches the published site.

There's no component-level UI test suite -- verify UI changes by running
`npm run dev` and driving the app (Playwright works well for this if you want
a scripted pass; see the git history around the blessing-rank-picker PR for an
example driver script).

## Honesty conventions

The whole data model is built around never presenting a number as more certain
than it is:
- `unmodeled: string` on anything `effects: []` couldn't capture -- badged
  `.not-simulated` in the UI.
- `estimated: true` on every weapon mode's fire rate / clip size / reload time
  -- the wiki publishes none of it; badged with a `*` and a footnote.
- The blessing-rank partial-link note above, for the same reason.
- `SimResult.warnings` for build-level issues (a blessing whose aspect isn't
  equipped, more than 3 forge upgrades selected, a second charm without the
  Charm Power soul skill, ...) rather than silently dropping or ignoring them.

When extending the model, keep this property: it should never be possible for
a pick to visibly exist in the build and silently contribute nothing without
the UI saying so somewhere.
