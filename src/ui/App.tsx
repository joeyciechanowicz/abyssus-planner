import { useEffect, useMemo, useState, type ComponentProps } from 'react';
import { soulSkills, weaponById, abilityById } from '../model/data';
import { defaultOptions, emptyBuild, type Build, type SimOptions } from '../model/build';
import { simulate } from '../engine/simulate';
import { decodeBuild, encodeBuild } from './share';
import { Picker } from './Picker';
import { Arsenal } from './Arsenal';
import { ForgePanel } from './ForgePanel';
import { BlessingBoard } from './BlessingBoard';
import { SoulWheel } from './SoulWheel';
import { Contributors, DpsSummary, HowYouPlay, NotCounted } from './Readout';
import { PLAYSTYLES, applyPlaystyle, detectPlaystyle, type Playstyle } from './playstyle';
import { fmt } from './theme';

type PickerConfig = Omit<ComponentProps<typeof Picker>, 'onClose'>;
export type OpenPicker = (config: PickerConfig) => void;

const freshBuild = (): Build => ({ ...emptyBuild, soulSkillIds: soulSkills.map((s) => s.id) });

const TABS = ['Loadout', 'Forge', 'Blessings', 'Soul Wheel'] as const;
type Tab = (typeof TABS)[number];
const BOARD_TABS = [
  ['primary', 'Primary'],
  ['secondary', 'Secondary'],
  ['ability', 'Ability'],
] as const;

function useNarrow(query = '(max-width: 900px)') {
  const [narrow, setNarrow] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return narrow;
}

export function App() {
  const [build, setBuild] = useState<Build>(() => decodeBuild(location.hash) ?? freshBuild());
  const [opts, setOpts] = useState<SimOptions>(defaultOptions);
  const [pendingPlaystyle, setPendingPlaystyle] = useState<Playstyle | null>(null);
  const [picker, setPicker] = useState<PickerConfig | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [tab, setTab] = useState<Tab>('Loadout');
  const [boardSlot, setBoardSlot] = useState<'primary' | 'secondary' | 'ability'>('primary');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const narrow = useNarrow();

  useEffect(() => {
    history.replaceState(null, '', '#' + encodeBuild(build));
    document.title = build.name ? `${build.name} – Abyssus Planner` : 'Abyssus Planner';
  }, [build]);

  const set = (patch: Partial<Build>) => setBuild((b) => ({ ...b, ...patch }));

  const weapon = weaponById.get(build.weaponId)!;
  const mode = weapon.modes.find((m) => m.name === build.modeName)!;
  const weaveMode = build.weaveModeName ? weapon.modes.find((m) => m.name === build.weaveModeName) : undefined;
  // `modeName`/`weaveModeName` don't record which fire type is "main" --
  // whichever of the two matches a type is shown (and edited) in that type's
  // own slot, so the UI offers clean Primary/Secondary slots without exposing
  // the underlying main/weave split.
  const primaryMode = mode.type === 'Primary' ? mode : weaveMode?.type === 'Primary' ? weaveMode : undefined;
  const secondaryMode = mode.type === 'Secondary' ? mode : weaveMode?.type === 'Secondary' ? weaveMode : undefined;
  const ability = build.abilityId ? abilityById.get(build.abilityId) : undefined;
  const maxCharms = build.soulSkillIds.includes('charm_power') ? 2 : 1;

  const setModeOfType = (type: 'Primary' | 'Secondary', newName: string) => {
    setPendingPlaystyle(null);
    const mainIsThisType = mode.type === type;
    if (newName === '') {
      // Promote the other slot to main; a build always keeps one fire mode.
      if (mainIsThisType) {
        if (weaveMode) set({ modeName: weaveMode.name, weaveModeName: null });
        return;
      }
      set({ weaveModeName: null });
      return;
    }
    if (mainIsThisType) set({ modeName: newName });
    else set({ weaveModeName: newName });
  };

  const setWeapon = (id: string) => {
    if (id === weapon.id) return;
    const w = weaponById.get(id)!;
    setPendingPlaystyle(null);
    set({
      weaponId: w.id,
      modeName: (w.modes.find((m) => m.type === 'Primary') ?? w.modes[0]).name,
      weaveModeName: null,
      weaponUpgrades: [],
    });
  };

  // Charm Power removed: drop the second charm with it.
  useEffect(() => {
    if (build.charmIds.length > maxCharms) set({ charmIds: build.charmIds.slice(0, maxCharms) });
  }, [maxCharms, build.charmIds]);

  const result = useMemo(() => {
    try {
      return simulate(build, opts);
    } catch (err) {
      return err as Error;
    }
  }, [build, opts]);

  const playstyle = pendingPlaystyle ?? detectPlaystyle(build, opts, mode);
  const chosenStyle = PLAYSTYLES.find((p) => p.id === playstyle);
  const playstyleHint =
    chosenStyle?.requiresType && chosenStyle.requiresType !== mode.type
      ? `Choose a ${chosenStyle.requiresType.toLowerCase()} fire mode to complete this playstyle.`
      : undefined;

  const openPicker: OpenPicker = (config) =>
    setPicker({
      ...config,
      onConfirm: (id, rank) => {
        config.onConfirm(id, rank);
        setPicker(null);
      },
      extraAction: config.extraAction && {
        ...config.extraAction,
        onClick: () => {
          config.extraAction!.onClick();
          setPicker(null);
        },
      },
    });

  const copyLink = async () => {
    await navigator.clipboard.writeText(location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const reset = () => {
    if (!confirmReset) {
      setConfirmReset(true);
      setTimeout(() => setConfirmReset(false), 3000);
      return;
    }
    setConfirmReset(false);
    setPendingPlaystyle(null);
    setOpts(defaultOptions);
    setBuild(freshBuild());
  };

  const arsenal = (
    <Arsenal
      build={build}
      weapon={weapon}
      primaryMode={primaryMode}
      secondaryMode={secondaryMode}
      canClear={(type) => !!weaveMode || mode.type !== type}
      maxCharms={maxCharms}
      onWeapon={setWeapon}
      onMode={setModeOfType}
      set={set}
      openPicker={openPicker}
    />
  );
  const forge = <ForgePanel build={build} weapon={weapon} ability={ability} set={set} openPicker={openPicker} />;
  const board = <BlessingBoard build={build} onChange={set} openPicker={openPicker} only={narrow ? boardSlot : undefined} />;
  const soul = <SoulWheel build={build} set={set} />;

  const readout =
    result instanceof Error ? (
      <p className="panel error">{result.message}</p>
    ) : (
      <>
        <DpsSummary result={result} />
        <HowYouPlay
          opts={opts}
          setOpts={setOpts}
          weaveLabel={weaveMode?.name}
          hasAbility={!!ability}
          playstyle={playstyle}
          onPlaystyle={(id) => {
            setPendingPlaystyle(id);
            const { buildPatch, optsPatch } = applyPlaystyle(id, build, weapon, mode);
            set(buildPatch);
            setOpts((o) => ({ ...o, ...optsPatch }));
          }}
          playstyleHint={playstyleHint}
        />
        <Contributors result={result} />
        <NotCounted result={result} />
        <p className="sub small disclaimer">
          Estimates for comparing builds, not exact in-game numbers. Picks marked "not counted" add nothing to the total.
        </p>
      </>
    );

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <span className="wordmark">Abyssus Planner</span>
          <label className="field inline build-name">
            <span>Build name</span>
            <input
              type="text"
              maxLength={80}
              placeholder="Untitled build"
              value={build.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
          <div className="topbar-actions">
            <button type="button" className="btn ghost" onClick={reset}>
              {confirmReset ? 'Click again to clear' : 'New build'}
            </button>
            <button type="button" className="btn primary" onClick={copyLink} aria-live="polite">
              {copied ? 'Link copied' : narrow ? 'Copy link' : 'Copy build link'}
            </button>
          </div>
        </div>
      </header>

      {narrow ? (
        <>
          <nav className="tabs" aria-label="Sections">
            {TABS.map((t) => (
              <button key={t} type="button" aria-current={tab === t ? 'page' : undefined} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </nav>
          <main className="narrow-main">
            {tab === 'Loadout' && arsenal}
            {tab === 'Forge' && forge}
            {tab === 'Blessings' && (
              <>
                <div className="segmented" role="group" aria-label="Blessing slot">
                  {BOARD_TABS.map(([slot, label]) => (
                    <button key={slot} type="button" aria-pressed={boardSlot === slot} onClick={() => setBoardSlot(slot)}>
                      {label}
                    </button>
                  ))}
                </div>
                {board}
              </>
            )}
            {tab === 'Soul Wheel' && soul}
          </main>
          {!(result instanceof Error) && (
            <div className="dock">
              <div className="dock-row">
                <span className="num dps-value small">{fmt(result.totalDps)}</span>
                <span className="sub">damage per second</span>
                <button type="button" className="btn ghost" onClick={() => setDetailsOpen(true)}>
                  Details
                </button>
              </div>
            </div>
          )}
          {detailsOpen && (
            <div className="sheet" role="dialog" aria-label="Build results">
              <div className="sheet-head">
                <h2>Results</h2>
                <button type="button" className="btn ghost" onClick={() => setDetailsOpen(false)}>
                  Close
                </button>
              </div>
              {readout}
            </div>
          )}
        </>
      ) : (
        <main className="layout">
          <div className="loadout">
            {arsenal}
            {forge}
            {board}
            {soul}
          </div>
          <aside className="readout">{readout}</aside>
        </main>
      )}

      {picker && <Picker {...picker} onClose={() => setPicker(null)} />}
    </div>
  );
}
