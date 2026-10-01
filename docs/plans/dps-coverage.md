# Plan: count every pick in the DPS number

Goal: every blessing, charm, forge upgrade and soul skill that can affect damage
contributes to DPS. We make best efforts and assume an **ideal scenario** (e.g. Fan's
two side projectiles always hit). Picks with no damage effect at all (economy,
defence, mobility, pure crowd control) are classed as `utility` rather than as gaps.

Decisions made (2026-10-01):
- The ideal assumptions **replace** the current `defaultOptions`. The planner should be easy to use.
- The target scenario is a **toggle: Boss vs. Pack of 5**.

Baseline audit (446 picks): 182 fully counted, 15 partly counted, 15 with effects
the engine never reads, 234 `unmodeled`.

---

## Part A: Phase 0, ideal defaults + target toggle + miscoding fixes

### A1. Ideal defaults (`src/model/build.ts`)
- `defaultOptions` changes to: `accuracy: 1`, `stackFullness: 1`, `weakspotAccuracy`
  stays player-set (currently 0.5; ideal ≠ every shot is a weakspot unless the user says so;
  revisit), `healthFraction: 1`, `targetHealthFraction: 1` (see A3 for target-health averaging).
- Ramping effects ("up to X%") resolve to their maximum, and timed self-buffs are
  assumed to be always up. This is already true for `conditional`. `trigger`-wrapped
  buffs get an `uptime` interpretation instead of `chance` (see A4).
- Existing share links still decode: the options aren't part of `Build`, so links don't break.

### A2. Target toggle
- `SimOptions.target: 'boss' | 'pack'` (default `'boss'`?). It's exposed as a
  two-way switch in the Readout.
- Derived context passed to `applyEffects`:
  - `enemies`: 1 (boss) or 5 (pack). Used later for chains, bounces, areas and cones.
  - `isEliteOrBoss`: true for boss. Gates "damage to Elites & Bosses".
  - `isStandardEnemy`: true for pack. Gates "standard enemies only" effects.
- New conditions: `targetIsEliteOrBoss`, `targetIsStandard`. Add them to `CONDITIONS` and `conditionHolds`.
- In pack mode, DPS means total damage per second across all targets. Single-target
  weapon hits still hit one enemy. Area damage (the `explosion`/`aoe` components)
  hits all `enemies`. This needs an `aoe` marker on damage components (most already
  have kind `explosion`/`aoe`).

### A3. `SimResult.assumptions[]`
- `{ source, text }` entries collected while effects are applied (e.g. "Fan: both
  side projectiles assumed to hit", "Storm Belt: at 5/5 stacks").
- The Readout lists them, replacing the `.not-simulated` badge for anything now
  counted on an assumption.

### A4. Miscoding fixes (currently inflating weapon damage)
| Blessing | Now | Should be |
|---|---|---|
| Wind's Devastation | +damage/all per blessing | aoeSize (no effect until Phase 3 reads aoeSize) |
| Mutagenic Brine | +damage/all per blessing | aoeDamage per blessing |
| Critical Flares | +20% damage/all | Flare payload, weakspot-caused only |
| Empowering Flames | +5% damage/all | Fire DoT ramp |
| Thawing Strike | +100% damage/all | melee only |
| Frost's Knowledge | +5%/blessing damage/all | gated by `targetIsEliteOrBoss` |
| Frozen Shards | 2% of hit damage | 2% of enemy current HP on kill (Phase 3 `percentHealthDamage`) |
| Barraging Spirits | +100% and +1% | +100% (ramp max), Spirit payload |
| Magnetic Brine, Growing Spirits, Spiritual Exchange, Eye of the Storm, Storm Belt, Dazing Barrier | weapon damage/all | their aspect's payload scope (Phase 2) |

Until Phase 2 adds payload scopes, the payload-scoped ones become `unmodeled` with
reason "awaits aspect payload model". An honest gap beats an inflated number.
Fix these in `codify.py` rules (or hand overrides), not by hand-editing JSON.

### A5. Tests
- Snapshot DPS for ~6 reference builds before and after, so the change in the totals is visible.
- A scope-leak test: none of the A4 blessings may move weapon `damage`.
- Boss/pack toggle: an Elite-gated blessing only counts in boss mode; area damage is ×5 in pack mode.

---

## Part B: the Kismet spike (aspect payload magnitudes)

> **Done 2026-10-01: success.** See `kismet-spike-findings.md`. Most numbers are in
> hidden GodPassive PAs and status-effect class defaults; the bytecode supplies the
> formulas. Chain Lightning's bounce count/range are native C++ values and still need a source.

### Why
The 11 aspect payloads (Hemorrhage, Fire/Flare, Goldburst, Chain Lightning, Shadows,
Tentacle, Windburst, Freeze, Spirit, Brine Ball, Barrier) have no base damage in our
data. About 190 blessings depend on them. Their Blueprint classes have no
class-default properties (checked 2026-09-21), so the numbers are likely constants
inside compiled Blueprint bytecode ("Kismet").

### Question to answer (time-box: one session)
Can CUE4Parse decode Kismet bytecode for this UE 5.6 game well enough to recover each
payload's base damage, tick rate, duration and scaling formula?

### Steps
1. **Locate the assets.** List every `.uasset` whose path matches
   `StatusEffect|Hemorrhage|Burn|Fire|Flare|Goldburst|Lightning|Shadow|Tentacle|Wind|Freeze|Frost|Spirit|Brine|Barrier`,
   plus anything referenced by the aspect blessings' `PA_*_CharacterMutator`
   assets (follow their class/object references).
2. **Dump with bytecode.** Add a `kismet <pattern>` mode to `dump_mutators`
   (or a sibling tool) that loads matching packages with script data enabled and
   serialises each `UFunction`'s `ScriptBytecode` (CUE4Parse `KismetExpression` tree) to JSON.
3. **Extract the constants.** Walk the expression trees for float/int/double constants
   and record the call each one is passed to (`ApplyDamage`, `SetTimer`, `Delay`,
   `MakeGameplayEffectSpec`, a curve/data-table lookup, …). Also capture referenced
   DataTables/CurveTables; if found, dump those too (that's the easy path).
4. **Interpret per aspect.** For each payload write down base damage, tick interval,
   duration, max stacks, what it scales from (flat / % of hit / gold / max HP) and
   how confident we are, with the evidence (function name + constant).
5. **Record** findings in `data/aspects.json` (draft schema below), each value
   tagged `source: 'kismet' | 'measured' | 'estimated'`.

### Draft `data/aspects.json` entry
```json
{
  "id": "hemorrhage", "aspect": "Blood", "kind": "dot",
  "damage": { "value": 10, "per": "tick", "of": "flat", "source": "kismet" },
  "tickInterval": 0.5, "duration": 5, "maxStacks": 1,
  "evidence": "BP_Hemorrhage_StatusEffect::ExecuteUbergraph ApplyDamage(…, 10.0)"
}
```

### Outcomes
- **Success:** real numbers, then go on to Phase 2 (payload engine).
- **Partial:** decoded aspects use Kismet values; the rest get measured in-game.
- **Failure** (decoding crashes or is unreadable): write down why, then fall back to
  in-game measurement (`data/measured.json`) or `estimated: true`.

### Constraints
- Read-only on the `.pak`. The game doesn't need to run: the existing mappings are at
  `C:\Dumper-7\5.6.1-0+UE5-RGame\Mappings\5.6.1-0+UE5-RGame.usmap`.
- Raw dumps go in a scratch directory, never committed. Only `data/aspects.json` and
  the tool change are committed.

---

## Progress
- 2026-10-01: Phase 0 done (ideal defaults, Boss/Pack toggle, assumptions panel, ~40 leaking
  blessings fixed). Hand-authored effects moved to `scripts/effect_overrides.json`.
- 2026-10-01: Phase 2a done: payloads for Hemorrhage, Fire burn, Chain Lightning, Windburst,
  Tentacles, Shadows; per-mode `procChance`. Goldburst added (hits for current Gold,
  confirmed in-game; new Gold setting). The per-mode proc multiplier was confirmed in-game too.
  Still to do: Frozen (buildup), Spirit/Brine/Barrier (gauges), Flares, and
  re-modelling the payload-scoped blessings that Phase 0 marked unmodeled (Phase 2b).

## Later phases (unchanged from the earlier proposal)
- Phase 1b: merge forge-upgrade `MutatorDescriptionVariables` (unstated magnitudes).
- Phase 2: aspect payload engine + per-payload scopes, statusEffectiveness/duration, crit → weakspot.
- Phase 3: DSL ops: projectiles, retrigger, bounce/extraTargets, percentHealthDamage,
  execute, ammoRefund, scalesWithResource, enemyVulnerability, aoeSize.
- Phase 4: real ability cooldowns, plus weapon/ability mechanics (heat, Shortbow, Turret, …).
- Phase 5: `utility` vs. gap classification in `validate.ts` and the UI.
