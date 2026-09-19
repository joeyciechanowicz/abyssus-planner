import { useEffect, useMemo, useState } from 'react';
import {
  abilities,
  charms,
  sharedAbilityUpgrades,
  soulWheel,
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

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

export function App() {
  const [build, setBuild] = useState<Build>(() => decodeBuild(location.hash) ?? emptyBuild);
  const [opts, setOpts] = useState<SimOptions>(defaultOptions);

  useEffect(() => {
    history.replaceState(null, '', '#' + encodeBuild(build));
  }, [build]);

  const weapon = weaponById.get(build.weaponId)!;
  const mode = weapon.modes.find((m) => m.name === build.modeName)!;
  const ability = build.abilityId ? abilityById.get(build.abilityId) : undefined;

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
                set({
                  weaponId: w.id,
                  modeName: w.modes[0].name,
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
            <select
              value={build.modeName}
              onChange={(e) => {
                const newMode = weapon.modes.find((m) => m.name === e.target.value)!;
                const weaveMode = weapon.modes.find((m) => m.name === build.weaveModeName);
                const patch: Partial<Build> = { modeName: newMode.name };
                if (weaveMode && weaveMode.type === newMode.type) patch.weaveModeName = null;
                set(patch);
              }}
            >
              {weapon.modes.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.type}: {m.name} ({m.damage})
                </option>
              ))}
            </select>
            <p className="hint">{mode.special}</p>

            <div className="row">
              <label>Weave in</label>
              <select
                value={build.weaveModeName ?? ''}
                onChange={(e) => set({ weaveModeName: e.target.value || null })}
              >
                <option value="">&mdash; no weave &mdash;</option>
                {weapon.modes
                  .filter((m) => m.type !== mode.type)
                  .map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.type}: {m.name} ({m.damage})
                    </option>
                  ))}
              </select>
            </div>
            <p className="hint">
              Occasionally fire this mode too (e.g. to apply a blessing effect), then return to
              your main mode above.
            </p>
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
            <h2>Soul Wheel</h2>
            {soulWheel.map((row) => (
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
            {build.weaveModeName && (
              <div className="slider">
                <label>
                  Weave-in rate <b>{Math.round(opts.weaveRate * 100)}%</b>
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
