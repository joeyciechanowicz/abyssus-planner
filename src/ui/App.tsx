import { useEffect, useMemo, useState } from 'react';
import {
  abilities,
  charms,
  sharedAbilityUpgrades,
  soulWheel,
  soulSkills,
  weapons,
  weaponById,
  abilityById,
} from '../model/data';
import { defaultOptions, emptyBuild, type Build, type SimOptions } from '../model/build';
import { simulate } from '../engine/simulate';
import { decodeBuild, encodeBuild } from './share';
import { Results } from './Results';
import { BlessingBoard } from './BlessingBoard';
import { Tooltip } from './Tooltip';
import { PLAYSTYLES, applyPlaystyle, detectPlaystyle, type Playstyle } from './playstyle';

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

export function App() {
  const [build, setBuild] = useState<Build>(
    () => decodeBuild(location.hash) ?? { ...emptyBuild, soulSkillIds: soulSkills.map((s) => s.id) },
  );
  const [opts, setOpts] = useState<SimOptions>(defaultOptions);
  const [soulWheelOpen, setSoulWheelOpen] = useState(false);
  const [pendingPlaystyle, setPendingPlaystyle] = useState<Playstyle | null>(null);

  useEffect(() => {
    history.replaceState(null, '', '#' + encodeBuild(build));
  }, [build]);

  const weapon = weaponById.get(build.weaponId)!;
  const mode = weapon.modes.find((m) => m.name === build.modeName)!;
  const weaveMode = build.weaveModeName
    ? weapon.modes.find((m) => m.name === build.weaveModeName)
    : undefined;
  // `modeName`/`weaveModeName` don't record which fire type is "main" --
  // whichever of the two currently matches a given type is displayed (and
  // edited) in that type's own selector, so the UI can offer clean
  // "Primary"/"Secondary" pickers without exposing the underlying main/weave
  // split.
  const primaryMode = mode.type === 'Primary' ? mode : weaveMode?.type === 'Primary' ? weaveMode : undefined;
  const secondaryMode = mode.type === 'Secondary' ? mode : weaveMode?.type === 'Secondary' ? weaveMode : undefined;
  const ability = build.abilityId ? abilityById.get(build.abilityId) : undefined;

  const setModeOfType = (type: 'Primary' | 'Secondary', newName: string) => {
    setPendingPlaystyle(null);
    const isMainCurrentlyThisType = mode.type === type;
    if (newName === '') {
      if (isMainCurrentlyThisType) {
        // Promote the other slot to main if there is one; otherwise this is
        // the only mode selected at all, so ignore -- a build always needs a
        // main fire mode.
        if (weaveMode) set({ modeName: weaveMode.name, weaveModeName: null });
        return;
      }
      set({ weaveModeName: null });
      return;
    }
    if (isMainCurrentlyThisType) set({ modeName: newName });
    else set({ weaveModeName: newName });
  };

  const result = useMemo(() => {
    try {
      return simulate(build, opts);
    } catch (err) {
      return err as Error;
    }
  }, [build, opts]);

  const set = (patch: Partial<Build>) => setBuild((b) => ({ ...b, ...patch }));

  return (
    <div className="app">
      <header>
        <h1>Abyssus Build Simulator</h1>
        <p className="disclaimer">
          Rough estimates for comparing builds &mdash; not game-accurate. Rate of fire, clip
          size and reload time are not published by the wiki and are estimated; effects the
          model can&rsquo;t express are listed as not simulated and contribute nothing.
        </p>
      </header>

      <div className="columns">
        <div className="loadout">
          <section>
            <h2>Weapon</h2>
            <select
              value={build.weaponId}
              onChange={(e) => {
                const w = weaponById.get(e.target.value)!;
                setPendingPlaystyle(null);
                set({
                  weaponId: w.id,
                  modeName: (w.modes.find((m) => m.type === 'Primary') ?? w.modes[0]).name,
                  weaveModeName: null,
                  weaponUpgrades: [],
                });
              }}
            >
              {weapons.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <div className="row">
              <label>Primary</label>
              <select value={primaryMode?.name ?? ''} onChange={(e) => setModeOfType('Primary', e.target.value)}>
                <option value="" disabled={mode.type === 'Primary' && !weaveMode}>
                  &mdash; none &mdash;
                </option>
                {weapon.modes
                  .filter((m) => m.type === 'Primary')
                  .map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name} ({m.damage})
                    </option>
                  ))}
              </select>
            </div>
            {primaryMode && <p className="hint">{primaryMode.special}</p>}

            <div className="row">
              <label>Secondary</label>
              <select value={secondaryMode?.name ?? ''} onChange={(e) => setModeOfType('Secondary', e.target.value)}>
                <option value="" disabled={mode.type === 'Secondary' && !weaveMode}>
                  &mdash; none &mdash;
                </option>
                {weapon.modes
                  .filter((m) => m.type === 'Secondary')
                  .map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name} ({m.damage})
                    </option>
                  ))}
              </select>
            </div>
            {secondaryMode && <p className="hint">{secondaryMode.special}</p>}

            {ability && (
              <div className="row">
                <label>Playstyle</label>
                <select
                  value={pendingPlaystyle ?? detectPlaystyle(build, opts, mode) ?? ''}
                  onChange={(e) => {
                    const id = e.target.value as Playstyle;
                    setPendingPlaystyle(id);
                    const { buildPatch, optsPatch } = applyPlaystyle(id, build, weapon, mode);
                    set(buildPatch);
                    setOpts((o) => ({ ...o, ...optsPatch }));
                  }}
                >
                  <option value="" disabled hidden>
                    Custom
                  </option>
                  {PLAYSTYLES.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {(() => {
              const activeId = pendingPlaystyle ?? detectPlaystyle(build, opts, mode);
              const chosen = PLAYSTYLES.find((p) => p.id === activeId);
              if (chosen?.requiresType && chosen.requiresType !== mode.type) {
                return <p className="hint">Pick a {chosen.requiresType} mode above to complete this playstyle.</p>;
              }
              return null;
            })()}

            {primaryMode && secondaryMode && (
              <p className="hint">
                Your build spends most of its time on one of these and occasionally switches to
                the other (e.g. to apply a blessing effect) &mdash; set the split with the rate
                slider under Assumptions.
              </p>
            )}
          </section>

          <BlessingBoard build={build} onChange={set} />

          <section>
            <h2>Forge Upgrades &mdash; weapon ({build.weaponUpgrades.length}/3)</h2>
            <ul className="picker">
              {weapon.forgeUpgrades.map((u) => (
                <li key={u.name}>
                  <Tooltip content={u.description}>
                    <label>
                      <input
                        type="checkbox"
                        checked={build.weaponUpgrades.includes(u.name)}
                        onChange={() => set({ weaponUpgrades: toggle(build.weaponUpgrades, u.name) })}
                      />
                      <span className={u.effects.length === 0 ? 'not-simulated' : ''}>{u.name}</span>
                    </label>
                  </Tooltip>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2>Ability</h2>
            <select
              value={build.abilityId ?? ''}
              onChange={(e) => set({ abilityId: e.target.value || null, abilityUpgrades: [] })}
            >
              <option value="">&mdash; none &mdash;</option>
              {abilities.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            {ability && (
              <>
                <p className="hint">{ability.notes}</p>
                <ul className="picker">
                  {[...ability.forgeUpgrades, ...sharedAbilityUpgrades].map((u) => (
                    <li key={u.name}>
                      <Tooltip content={u.description}>
                        <label>
                          <input
                            type="checkbox"
                            checked={build.abilityUpgrades.includes(u.name)}
                            onChange={() =>
                              set({ abilityUpgrades: toggle(build.abilityUpgrades, u.name) })
                            }
                          />
                          <span className={u.effects.length === 0 ? 'not-simulated' : ''}>
                            {u.name}
                          </span>
                        </label>
                      </Tooltip>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section>
            <h2>Charms ({build.charmIds.length})</h2>
            <ul className="picker">
              {charms.map((c) => (
                <li key={c.id}>
                  <Tooltip content={c.description}>
                    <label>
                      <input
                        type="checkbox"
                        checked={build.charmIds.includes(c.id)}
                        onChange={() => set({ charmIds: toggle(build.charmIds, c.id) })}
                      />
                      <span className={c.effects.length === 0 ? 'not-simulated' : ''}>
                        {c.name} <em>{c.rarity}</em>
                      </span>
                    </label>
                  </Tooltip>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <button
              type="button"
              className="section-toggle"
              onClick={() => setSoulWheelOpen((v) => !v)}
            >
              {soulWheelOpen ? '▾' : '▸'} Soul Wheel ({build.soulSkillIds.length}/{soulSkills.length})
            </button>
            {soulWheelOpen && soulWheel.map((row) => (
              <div key={row.row} className="soul-row">
                <h3>
                  Row {row.row} <span className="cost">{row.costPerPoint} fragments each</span>
                </h3>
                <ul className="picker">
                  {row.skills.map((s) => (
                    <li key={s.id}>
                      <Tooltip content={s.description}>
                        <label>
                          <input
                            type="checkbox"
                            checked={build.soulSkillIds.includes(s.id)}
                            onChange={() => set({ soulSkillIds: toggle(build.soulSkillIds, s.id) })}
                          />
                          <span className={s.effects.length === 0 ? 'not-simulated' : ''}>
                            {s.name}
                          </span>
                        </label>
                      </Tooltip>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        </div>

        <div className="results-col">
          <section className="assumptions">
            <h2>Assumptions</h2>
            {(
              [
                ['weakspotAccuracy', 'Weakspot hits'],
                ['accuracy', 'Shots that land'],
                ['stackFullness', 'Stacks built up'],
                ['chargeLevel', 'Charge level'],
                ['healthFraction', 'Your health'],
                ['targetHealthFraction', 'Target health'],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="slider">
                <label>
                  {label} <b>{Math.round(opts[key] * 100)}%</b>
                </label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={opts[key]}
                  onChange={(e) => setOpts({ ...opts, [key]: Number(e.target.value) })}
                />
              </div>
            ))}
            {weaveMode && (
              <div className="slider">
                <label>
                  {weaveMode.type} use rate <b>{Math.round(opts.weaveRate * 100)}%</b>
                </label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={opts.weaveRate}
                  onChange={(e) => setOpts({ ...opts, weaveRate: Number(e.target.value) })}
                />
              </div>
            )}
            {ability && (
              <div className="slider">
                <label>
                  Weapon uptime <b>{Math.round(opts.weaponUptime * 100)}%</b>
                </label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={opts.weaponUptime}
                  onChange={(e) => setOpts({ ...opts, weaponUptime: Number(e.target.value) })}
                />
              </div>
            )}
          </section>

          {result instanceof Error ? (
            <p className="error">{result.message}</p>
          ) : (
            <Results result={result} />
          )}
        </div>
      </div>
    </div>
  );
}
