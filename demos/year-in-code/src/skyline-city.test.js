import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cityTowerHeight,
  createCityLayout,
  createNeighborBackdrop,
  createRepositoryDirectory,
} from './skyline-city.js';

test('city tower height increases with commit count and remains bounded', () => {
  assert.ok(cityTowerHeight(1_000) > cityTowerHeight(100));
  assert.equal(cityTowerHeight(3_000), 55);
  assert.equal(cityTowerHeight(30_000), 55);
});

test('city layout keeps the current repository central and de-duplicates cached entries', () => {
  const current = { repo: 'kychee-com/run402', commits: 900, contributors: 4, branches: 20 };
  const layout = createCityLayout([
    { repo: 'block/buzz', commits: 1_200, contributors: 10, branches: 30 },
    { repo: 'Kychee-Com/Run402', commits: 900, contributors: 4, branches: 20 },
  ], current);

  assert.equal(layout.length, 2);
  assert.deepEqual([layout[0].repo, layout[0].x, layout[0].z, layout[0].current], ['kychee-com/run402', 0, 0, true]);
  assert.equal(layout[1].repo, 'block/buzz');
  assert.notDeepEqual([layout[1].x, layout[1].z], [0, 0]);
});

test('neighbor backdrop omits the current tower and places a bounded skyline behind it', () => {
  const backdrop = createNeighborBackdrop([
    { repo: 'current/repo', current: true },
    { repo: 'one/repo', current: false },
    { repo: 'two/repo', current: false },
    { repo: 'three/repo', current: false },
  ], 2);

  assert.deepEqual(backdrop.map((entry) => entry.repo), ['one/repo', 'two/repo']);
  assert.ok(backdrop.every((entry) => entry.x < 0 && entry.z < 0));
  assert.ok(backdrop.every((entry) => entry.scale >= 0.7 && entry.scale < 0.9));
});

test('repository directory de-duplicates repos and sorts every entry by commit count', () => {
  const directory = createRepositoryDirectory([
    { repo: 'small/repo', commits: 12 },
    { repo: 'BIG/REPO', commits: 240 },
    { repo: 'current/repo', commits: 90 },
    { repo: 'big/repo', commits: 200 },
  ], { repo: 'current/repo', commits: 100 });

  assert.deepEqual(directory.map(({ repo, commits }) => [repo, commits]), [
    ['BIG/REPO', 240],
    ['current/repo', 100],
    ['small/repo', 12],
  ]);
});
