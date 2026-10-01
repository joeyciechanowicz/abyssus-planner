"""Write data/aspects.json: each aspect's payload numbers, from the game files.

An aspect card ("Primary Fire ... has a 20% chance to cause Hemorrhage") deals
its damage through a payload -- a DoT, a chained burst, a summon -- whose
numbers the card text never states. They live in three places, all read here:

  1. the hidden `PA_<Aspect>GodPassive_CharacterMutator` variables (indices 1+
     are undocumented tuning: BaseDamage, DamagePercentage, DamageSoftCap, ...),
     and the aspect behaviour PAs (`PA_<Aspect>_Behavior_*`);
  2. status-effect Blueprint class defaults (`BP_Bleed_StatusEffect`, ...);
  3. native C++ constructor defaults, snapshotted from the running game into
     scripts/extract/native_defaults.json by native_defaults.py.

How the numbers combine (the formulas) was read from the Blueprint bytecode and
is encoded once in src/engine/payloads.ts; each entry's `evidence` names the
Blueprint function it came from. See docs/plans/kismet-spike-findings.md.

Usage: python scripts/extract/aspect_payloads.py <dump_kismet out dir>
       (the dir holding PrimaryAssets/** and Blueprints/** .uasset.json files)
"""
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from wiki import DATA, write_json  # noqa: E402


def load_exports(dump, name):
    hits = glob.glob(os.path.join(dump, '**', name + '.uasset.json'), recursive=True)
    if len(hits) != 1:
        sys.exit(f'expected exactly one {name} in the dump, found {len(hits)}')
    with open(hits[0], encoding='utf-8') as f:
        return json.load(f)


def pa_vars(dump, name):
    """{VariableName: rank-1 value} of a mutator PA."""
    for e in load_exports(dump, name):
        props = e.get('Properties') or {}
        if 'MutatorDescriptionVariables' in props:
            return {v['VariableName']: v['RankValues'][0] for v in props['MutatorDescriptionVariables']}
    sys.exit(f'{name} has no MutatorDescriptionVariables')


def cdo(dump, name):
    """Serialised class-default properties of a Blueprint."""
    for e in load_exports(dump, name):
        if e.get('Name', '').startswith('Default__'):
            return e.get('Properties') or {}
    sys.exit(f'{name} has no class default object')


def mutable(v):
    """FRMutableFloat/Integer as serialised -> its base value."""
    return v['Value'] if isinstance(v, dict) else v


def scaled_hit(gp):
    """The shared 'payload from the triggering hit' formula's inputs."""
    return {
        'base': gp['{BaseDamage}'],
        'percent': gp['{DamagePercentage}'],
        'softCap': gp['{DamageSoftCap}'],
        'percentAboveCap': gp['{DamagePercentagePostSoftCap}'],
    }


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    dump = sys.argv[1]
    with open(os.path.join(HERE, 'native_defaults.json'), encoding='utf-8') as f:
        native = json.load(f)
    ailment = native['RStatusEffectAilmentGScript']

    bleed = cdo(dump, 'BP_Bleed_StatusEffect')
    burning = cdo(dump, 'BP_Burning_StatusEffect')
    fire_gp = pa_vars(dump, 'PA_FireGodPassive_CharacterMutator')
    lightning_gp = pa_vars(dump, 'PA_LightningGodPassive_CharacterMutator')
    lightning = native['RBehaviorScriptLightning']
    wind_gp = pa_vars(dump, 'PA_WindGodPassive_CharacterMutator')
    tentacle_bp = cdo(dump, 'BP_OceanGod_Tentacle')
    ocean_gp = pa_vars(dump, 'PA_Ocean_GodPassive_CharacterMutator')
    ocean = native['RBehaviorScriptOcean']
    abyss = pa_vars(dump, 'PA_Abyss_Behavior_Ability_Mutator')
    fortune_gp = pa_vars(dump, 'PA_Fortune_GodPassive_CharacterMutator')
    frost_gp = pa_vars(dump, 'PA_FrostGodPassive_CharacterMutator')
    fortune = native['RBehaviorScriptFortune']

    payloads = [
        {
            'id': 'hemorrhage',
            'aspect': 'Blood',
            'kind': 'dot',
            'name': 'Hemorrhage',
            # per tick: (BaseDamage + WeaponDamagePercentPerTick% of the PRIMARY
            # mode's damage) x (1 + target's missing-health fraction)
            'tickBase': bleed['BaseDamage'],
            'tickPercentOfPrimaryDamage': bleed['WeaponDamagePercentPerTick'],
            'scalesWithTargetMissingHealth': True,
            'tickInterval': bleed['TickScriptInterval'],
            'duration': mutable(bleed['EffectDuration']),
            'maxStacks': bleed.get('MaxStackCount', ailment['MaxStackCount']),
            'damageTakenPercentPerStack': bleed['DamageTakenMultiplierPercent'],
            'evidence': 'BP_Bleed_StatusEffect: UpdateBaseDamage, K2_TickScript, SetDamageTakenMultiplier',
        },
        {
            'id': 'burn',
            'aspect': 'Flares',
            'kind': 'dot',
            'name': 'Fire',
            # per tick: the trigger damage (scaled-hit formula), x(1 + 2% per stack)
            'trigger': scaled_hit(fire_gp),
            'tickInterval': burning['TickScriptInterval'],
            'duration': mutable(burning['EffectDuration']),
            'maxStacks': 1,  # Fire only stacks with the Stacking Flames capstone
            'damagePercentPerStack': burning['DamageIncreasePerStack'],
            'evidence': 'BP_ApplyFire_Behavior_Mutator::GetDamageToDeal (PA_FireGodPassive[2..5]); '
                        'BP_Burning_StatusEffect tick',
        },
        {
            'id': 'chainLightning',
            'aspect': 'Chain Lightning',
            'kind': 'chain',
            'name': 'Chain Lightning',
            'trigger': scaled_hit(lightning_gp),
            'chainCount': lightning['ChainCount'],
            'falloffPercent': lightning['FalloffDamagePercent'],
            'range': lightning['Range'],
            'evidence': 'BP_ChainLightning_Behavior_Mutator::GetDamageToDeal (PA_LightningGodPassive[2..5]); '
                        'URBehaviorScriptLightning native defaults (live read)',
        },
        {
            'id': 'windburst',
            'aspect': 'Windburst',
            'kind': 'burst',
            'name': 'Windburst',
            # hits every enemy inside the radius for the full payload
            'trigger': scaled_hit(wind_gp),
            'radius': native['RBehaviorScriptWind']['WindburstRadius'],
            'evidence': 'BP_Windburst_Behavior_Mutator::FireWindburstLoop (PA_WindGodPassive[2..5]); '
                        'URBehaviorScriptWind native defaults (live read)',
        },
        {
            'id': 'tentacle',
            'aspect': 'Tentacles',
            'kind': 'summon',
            'name': 'Tentacle',
            # each attack: native base Damage + DamagePercentage% of the hit that spawned it
            'attackBase': native['ROceanGodTentacle']['Damage'],
            'attackPercentOfTrigger': ocean_gp['{DamagePercentage}'],
            'attackInterval': tentacle_bp['BaseAttackCooldown'],
            'lifetime': ocean['TentacleLifeDuration'],
            'maxActive': ocean['MaxTentacles'],
            'evidence': 'BP_Ocean_GodPassive_CharacterMutatorScript (Damage += TriggerDamage x {DamagePercentage}); '
                        'BP_OceanGod_Tentacle BaseAttackCooldown; ROceanGodTentacle/URBehaviorScriptOcean native defaults',
        },
        {
            'id': 'frost',
            'aspect': 'Frozen',
            'kind': 'freeze',
            'name': 'Freeze',
            # Hits add Frost buildup (natively, from the hit's damage). At
            # min(threshold% x max Health, cap) the enemy Freezes and takes
            # max(minShred% x max Health, shred% x current Health); buildup is
            # blocked while Frozen.
            'thresholdPercent': {
                'standard': frost_gp['{NormalEnemyFrostBuildupThreasholdPercentage}'],
                'elite': frost_gp['{EliteEnemyFrostBuildupThreasholdPercentage}'],
                'boss': frost_gp['{BossEnemyFrostBuildupThreasholdPercentage}'],
            },
            'thresholdCap': {
                'standard': frost_gp['{NormalFrostBuildupHardcap}'],
                'elite': frost_gp['{EliteFrostBuildupHardcap}'],
                'boss': frost_gp['{BossFrostBuildupHardcap}'],
            },
            'shredPercentOfCurrent': {
                'standard': frost_gp['{NormalEnemyHealthPercentageBurstDamage}'],
                'elite': frost_gp['{EliteEnemyHealthPercentageBurstDamage}'],
                'boss': frost_gp['{BossEnemyHealthPercentageBurstDamage}'],
            },
            'minShredPercentOfMax': frost_gp['{MinimumMaxHpShredPercent}'],
            'freezeDuration': ailment['EffectDuration'],
            'evidence': 'BP_Chill_StatusEffect_Rework (SetMaxStackCount from GetFrostbuildupPercentage/'
                        'GetMaxFrostBuildup; shred = FMax(min% x MaxHealth, shred% x CurrentHealth)); '
                        'PA_FrostGodPassive[2..11]; Frozen duration = native ailment default',
        },
        {
            'id': 'goldburst',
            'aspect': 'Goldburst',
            'kind': 'gold',
            'name': 'Goldburst',
            # Damage is computed natively; the formula (damage = current Gold x
            # GoldToDamageMultiplierPercentage%) was confirmed in-game 2026-10-01.
            # It hits the struck enemy only, unless a blessing switches it to a sphere.
            'goldPercent': fortune_gp['{GoldToDamageMultiplierPercentage}'],
            'sphereRadius': fortune['SphereRadius'],
            'evidence': 'PA_Fortune_GodPassive {GoldToDamageMultiplierPercentage}; URBehaviorScriptFortune '
                        '(bNativeUsingSphereInsteadOfDirectHit false by default); formula confirmed in-game',
        },
        {
            'id': 'shadows',
            'aspect': 'Shadows',
            'kind': 'vulnerability',
            'name': 'Shadows',
            'damageTakenPercent': abyss['{AllDamageTakenIncrease}'],
            'evidence': 'BP_Breach_StatusEffect::UpdateAllDamageTakenIncreaseMultiplier '
                        '(PA_Abyss_Behavior_Ability_Mutator[1])',
        },
    ]

    doc = {
        'source': 'game files: GodPassive/behaviour PAs, status-effect CDOs, native defaults '
                  '(scripts/extract/aspect_payloads.py)',
        'payloads': payloads,
    }
    write_json(os.path.join(DATA, 'aspects.json'), doc)


if __name__ == '__main__':
    main()
