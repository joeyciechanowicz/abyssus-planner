import { describe, expect, it } from 'vitest';
import { emptyBuild, type Build } from '../model/build';
import { soulSkills } from '../model/data';
import { decodeBuild, encodeBuild } from './share';

const build: Build = {
  ...emptyBuild,
  name: 'Stormcaller harpoons — v2 ⚡',
  weaponId: 'Harpoon_Gun',
  modeName: 'Piercing Harpoons',
  weaveModeName: 'Barbed Harpoons',
  aspects: { primary: 'Chain Lightning', secondary: 'Blood', ability: 'Frozen' },
  blessings: { Blood_Secondary: 2 },
  charmIds: ['hate_forged'],
  soulSkillIds: soulSkills.map((s) => s.id),
};

describe('share links', () => {
  it('round-trips a build, including a non-ASCII name', () => {
    expect(decodeBuild('#' + encodeBuild(build))).toEqual(build);
  });

  it('is URL-safe without further escaping', () => {
    expect(encodeBuild(build)).toMatch(/^2\.[A-Za-z0-9_-]+$/);
  });

  it('still decodes version-1 links, which had no name', () => {
    const { name: _, ...legacy } = build;
    const v1 = btoa(encodeURIComponent(JSON.stringify(legacy)));
    expect(decodeBuild('#' + v1)).toEqual({ ...build, name: '' });
  });

  it('rejects garbage', () => {
    expect(decodeBuild('#2.not-json')).toBeNull();
    expect(decodeBuild('#%%%')).toBeNull();
    expect(decodeBuild('')).toBeNull();
  });
});
