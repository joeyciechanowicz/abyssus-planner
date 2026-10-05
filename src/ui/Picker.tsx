import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';

export interface PickerItem {
  id: string;
  name: string;
  icon?: string | null;
  /** Icons that aren't framed art of their own (charms, soul skills) sit in a socket. */
  socket?: boolean;
  /** Short line under the name in the grid. */
  tag?: string;
  /** Whether the simulator counts this pick. Undefined hides the status box. */
  simulated?: boolean;
  /** Extra caveat shown under the simulated status, e.g. rank not modelled. */
  simNote?: string;
  maxRank?: number;
  describe: (rank: number) => ReactNode;
  /** Per-rank values shown under the rank track. */
  rankValues?: (rank: number) => { label: string; value: string }[];
  /** Text searched in addition to the name. */
  searchText?: string;
}

interface Props {
  title: string;
  titleIcon?: string | null;
  accent?: string;
  items: PickerItem[];
  selectedId?: string;
  selectedRank?: number;
  confirmLabel: (item: PickerItem, rank: number) => string;
  onConfirm: (id: string, rank: number) => void;
  onClose: () => void;
  /** A secondary action next to Cancel, e.g. "Remove" or "Clear slot". */
  extraAction?: { label: string; onClick: () => void };
  emptyText?: string;
}

/**
 * The one chooser behind every slot on the page: a searchable icon grid with a
 * detail pane. Built on <dialog> so focus trapping, Escape and the backdrop come
 * from the browser.
 */
export function Picker({
  title,
  titleIcon,
  accent = '#C9924F',
  items,
  selectedId,
  selectedRank,
  confirmLabel,
  onConfirm,
  onClose,
  extraAction,
  emptyText = 'Nothing left to choose here.',
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const [onlyCounted, setOnlyCounted] = useState(false);
  const [pickedId, setPickedId] = useState(selectedId ?? items[0]?.id);
  const [rank, setRank] = useState(selectedRank ?? 1);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const showSimFilter = items.some((i) => i.simulated === false);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(
      (i) =>
        (!onlyCounted || i.simulated !== false) &&
        (!q || i.name.toLowerCase().includes(q) || (i.searchText ?? '').toLowerCase().includes(q)),
    );
  }, [items, query, onlyCounted]);

  const picked = items.find((i) => i.id === pickedId);
  const maxRank = picked?.maxRank ?? 1;
  const clampedRank = Math.min(rank, maxRank);
  // Every blessing starts at rank 1 and can be upgraded up to maxRank - 1 times;
  // the track shows upgrades, so rank r reads as +(r - 1).
  const upgrades = clampedRank - 1;
  const maxUpgrades = maxRank - 1;

  const pick = (item: PickerItem) => {
    if (item.id !== pickedId) setRank(item.id === selectedId ? (selectedRank ?? 1) : 1);
    setPickedId(item.id);
  };
  const confirm = () => picked && onConfirm(picked.id, clampedRank);

  return (
    <dialog
      ref={ref}
      className="picker"
      style={{ '--accent': accent } as CSSProperties}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && ref.current?.close()}
      aria-label={title}
    >
      <div className="picker-frame">
        <header className="picker-head">
          {titleIcon && <img src={titleIcon} alt="" />}
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={() => ref.current?.close()}>
            <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.6">
              <path d="M2 2l10 10M12 2L2 12" />
            </svg>
          </button>
        </header>

        <div className="picker-list">
          <div className="picker-filters">
            <label className="field">
              <span>Search</span>
              <input type="search" value={query} placeholder="Name or effect" onChange={(e) => setQuery(e.target.value)} />
            </label>
            {showSimFilter && (
              <label className="check">
                <input type="checkbox" checked={onlyCounted} onChange={(e) => setOnlyCounted(e.target.checked)} />
                Only show picks counted in DPS
              </label>
            )}
          </div>
          {visible.length === 0 ? (
            <p className="picker-empty">{items.length === 0 ? emptyText : 'No matches. Try a different search.'}</p>
          ) : (
            <ul>
              {visible.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="picker-item cham"
                    aria-pressed={item.id === pickedId}
                    onClick={() => pick(item)}
                    onDoubleClick={() => onConfirm(item.id, item.id === pickedId ? clampedRank : 1)}
                  >
                    <Icon src={item.icon} socket={item.socket} size={36} />
                    <span className="picker-item-text">
                      <span className="name">{item.name}</span>
                      {item.tag && <span className="sub">{item.tag}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="picker-detail">
          {picked ? (
            <>
              <div className="detail-title">
                <Icon src={picked.icon} socket={picked.socket} size={88} glow />
                <div>
                  <h3>{picked.name}</h3>
                  {picked.tag && <span className="sub">{picked.tag}</span>}
                </div>
              </div>
              <div className="detail-body">{picked.describe(clampedRank)}</div>

              {maxRank > 1 && (
                <div className="rank-track">
                  <div className="rank-head">
                    <span className="sub">Upgrades</span>
                    <span className="num rank-now">
                      +{upgrades} <span className="of">of {maxUpgrades}</span>
                    </span>
                  </div>
                  <div className="rank-steps" style={{ gridTemplateColumns: `repeat(${maxUpgrades}, minmax(0, 1fr))` }}>
                    {Array.from({ length: maxUpgrades }, (_, i) => i + 1).map((u) => (
                      <button
                        key={u}
                        type="button"
                        aria-label={`Upgrade ${u}`}
                        aria-pressed={u === upgrades}
                        className={u <= upgrades ? 'on' : ''}
                        // Clicking the current top step steps back down, so +1 can go back to none.
                        onClick={() => setRank(u === upgrades ? u : u + 1)}
                      />
                    ))}
                  </div>
                  <span className="sub small">Click the last lit step to take it back off.</span>
                  {picked.rankValues && (
                    <dl className="rank-values">
                      {picked.rankValues(clampedRank).map((v) => (
                        <div key={v.label}>
                          <dt>{v.label}</dt>
                          <dd className="num">{v.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              )}

              {picked.simulated !== undefined && (
                <p className={`sim-status cham ${picked.simulated ? 'counted' : 'uncounted'}`}>
                  {picked.simulated
                    ? 'Counted in DPS, using your settings in How you play.'
                    : "Not counted in DPS. The simulator can't model this effect yet, so it adds nothing to the number."}
                  {picked.simNote && <> {picked.simNote}</>}
                </p>
              )}
            </>
          ) : (
            <p className="sub">{emptyText}</p>
          )}

          <div className="picker-actions">
            {extraAction && (
              <button type="button" className="btn ghost danger" onClick={extraAction.onClick}>
                {extraAction.label}
              </button>
            )}
            <button type="button" className="btn ghost" onClick={() => ref.current?.close()}>
              Cancel
            </button>
            <button type="button" className="btn primary" disabled={!picked} onClick={confirm}>
              {picked ? confirmLabel(picked, clampedRank) : 'Choose'}
            </button>
          </div>
        </div>
      </div>
    </dialog>
  );
}

/** Game art as-is when it carries its own frame; otherwise seated in a socket. */
export function Icon({
  src,
  socket,
  size,
  glow,
  dim,
}: {
  src?: string | null;
  socket?: boolean;
  size: number;
  glow?: boolean;
  dim?: boolean;
}) {
  const style = { width: size, height: size } as CSSProperties;
  const cls = `icon${glow ? ' glow' : ''}${dim ? ' dim' : ''}`;
  if (!src) return <span className={`${cls} socket cham`} style={style} aria-hidden />;
  if (socket)
    return (
      <span className={`${cls} socket cham`} style={style} aria-hidden>
        <img src={src} alt="" />
      </span>
    );
  return <img className={cls} src={src} alt="" style={style} />;
}
