import type { Build } from '../model/build';
import type { Ability, Weapon } from '../model/data';
import { sharedAbilityUpgrades } from '../model/data';
import { Icon } from './Picker';
import type { OpenPicker } from './App';
import { asset } from './theme';

const SOCKETS = 3;

interface Upgrade {
  name: string;
  description: string;
  icon?: string | null;
  effects: unknown[];
}

interface Props {
  build: Build;
  weapon: Weapon;
  ability?: Ability;
  set: (patch: Partial<Build>) => void;
  openPicker: OpenPicker;
}

/** Ancient Forge upgrades: three sockets for the weapon, three for the ability. */
export function ForgePanel({ build, weapon, ability, set, openPicker }: Props) {
  return (
    <section className="panel forge" aria-label="Forge upgrades">
      <ForgeGroup
        title="Weapon upgrades"
        owner={weapon.name}
        pool={weapon.forgeUpgrades}
        chosen={build.weaponUpgrades}
        onChange={(weaponUpgrades) => set({ weaponUpgrades })}
        openPicker={openPicker}
      />
      {ability ? (
        <ForgeGroup
          title="Ability upgrades"
          owner={ability.name}
          pool={[...ability.forgeUpgrades, ...sharedAbilityUpgrades]}
          chosen={build.abilityUpgrades}
          onChange={(abilityUpgrades) => set({ abilityUpgrades })}
          openPicker={openPicker}
        />
      ) : (
        <div className="forge-group">
          <h2>Ability upgrades</h2>
          <p className="sub">Choose an ability to add its upgrades.</p>
        </div>
      )}
    </section>
  );
}

function ForgeGroup({
  title,
  owner,
  pool,
  chosen,
  onChange,
  openPicker,
}: {
  title: string;
  owner: string;
  pool: Upgrade[];
  chosen: string[];
  onChange: (names: string[]) => void;
  openPicker: OpenPicker;
}) {
  const byName = new Map(pool.map((u) => [u.name, u]));

  const open = (slot: number) => {
    const current = chosen[slot];
    const taken = new Set(chosen.filter((_, i) => i !== slot));
    openPicker({
      title: `${owner} upgrade`,
      items: pool
        .filter((u) => !taken.has(u.name))
        .map((u) => ({
          id: u.name,
          name: u.name,
          icon: asset(u.icon),
          simulated: u.effects.length > 0,
          searchText: u.description,
          describe: () => <p>{u.description}</p>,
        })),
      selectedId: current,
      confirmLabel: (i) => (i.id === current ? 'Keep upgrade' : `Socket ${i.name}`),
      onConfirm: (name) => {
        const next = [...chosen];
        next[slot] = name;
        onChange(next.filter(Boolean));
      },
      extraAction: current ? { label: 'Remove', onClick: () => onChange(chosen.filter((_, i) => i !== slot)) } : undefined,
    });
  };

  return (
    <div className="forge-group">
      <h2>
        {title} <span className="num count">{chosen.length}/{SOCKETS}</span>
      </h2>
      <div className="sockets">
        {Array.from({ length: SOCKETS }, (_, slot) => {
          const u = byName.get(chosen[slot]);
          return u ? (
            <button key={slot} type="button" className="socket-slot" onClick={() => open(slot)}>
              <Icon src={asset(u.icon)} size={72} dim={u.effects.length === 0} />
              <span className="name">{u.name}</span>
              {u.effects.length === 0 && <span className="sub">Not counted in DPS</span>}
            </button>
          ) : (
            <button key={slot} type="button" className="socket-slot" onClick={() => open(slot)}>
              <span className="empty-socket cham" aria-hidden>
                +
              </span>
              <span className="sub">Empty socket</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
