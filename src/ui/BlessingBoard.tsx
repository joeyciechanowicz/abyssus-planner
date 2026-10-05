import type { CSSProperties } from 'react';
import {
  aspects,
  blessingById,
  blessingsByAspect,
  maxBlessingRank,
  renderBlessingDescription,
  type Blessing,
} from '../model/data';
import { isFullyRankLinked } from '../engine/blessingScaling';
import { MAX_BLESSINGS_PER_ASPECT, countedForAspect, heldBlessings, isPickable, picksLeft } from '../model/blessings';
import type { Build } from '../model/build';
import { Icon, type PickerItem } from './Picker';
import { Tooltip } from './Tooltip';
import type { OpenPicker } from './App';
import { asset, aspectColor } from './theme';

const SLOTS = ['primary', 'secondary', 'ability'] as const;
type Slot = (typeof SLOTS)[number];

const SLOT_LABELS: Record<Slot, string> = {
  primary: 'Primary fire',
  secondary: 'Secondary fire',
  ability: 'Ability',
};

interface Props {
  build: Build;
  onChange: (patch: Partial<Build>) => void;
  openPicker: OpenPicker;
  /** Show only this column (the phone layout switches between them). */
  only?: Slot;
}

const aspectCardFor = (aspect: string, slot: Slot) =>
  blessingsByAspect.get(aspect)?.find((b) => b.kind === 'aspect' && b.slot === slot);

/** How a blessing's rank-dependent numbers read in the picker's rank table. */
function rankValues(b: Blessing) {
  return (rank: number) =>
    (b.upgrades ?? [])
      .filter((u) => u.ranks.length > 1)
      .map((u) => {
        const v = u.ranks[Math.min(rank, u.ranks.length) - 1];
        return { label: u.label ?? u.variable.replace(/[{}]/g, ''), value: u.isPercent ? `${v}%` : `${v}` };
      });
}

function simNote(b: Blessing): string | undefined {
  return maxBlessingRank(b) > 1 && b.effects.length > 0 && !isFullyRankLinked(b)
    ? 'Upgrades are shown for reference; the simulator uses the base value.'
    : undefined;
}

function blessingItem(b: Blessing): PickerItem {
  return {
    id: b.id,
    name: b.name,
    icon: asset(b.icon),
    tag: b.kind === 'aspect' ? 'Aspect' : b.effects.length > 0 ? 'Counted in DPS' : 'Not counted in DPS',
    simulated: b.effects.length > 0,
    simNote: simNote(b),
    maxRank: maxBlessingRank(b),
    searchText: b.description,
    describe: (rank) => <p>{renderBlessingDescription(b, rank)}</p>,
    rankValues: rankValues(b),
  };
}

/**
 * The primary/secondary/ability board, modelled on the in-game screen: each
 * column's aspect sits at the top, lit in its colour, with the blessings taken
 * from that aspect stacked beneath it.
 */
export function BlessingBoard({ build, onChange, openPicker, only }: Props) {
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
    const card = aspect && aspectCardFor(aspect, slot);
    if (card) nextBlessings[card.id] = nextBlessings[card.id] ?? 1;
    onChange({ aspects: nextAspects, blessings: nextBlessings });
  }

  const setRank = (id: string, rank: number) => onChange({ blessings: { ...build.blessings, [id]: rank } });
  const remove = (id: string) => {
    const next = { ...build.blessings };
    delete next[id];
    onChange({ blessings: next });
  };

  function pickAspect(slot: Slot) {
    const current = build.aspects[slot];
    // An aspect's blessings are one shared pool, so each aspect may only occupy
    // one slot -- otherwise the same blessing would show as equipped twice.
    const usedElsewhere = new Set(SLOTS.filter((s) => s !== slot).map((s) => build.aspects[s]));
    openPicker({
      title: `Choose the ${SLOT_LABELS[slot].toLowerCase()} aspect`,
      items: aspects
        .filter((a) => !usedElsewhere.has(a))
        .map((a) => {
          const card = aspectCardFor(a, slot);
          return {
            id: a,
            name: a,
            icon: asset(card?.icon),
            tag: `${(blessingsByAspect.get(a) ?? []).filter(isPickable).length} blessings`,
            describe: () => <p>{card ? renderBlessingDescription(card, 1) : ''}</p>,
          };
        }),
      selectedId: current ?? undefined,
      confirmLabel: (i) => (i.id === current ? 'Keep aspect' : `Use ${i.name}`),
      onConfirm: (a) => a !== current && setAspect(slot, a),
      extraAction: current ? { label: 'Clear slot', onClick: () => setAspect(slot, null) } : undefined,
    });
  }

  function pickBlessing(aspect: string, existing?: Blessing) {
    // The passive, Minor and Major join by themselves; only their rank can be set.
    const pool = (blessingsByAspect.get(aspect) ?? []).filter(isPickable);
    const items = existing
      ? [existing]
      : pool.filter((b) => build.blessings[b.id] === undefined);
    openPicker({
      title: existing ? existing.name : `Add a ${aspect} blessing`,
      titleIcon: asset(blessingsByAspect.get(aspect)?.[0]?.icon),
      accent: aspectColor(aspect),
      items: items.map(blessingItem),
      selectedId: existing?.id,
      selectedRank: existing ? build.blessings[existing.id] : 1,
      emptyText: `Every ${aspect} blessing is already in your build.`,
      confirmLabel: (_, rank) => (existing ? `Set to +${rank - 1}` : rank > 1 ? `Add at +${rank - 1}` : 'Add'),
      onConfirm: (id, rank) => setRank(id, rank),
      extraAction: existing && isPickable(existing) ? { label: 'Remove', onClick: () => remove(existing.id) } : undefined,
    });
  }

  return (
    <section className="board" aria-label="Blessings">
      <div className="section-head">
        <h2>Blessings</h2>
        <span className="sub">One aspect per slot. Its blessings stack beneath it.</span>
      </div>
      <div className={`board-columns${only ? ' single' : ''}`}>
        {SLOTS.filter((s) => !only || s === only).map((slot) => {
          const aspect = build.aspects[slot];
          const color = aspectColor(aspect);
          const pool = aspect ? (blessingsByAspect.get(aspect) ?? []) : [];
          const card = aspect ? aspectCardFor(aspect, slot) : undefined;
          // Picks in order, with the passive first and the Minor/Major in their turn.
          const held = aspect ? heldBlessings(build, aspect).filter((h) => h.blessing.kind === 'blessing') : [];
          const left = aspect ? picksLeft(build, aspect) : 0;
          const counted = aspect ? countedForAspect(heldBlessings(build, aspect)) : 0;
          const allTaken = pool.filter(isPickable).every((b) => build.blessings[b.id] !== undefined);

          return (
            <div key={slot} className={`panel column${aspect ? '' : ' empty'}`} style={{ '--aspect': color } as CSSProperties}>
              <button type="button" className="column-head" onClick={() => pickAspect(slot)}>
                {card ? (
                  <Icon src={asset(card.icon)} size={64} glow />
                ) : (
                  <span className="empty-socket cham" aria-hidden>
                    +
                  </span>
                )}
                <span className="slot-text">
                  <span className="sub">{SLOT_LABELS[slot]}</span>
                  <span className="aspect-name">{aspect ?? 'Choose an aspect'}</span>
                </span>
                <svg className="chev" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                  <path d="M4 6l4 4 4-4" />
                </svg>
              </button>

              {aspect && (
                <ul className="tiles">
                  {card && (
                    <li>
                      <BlessingTile blessing={card} rank={build.blessings[card.id] ?? 1} pinned onClick={() => pickBlessing(aspect, card)} />
                    </li>
                  )}
                  {held.map(({ blessing: b, rank, auto }) => (
                    <li key={b.id}>
                      <BlessingTile blessing={b} rank={rank} pinned={false} auto={auto} onClick={() => pickBlessing(aspect, b)} />
                    </li>
                  ))}
                  <li>
                    <button type="button" className="add-slot cham" disabled={left === 0} onClick={() => pickBlessing(aspect)}>
                      {left > 0
                        ? `Add ${aspect} blessing (${counted}/${MAX_BLESSINGS_PER_ASPECT})`
                        : allTaken
                          ? `All ${aspect} blessings taken`
                          : `${MAX_BLESSINGS_PER_ASPECT} of ${MAX_BLESSINGS_PER_ASPECT} ${aspect} blessings`}
                    </button>
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

/** Why a fixed blessing is on the board. */
const AUTO_LABELS: Record<NonNullable<Blessing['role']>, string> = {
  passive: 'Always on',
  minor: 'Always your 2nd',
  major: 'Always your 5th',
};

function BlessingTile({
  blessing,
  rank,
  pinned,
  auto = false,
  onClick,
}: {
  blessing: Blessing;
  rank: number;
  pinned: boolean;
  /** Added by the rules (passive, Minor, Major), not picked. */
  auto?: boolean;
  onClick: () => void;
}) {
  const max = maxBlessingRank(blessing);
  const autoLabel = auto && blessing.role ? AUTO_LABELS[blessing.role] : undefined;
  const counted = blessing.effects.length > 0;
  const text = renderBlessingDescription(blessing, rank);
  return (
    <Tooltip content={text}>
      <button
        type="button"
        className={`tile cham${pinned ? ' pinned' : ''}${autoLabel ? ' auto' : ''}${counted ? '' : ' uncounted'}`}
        onClick={onClick}
        aria-label={`${blessing.name}${autoLabel ? ` (${autoLabel.toLowerCase()})` : ''}${max > 1 ? `, upgraded ${rank - 1} of ${max - 1} times` : ''}${counted ? '' : ', not counted in DPS'}. Edit`}
      >
        <Icon src={asset(blessing.icon)} size={40} dim={!counted} />
        <span className="slot-text">
          <span className="name">
            {blessing.name}
            {autoLabel && <span className="auto-tag">{autoLabel}</span>}
          </span>
          <span className="sub clamp">{counted ? text : 'Not counted in DPS'}</span>
        </span>
        {/* Rank 1 is the blessing as taken; the badge counts upgrades on top of it. */}
        {max > 1 && <span className="rank cham num">+{rank - 1}</span>}
      </button>
    </Tooltip>
  );
}
