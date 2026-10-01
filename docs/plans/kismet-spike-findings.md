# Kismet spike: findings (2026-10-01)

**Verdict: success.** CUE4Parse decodes this game's Blueprint bytecode (UE 5.6) with
no failures (1,157 assets, 0 errors). We don't depend on the bytecode alone, though:
most aspect payload numbers turned out to be plain data that was never looked at.

## What changed vs. the earlier "not extractable" conclusion

1. **Status-effect Blueprints do have class defaults.** `BP_Bleed_StatusEffect` (Hemorrhage)
   carries `BaseDamage`, `WeaponDamagePercentPerTick`, `EffectDuration` and `TickScriptInterval`
   on its CDO. The 2026-09-21 check concluded otherwise; it most likely looked at the
   wrong class or loaded without the mappings.
2. **Each aspect has a hidden "GodPassive" Primary Asset** (`PA_<Aspect>GodPassive_CharacterMutator`).
   Its `MutatorDescriptionVariables` hold the payload formula's numbers. Only index 0 shows
   in the blessing text (e.g. Fire's Wrath's 10%); indices 1+ are undocumented tuning
   values that the Blueprints read by array index.
3. **The bytecode gives the formula** connecting those numbers. That's what the spike was for.

## Tooling (committed)
- `scripts/extract/dump_kismet/`: CUE4Parse with `ReadScriptData = true`.
  `list <regex>` / `dump <regex> <outDir>` over the pak; reuses the existing `.usmap`.
- `scripts/extract/kismet_pretty.py`: renders a dump as class defaults + one line of
  pseudo-code per bytecode statement (offset-prefixed, so jumps can be followed).

```
dotnet run --project scripts/extract/dump_kismet -- <Paks> <usmap> dump "Blueprints/(StatusEffects_Generic|Mutators/|Player/EquippableAbilities/)" <out>
dotnet run --project scripts/extract/dump_kismet -- <Paks> <usmap> dump "PrimaryAssets/(CharacterMutators|WeaponMutators|ProjectileMutators)" <out>
python scripts/extract/kismet_pretty.py <out>/Blueprints/.../BP_Bleed_StatusEffect.uasset.json
```

## Shared payload formula
Fire, Chain Lightning and Windburst (and Spirit, with its own indices) compute the
payload of one proc from the triggering hit's damage:

```
payload = BaseDamage + DamagePercentage% * min(hit, DamageSoftCap)
                     + DamagePercentagePostSoftCap% * max(0, hit - DamageSoftCap)
```
(Fire: `BP_ApplyFire_Behavior_Mutator::GetDamageToDeal`, reading `PA_FireGodPassive` indices 2–5.)

## Per-aspect results

| Aspect (internal name) | Numbers found | Formula/semantics | Confidence |
|---|---|---|---|
| Blood → Hemorrhage (`BP_Bleed_StatusEffect`) | BaseDamage 8, WeaponDamagePercentPerTick 2, tick 0.25 s, duration 4 s, DamageTakenMultiplierPercent 20 | per tick: `(8 + 2% × primary-mode damage) × (1 + target missing-health fraction)`; **each stack: target takes +20% damage** (undocumented) | high: formula read end to end |
| Fire (`BP_ApplyFire_Behavior_Mutator`, `BP_Burning_StatusEffect`) | GodPassive: base 50, 35% ≤ 500, 5% above; Burning: tick 1 s, duration 8 s, +2%/stack | Burning tick = trigger damage (largest seen) × (1 + 2% × stacks + passive bonuses) × capped(≤3) passive multiplier | high for numbers, medium for stack behaviour |
| Flare (`BP_Flare_StatusEffect`) | FlareChance 40, stun 2 s, threshold 10% max HP | flares on non-DoT hits to burning targets; detailed trigger logic still to read | medium |
| Chain Lightning (`BP_ChainLightning_Behavior_Mutator` → native `URBehaviorScriptLightning`) | GodPassive: base 100, 60% ≤ 500, 20% above; **native (live read): ChainCount 4, Range 2000, FalloffDamagePercent 20, BounceDelay 0.16 s, BounceCap 8, CritExtraBounceFalloff 0.25, DistanceDamageIncreasePerUnit 0.01** | payload hits the target, then chains up to 4 more targets within 2000 units, −20% per bounce; crit-extended chains up to 8 | high |
| Windburst (`BP_Windburst_Behavior_Mutator`) | GodPassive: base 100, 80% ≤ 500, 30% above; TimeBetweenWindbursts 0.75 s; minor/major radius ×1.4/×1.8; **native: WindburstRadius 350** | same payload formula | high for numbers |
| Tentacles (`BP_OceanGod_Tentacle`, `PA_Ocean_GodPassive`) | base 100, 25%; BaseAttackCooldown 2 s, range 5000; **native: TentacleLifeDuration 15 s, MaxTentacles 3** | up to 3 summons at once, each attacking every 2 s for 15 s | medium-high |
| Spirit (`BP_Spirit_Behavior_Mutator`, `PA_SpiritGodPassive`) | gauge 1000, cost 50 (+25% per spirit), orb base 50 + 20%, soft cap 500 / 5%; orbs every 0.25 s; secondary-fire variant 50% weapon damage, ability variant 75% health damage | gauge-driven; charge gained per hit still to locate | medium |
| Frozen (`BP_Chill_StatusEffect_Rework`, `BP_Frozen_StatusEffect_Rework`) | burst 10% / 5% / 3% max HP (normal/elite/boss); freeze threshold 50% / 20% / 10%; buildup cap 2000/5000/10000; min shred 1% | on freeze: % max-HP burst; buildup per hit still to locate | medium |
| Shadows (Abyss, `BP_Breach_StatusEffect`) | AllDamageTakenIncrease 25 (in the behaviour PA) | afflicted targets take +25% damage from everything; Breach also has explosions/ticks to read | medium |
| Goldburst (Fortune, `URBehaviorScriptFortune`) | GoldToDamageMultiplierPercentage 100; sphere radius 800 (only with a blessing; direct hit by default); RetriggerDelay 0.16 s | damage = current Gold x 100% to the struck enemy; formula is native code, **confirmed in-game 2026-10-01** | high |
| Brine (`BP_Brine_Behavior_Mutator`, `BP_BrineBall_*`) | 3 vials, VialCapacity 500, BounceExplosionBaseDamage 400, 1 bounce, radius 750 (BP overrides of native 200/0/0); **native: ExplosionTriggerDamagePercent 0.1, VialFillSpeed 1.0** | vials fill from damage dealt → Brine Ball | medium |
| Barrier (Defender, `PA_DefenderGodPassive`) | MaxGauge 2000, BarrierToGain 50, duration 10 s, cooldown 4 s | gauge fills from damage dealt → barrier up 10 s (gives the uptime for "while Barrier is active" blessings) | medium |

## Native C++ defaults: read from the running game
Values set in C++ constructors aren't in the pak. They are read live and read-only
(`ReadProcessMemory`, no injection) from each native class's `Default__` object, using the
GObjects offset and object indices from a Dumper-7 dump of the same build:

```
python scripts/extract/native_defaults.py C:/Dumper-7/5.6.1-0+UE5-RGame out.json RBehaviorScriptLightning RBehaviorScriptOcean ...
```
Each object's class pointer and index are checked before decoding. A Blueprint subclass
can still override a native value, so check its serialised CDO (only Brine's does,
among the aspect behaviours).

Still open: rates that depend on gameplay (gauge fill per hit for Spirit/Brine/Barrier,
freeze buildup per hit) need the logic around them read, not just numbers.

## Bonus: per-blessing logic is readable too
Every blessing has its own Blueprint (`BP_<Aspect>Passive<N>_CharacterMutator`) and PA,
so blessings marked "no numeric damage effect" can be implemented from their real
formulas, not prose. Example: Burning reads `PA_FirePassive5 {TickReductionPercentage}`
for Rapid Flames and `PA_FireMajorBlessing {MeteorDamage}` for Meteor. Charms and forge
upgrades follow the same pattern (`BP_MrBoom_CharacterMutator`, `BP_Shrapnel_StatusEffect`, …).

## Recommended next steps
1. Write `scripts/extract/aspect_payloads.py` to read the GodPassive / behaviour PAs and
   status-effect CDOs straight from a dump and write `data/aspects.json` (numbers only;
   formulas are encoded once in the engine, citing the Blueprint functions above).
2. Finish the per-aspect reading for the medium-confidence rows (stack rules, gauge
   fill, Flare trigger, Breach), working from the pretty-printed graphs.
3. ~~Chain Lightning native values~~: done via `native_defaults.py`.
4. Proceed with Phase 0 + Phase 2 of `dps-coverage.md`.
