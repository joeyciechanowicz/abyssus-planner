import { useState } from 'react';
import type { SimResult } from '../engine/simulate';
import type { SimOptions } from '../model/build';
import { soulSkills } from '../model/data';
import { PLAYSTYLES, type Playstyle } from './playstyle';
import { fmt, statLabel } from './theme';

const soulSkillNames = new Set(soulSkills.map((s) => s.name));
const TOP = 8;

const SLIDERS = [
  ['accuracy', 'Shots that land'],
  ['weakspotAccuracy', 'Weakspot hits'],
  ['stackFullness', 'Stacks built up'],
  ['chargeLevel', 'Charge level'],
  ['healthFraction', 'Your health'],
  ['targetHealthFraction', 'Target health'],
] as const;

/** The big number and the parts that explain it. */
export function DpsSummary({ result }: { result: SimResult }) {
  const parts = [
    result.weave
      ? { label: result.mode.name, value: result.weaponDps - result.weave.weaponDps, cls: 'c-main' }
      : { label: result.mode.name, value: result.weaponDps, cls: 'c-main' },
    result.weave && {
      label: `${result.weave.modeName} (${Math.round(result.weave.rate * 100)}% of shots)`,
      value: result.weave.weaponDps,
      cls: 'c-weave',
    },
    { label: 'Damage over time', value: result.dotDps, cls: 'c-dot' },
    { label: 'Ability', value: result.abilityDps, cls: 'c-ability' },
  ].filter((p): p is { label: string; value: number; cls: string } => !!p && p.value > 0);

  const est = result.usesEstimates ? ' *' : '';
  const stats: [string, string][] = [
    ['Per hit', fmt(result.perHit)],
    ['Per shot', fmt(result.perShot)],
    ['Per magazine', fmt(result.perMagazine)],
    ['Fire rate', `${result.stats.fireRate.toFixed(1)}/s${est}`],
    ['Clip, reload', `${result.stats.clipSize ?? '—'}, ${result.stats.reloadTime.toFixed(1)}s${est}`],
    ['Damage multiplier', `×${result.stats.damageMultiplier.toFixed(2)}`],
    ['Weakspot multiplier', `×${result.stats.weakspotMultiplier.toFixed(2)}`],
  ];

  return (
    <section className="panel dps" aria-label="Damage per second">
      <span className="sub">Damage per second</span>
      <output className="num dps-value">{fmt(result.totalDps)}</output>
      <div className="dps-bar" aria-hidden>
        {parts.map((p) => (
          <span key={p.label} className={p.cls} style={{ width: `${(100 * p.value) / result.totalDps}%` }} />
        ))}
      </div>
      <ul className="dps-parts">
        {parts.map((p) => (
          <li key={p.label}>
            <i className={p.cls} />
            <span>{p.label}</span>
            <span className="num">{fmt(p.value)}</span>
          </li>
        ))}
      </ul>
      <dl className="stat-list">
        {stats.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className="num">{v}</dd>
          </div>
        ))}
      </dl>
      {(result.weave || result.weaponUptime < 1) && (
        <p className="sub small">
          Per-hit numbers and multipliers are for {result.mode.name} only.
          {result.weaponUptime < 1 && <> Weapon damage is scaled to {Math.round(result.weaponUptime * 100)}% weapon uptime.</>}
        </p>
      )}
      {result.usesEstimates && <p className="sub small">* Estimated. This fire mode's rate and reload aren't in the game data yet.</p>}
    </section>
  );
}

interface PlayProps {
  opts: SimOptions;
  setOpts: (o: SimOptions) => void;
  weaveLabel?: string;
  hasAbility: boolean;
  playstyle: Playstyle | null;
  onPlaystyle: (p: Playstyle) => void;
  playstyleHint?: string;
}

export function HowYouPlay({ opts, setOpts, weaveLabel, hasAbility, playstyle, onPlaystyle, playstyleHint }: PlayProps) {
  const sliders: (readonly [keyof SimOptions, string])[] = [...SLIDERS];
  if (weaveLabel) sliders.push(['weaveRate', `${weaveLabel} share`]);
  if (hasAbility) sliders.push(['weaponUptime', 'Time spent shooting']);

  return (
    <section className="panel play" aria-label="How you play">
      <h2>How you play</h2>
      {hasAbility && (
        <label className="field">
          <span>Playstyle</span>
          <select value={playstyle ?? ''} onChange={(e) => onPlaystyle(e.target.value as Playstyle)}>
            <option value="" disabled hidden>
              Custom
            </option>
            {PLAYSTYLES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {playstyleHint && <p className="sub small">{playstyleHint}</p>}
      {sliders.map(([key, label]) => (
        <label key={key} className="slider">
          <span className="slider-head">
            <span className="sub">{label}</span>
            <span className="num">{Math.round(opts[key] * 100)}%</span>
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={opts[key]}
            onChange={(e) => setOpts({ ...opts, [key]: Number(e.target.value) })}
          />
        </label>
      ))}
    </section>
  );
}

export function Contributors({ result }: { result: SimResult }) {
  const [all, setAll] = useState(false);
  // Percentage modifiers first, biggest first; flat bonuses (health, charges) after.
  const rows = [...result.breakdown].sort(
    (a, b) => Number(a.scope === 'flat') - Number(b.scope === 'flat') || b.value - a.value,
  );
  if (rows.length === 0) return null;
  const shown = all ? rows : rows.slice(0, TOP);

  return (
    <section className="panel contrib" aria-label="Biggest contributors">
      <h2>Biggest contributors</h2>
      <ul>
        {shown.map((b, i) => (
          <li key={i}>
            <span className="name">{b.source}</span>
            <span className={`num ${b.value >= 0 ? 'pos' : 'neg'}`}>
              {b.scope === 'flat'
                ? `${b.value >= 0 ? '+' : ''}${b.value}`
                : `${b.value >= 0 ? '+' : ''}${Math.round(b.value * 1000) / 10}%`}
            </span>
            <span className="sub">{statLabel(b.stat, b.scope)}</span>
          </li>
        ))}
      </ul>
      {rows.length > TOP && (
        <button type="button" className="link-btn" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </section>
  );
}

export function NotCounted({ result }: { result: SimResult }) {
  const picks = result.unmodeled.filter((u) => !soulSkillNames.has(u.name));
  const soul = result.unmodeled.length - picks.length;
  if (result.unmodeled.length === 0 && result.warnings.length === 0) return null;

  return (
    <section className="panel not-counted" aria-label="Not counted in DPS">
      <h2>Not counted in DPS</h2>
      {picks.length > 0 && (
        <>
          <p className="sub">These picks are in your build, but the simulator can't model their effect yet.</p>
          <ul className="chips">
            {picks.map((u) => (
              <li key={u.name} className="cham" title={u.reason}>
                {u.name}
              </li>
            ))}
          </ul>
        </>
      )}
      {soul > 0 && <p className="sub small">{picks.length > 0 ? 'Plus' : 'Only'} {soul} Soul Wheel skills with no damage effect.</p>}
      {result.warnings.length > 0 && (
        <ul className="warnings">
          {result.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
