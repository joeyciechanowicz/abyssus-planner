import { useState } from 'react';
import {
  aspects,
  blessingById,
  blessingsByAspect,
  maxBlessingRank,
  renderBlessingDescription,
  type Blessing,
} from '../model/data';
import { isFullyRankLinked } from '../engine/blessingScaling';
import type { Build } from '../model/build';
import { Tooltip } from './Tooltip';

const SLOTS = ['primary', 'secondary', 'ability'] as const;
type Slot = (typeof SLOTS)[number];

const SLOT_LABELS: Record<Slot, string> = {
  primary: 'Primary',
  secondary: 'Secondary',
  ability: 'Ability',
};

function iconSrc(icon: string | null | undefined): string | null {
  return icon ? `${import.meta.env.BASE_URL}${icon}` : null;
}

interface Props {
  build: Build;
  onChange: (patch: Partial<Build>) => void;
}

/** The 3-column primary/secondary/ability loadout board, modeled on the in-game
 * screen: each column's own aspect card sits pinned at the top, with the
 * player's chosen blessings for that aspect stacked below it as rankable tiles. */
export function BlessingBoard({ build, onChange }: Props) {
  const [addingTo, setAddingTo] = useState<Slot | null>(null);

  function setAspect(slot: Slot, aspect: string | null) {
    const nextAspects = { ...build.aspects, [slot]: aspect };
    const stillEquipped = new Set(Object.values(nextAspects).filter(Boolean) as string[]);

    // Drop any equipped blessing whose aspect no longer occupies any slot.
    const nextBlessings: Record<string, number> = {};
    for (const [id, rank] of Object.entries(build.blessings)) {
      const b = blessingById.get(id);
      if (b && stillEquipped.has(b.aspect)) nextBlessings[id] = rank;
    }
    // The new aspect's own card for this slot equips itself automatically.
    if (aspect) {
      const card = blessingsByAspect
        .get(aspect)
        ?.find((b) => b.kind === 'aspect' && b.slot === slot);
      if (card) nextBlessings[card.id] = nextBlessings[card.id] ?? 1;
    }
    onChange({ aspects: nextAspects, blessings: nextBlessings });
  }

  function setRank(id: string, rank: number) {
    onChange({ blessings: { ...build.blessings, [id]: rank } });
  }

  function remove(id: string) {
    const next = { ...build.blessings };
    delete next[id];
    onChange({ blessings: next });
  }

  function add(id: string) {
    onChange({ blessings: { ...build.blessings, [id]: 1 } });
    setAddingTo(null);
  }

  return (
    <section className="blessing-board">
      <h2>Blessings</h2>
      <div className="board-columns">
        {SLOTS.map((slot) => {
          const aspect = build.aspects[slot];
          const pool = aspect ? (blessingsByAspect.get(aspect) ?? []) : [];
          const aspectCard = pool.find((b) => b.kind === 'aspect' && b.slot === slot);
          const pickable = pool.filter((b) => b.kind === 'blessing');
          const equipped = pickable.filter((b) => build.blessings[b.id] !== undefined);
          const available = pickable.filter((b) => build.blessings[b.id] === undefined);

          return (
            <div key={slot} className={`blessing-column${aspect ? '' : ' empty'}`}>
              <div className="column-header">
                <label>{SLOT_LABELS[slot]}</label>
                <select
                  value={aspect ?? ''}
                  onChange={(e) => setAspect(slot, e.target.value || null)}
                >
                  <option value="">&mdash; none &mdash;</option>
                  {aspects.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>

              {!aspect && <p className="empty-hint">Pick an aspect to fill this slot.</p>}

              {aspectCard && (
                <BlessingTile
                  blessing={aspectCard}
                  rank={build.blessings[aspectCard.id] ?? 1}
                  onRank={(r) => setRank(aspectCard.id, r)}
                  pinned
                />
              )}

              {aspect && (
                <ul className="blessing-track">
                  {equipped.map((b) => (
                    <li key={b.id}>
                      <BlessingTile
                        blessing={b}
                        rank={build.blessings[b.id] ?? 1}
                        onRank={(r) => setRank(b.id, r)}
                        onRemove={() => remove(b.id)}
                      />
                    </li>
                  ))}
                  <li>
                    {addingTo === slot ? (
                      <select
                        className="add-picker"
                        autoFocus
                        value=""
                        onChange={(e) => e.target.value && add(e.target.value)}
                        onBlur={() => setAddingTo(null)}
                      >
                        <option value="">choose a blessing&hellip;</option>
                        {available.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <button
                        type="button"
                        className="add-tile"
                        disabled={available.length === 0}
                        onClick={() => setAddingTo(slot)}
                        title={
                          available.length === 0 ? `no more ${aspect} blessings` : 'add a blessing'
                        }
                      >
                        +
                      </button>
                    )}
                  </li>
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function BlessingTile({
  blessing,
  rank,
  onRank,
  onRemove,
  pinned,
}: {
  blessing: Blessing;
  rank: number;
  onRank: (rank: number) => void;
  onRemove?: () => void;
  pinned?: boolean;
}) {
  const max = maxBlessingRank(blessing);
  const hasRank = max > 1;
  const fullyLinked = isFullyRankLinked(blessing);
  const icon = iconSrc(blessing.icon);

  const tooltip = (
    <>
      {renderBlessingDescription(blessing, rank)}
      {hasRank && !fullyLinked && (
        <em className="tile-note"> (rank shown for reference; simulated at base value)</em>
      )}
    </>
  );

  return (
    <div className={`blessing-tile${pinned ? ' aspect' : ''}`}>
      <Tooltip content={tooltip}>
        <button type="button" className="tile-main">
          {icon ? <img src={icon} alt="" /> : <span className="icon-fallback" />}
          <span className={`tile-name${hasRank && !fullyLinked ? ' not-simulated' : ''}`}>
            {blessing.name}
          </span>
          {hasRank && <span className="rank-badge">+{rank}</span>}
        </button>
      </Tooltip>
      {onRemove && (
        <button type="button" className="tile-remove" onClick={onRemove} title="remove">
          &times;
        </button>
      )}

      {hasRank && (
        <div className="rank-pips">
          <input
            type="range"
            min={1}
            max={max}
            value={rank}
            onChange={(e) => onRank(Number(e.target.value))}
          />
          <span className="rank-readout">
            {rank}/{max}
          </span>
        </div>
      )}
    </div>
  );
}
