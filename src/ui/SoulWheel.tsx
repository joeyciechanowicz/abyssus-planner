import { soulSkills, soulWheel } from '../model/data';
import type { Build } from '../model/build';
import { Tooltip } from './Tooltip';
import { asset } from './theme';

interface Props {
  build: Build;
  set: (patch: Partial<Build>) => void;
}

/** The seven Soul Wheel tiers as rows of toggleable skills. */
export function SoulWheel({ build, set }: Props) {
  const owned = new Set(build.soulSkillIds);
  const spent = soulWheel.reduce(
    (sum, row) => sum + row.skills.filter((s) => owned.has(s.id)).length * row.costPerPoint,
    0,
  );
  const toggle = (id: string) =>
    set({ soulSkillIds: owned.has(id) ? build.soulSkillIds.filter((x) => x !== id) : [...build.soulSkillIds, id] });

  return (
    <section className="panel soul" aria-label="Soul Wheel">
      <div className="section-head">
        <h2>Soul Wheel</h2>
        <span className="num sub">
          {owned.size} of {soulSkills.length}, {spent.toLocaleString()} fragments
        </span>
        <span className="soul-actions">
          <button type="button" className="btn ghost small" onClick={() => set({ soulSkillIds: soulSkills.map((s) => s.id) })}>
            Select all
          </button>
          <button type="button" className="btn ghost small" onClick={() => set({ soulSkillIds: [] })}>
            Clear
          </button>
        </span>
      </div>
      <p className="legend sub">
        <span><i className="key damage" /> Affects damage</span>
        <span><i className="key utility" /> Utility only</span>
      </p>
      <div className="tiers">
        {soulWheel.map((row) => (
          <div key={row.row} className="tier">
            <span className="num sub">
              Tier {row.row} <span className="faint">· {row.costPerPoint} each</span>
            </span>
            <div className="tier-skills">
              {row.skills.map((s) => {
                const on = owned.has(s.id);
                const damage = s.effects.length > 0;
                return (
                  <Tooltip key={s.id} content={<><b>{s.name}</b><br />{s.description}</>}>
                    <button
                      type="button"
                      className={`skill cham${on ? ' on' : ''}${damage ? ' damage' : ''}`}
                      aria-pressed={on}
                      aria-label={s.name}
                      onClick={() => toggle(s.id)}
                    >
                      {s.icon && <img src={asset(s.icon)!} alt="" />}
                    </button>
                  </Tooltip>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
