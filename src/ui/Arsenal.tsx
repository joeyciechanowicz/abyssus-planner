import { abilities, abilityById, charms, weapons, type Weapon, type WeaponMode } from '../model/data';
import type { Build } from '../model/build';
import { Icon, type PickerItem } from './Picker';
import type { OpenPicker } from './App';
import { asset, charmArt } from './theme';

interface Props {
  build: Build;
  weapon: Weapon;
  primaryMode?: WeaponMode;
  secondaryMode?: WeaponMode;
  /** Whether a fire-type slot may be emptied (a build always keeps one mode). */
  canClear: (type: WeaponMode['type']) => boolean;
  maxCharms: number;
  onWeapon: (id: string) => void;
  onMode: (type: WeaponMode['type'], name: string) => void;
  set: (patch: Partial<Build>) => void;
  openPicker: OpenPicker;
}

const modeStats = (m: WeaponMode) =>
  `${m.fireRate.toFixed(1)}/s${m.clipSize ? `, clip ${m.clipSize}` : ''}, ${m.reloadTime.toFixed(1)}s reload${m.estimated ? ' (estimated)' : ''}`;

/** Weapon, both fire modes, ability and charms: the gear row at the top of the build. */
export function Arsenal({ build, weapon, primaryMode, secondaryMode, canClear, maxCharms, onWeapon, onMode, set, openPicker }: Props) {
  const ability = build.abilityId ? abilityById.get(build.abilityId) : undefined;

  const pickWeapon = () =>
    openPicker({
      title: 'Choose a weapon',
      items: weapons.map((w) => ({
        id: w.id,
        name: w.name,
        icon: asset(w.icon),
        describe: () => (
          <ul className="plain">
            {w.modes.map((m) => (
              <li key={m.name}>
                <b>{m.name}</b> <span className="sub">{m.type}, {m.damage}</span>
              </li>
            ))}
          </ul>
        ),
      })),
      selectedId: weapon.id,
      confirmLabel: (i) => (i.id === weapon.id ? 'Keep weapon' : `Switch to ${i.name}`),
      onConfirm: (id) => onWeapon(id),
    });

  const pickMode = (type: WeaponMode['type'], current?: WeaponMode) =>
    openPicker({
      title: `Choose ${type.toLowerCase()} fire`,
      items: weapon.modes
        .filter((m) => m.type === type)
        .map<PickerItem>((m) => ({
          id: m.name,
          name: m.name,
          icon: asset(m.icon),
          tag: m.damage,
          describe: () => (
            <>
              <p>{m.special}</p>
              <p className="sub num-line">{modeStats(m)}</p>
              {m.unlockCondition && <p className="sub">Unlock: {m.unlockCondition}</p>}
            </>
          ),
        })),
      selectedId: current?.name,
      confirmLabel: (i) => `Use ${i.name}`,
      onConfirm: (name) => onMode(type, name),
      extraAction: current && canClear(type) ? { label: 'Clear slot', onClick: () => onMode(type, '') } : undefined,
    });

  const pickAbility = () =>
    openPicker({
      title: 'Choose an ability',
      items: abilities.map((a) => ({
        id: a.id,
        name: a.name,
        icon: asset(a.icon),
        tag: a.damage ? `${a.damage} damage, ${a.charges} charges` : `${a.charges} charges`,
        describe: () => <p>{a.notes}</p>,
      })),
      selectedId: build.abilityId ?? undefined,
      confirmLabel: (i) => `Use ${i.name}`,
      onConfirm: (id) => id !== build.abilityId && set({ abilityId: id, abilityUpgrades: [] }),
      extraAction: ability ? { label: 'Clear slot', onClick: () => set({ abilityId: null, abilityUpgrades: [] }) } : undefined,
    });

  const pickCharm = (slot: number) => {
    const current = build.charmIds[slot];
    const takenElsewhere = new Set(build.charmIds.filter((_, i) => i !== slot));
    openPicker({
      title: 'Choose a charm',
      items: charms
        .filter((c) => !takenElsewhere.has(c.id))
        .map((c) => ({
          id: c.id,
          name: c.name,
          icon: charmArt(c),
          socket: true,
          tag: c.rarity,
          simulated: c.effects.length > 0,
          searchText: c.description,
          describe: () => (
            <>
              <p>{c.description}</p>
              {c.unlockCondition && <p className="sub">Unlock: {c.unlockCondition}</p>}
            </>
          ),
        })),
      selectedId: current,
      confirmLabel: (i) => `Equip ${i.name}`,
      onConfirm: (id) => {
        const next = [...build.charmIds];
        next[slot] = id;
        set({ charmIds: next.filter(Boolean) });
      },
      extraAction: current
        ? { label: 'Remove', onClick: () => set({ charmIds: build.charmIds.filter((_, i) => i !== slot) }) }
        : undefined,
    });
  };

  return (
    <section className="panel arsenal" aria-label="Weapon and ability">
      <div className="gear-row">
        <GearSlot label="Weapon" icon={asset(weapon.icon)} name={weapon.name} sub="Change weapon" subAccent onClick={pickWeapon} big />
        <GearSlot
          label="Primary fire"
          icon={asset(primaryMode?.icon)}
          name={primaryMode?.name ?? 'Empty'}
          sub={primaryMode?.damage ?? 'Choose a primary fire mode'}
          onClick={() => pickMode('Primary', primaryMode)}
        />
        <GearSlot
          label="Secondary fire"
          icon={asset(secondaryMode?.icon)}
          name={secondaryMode?.name ?? 'Empty'}
          sub={secondaryMode?.damage ?? 'Choose a secondary fire mode'}
          onClick={() => pickMode('Secondary', secondaryMode)}
        />
        <GearSlot
          label="Ability"
          icon={asset(ability?.icon)}
          name={ability?.name ?? 'Empty'}
          sub={ability ? `${ability.damage ?? '—'} damage, ${ability.charges} charges` : 'Choose an ability'}
          onClick={pickAbility}
        />
      </div>

      <div className="charm-row">
        <span className="sub">
          Charms <span className="num bright">{build.charmIds.length}/{maxCharms}</span>
        </span>
        {Array.from({ length: maxCharms }, (_, slot) => {
          const charm = charms.find((c) => c.id === build.charmIds[slot]);
          return charm ? (
            <button key={slot} type="button" className="charm-slot" onClick={() => pickCharm(slot)}>
              <Icon src={charmArt(charm)} socket size={48} />
              <span className="slot-text">
                <span className="name">{charm.name}</span>
                <span className="sub">
                  {charm.rarity}
                  {charm.effects.length === 0 && ', not counted in DPS'}
                </span>
              </span>
            </button>
          ) : (
            <button key={slot} type="button" className="add-slot cham" onClick={() => pickCharm(slot)}>
              Add charm
            </button>
          );
        })}
        {maxCharms === 1 && <span className="sub note">A second charm slot needs the Charm Power soul skill.</span>}
      </div>
    </section>
  );
}

function GearSlot({
  label,
  icon,
  name,
  sub,
  subAccent,
  onClick,
  big,
}: {
  label: string;
  icon: string | null;
  name: string;
  sub: string;
  subAccent?: boolean;
  onClick: () => void;
  big?: boolean;
}) {
  return (
    <div className="gear-slot">
      <span className="sub">{label}</span>
      <button type="button" onClick={onClick} aria-label={`${label}: ${name}. Change`}>
        <Icon src={icon} size={76} socket={!icon || big} />
        <span className="slot-text">
          <span className={big ? 'title' : 'name'}>{name}</span>
          <span className={subAccent ? 'link' : 'sub num-line'}>{sub}</span>
        </span>
      </button>
    </div>
  );
}
