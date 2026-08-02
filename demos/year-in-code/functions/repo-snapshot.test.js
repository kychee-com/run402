import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  assembleSnapshot,
  assembleSkyline,
  completedMonthWindow,
  mergeIssueWindowPages,
  parseRepositoryInput,
  quarterlyIssueWindows,
} from './repo-snapshot.js';

test('completedMonthWindow uses the last twelve completed calendar months', () => {
  const window = completedMonthWindow(new Date('2026-07-30T19:45:00Z'));
  assert.equal(window.start.toISOString(), '2025-07-01T00:00:00.000Z');
  assert.equal(window.end.toISOString(), '2026-06-30T23:59:59.999Z');
  assert.equal(window.periodKey, '2026-06');
  assert.equal(window.cacheUntil.toISOString(), '2026-08-01T00:00:00.000Z');
});

test('completedMonthWindow handles a January boundary', () => {
  const window = completedMonthWindow(new Date('2027-01-04T01:00:00Z'));
  assert.equal(window.start.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(window.end.toISOString(), '2026-12-31T23:59:59.999Z');
  assert.equal(window.periodKey, '2026-12');
});

test('quarterlyIssueWindows covers the complete playback year without overlap', () => {
  const window = completedMonthWindow(new Date('2026-08-01T12:00:00Z'));
  assert.deepEqual(quarterlyIssueWindows(window), [
    { start: '2025-08-01', end: '2025-10-31' },
    { start: '2025-11-01', end: '2026-01-31' },
    { start: '2026-02-01', end: '2026-04-30' },
    { start: '2026-05-01', end: '2026-07-31' },
  ]);
});

test('mergeIssueWindowPages keeps both ends of a busy time window and removes overlap', () => {
  const issue = (id, updatedAt) => ({ id, number: id, updated_at: updatedAt });
  const merged = mergeIssueWindowPages({
    items: [issue(1, '2026-02-01T00:00:00Z'), issue(2, '2026-02-02T00:00:00Z')],
    totalCount: 4,
    incomplete: false,
  }, {
    items: [issue(2, '2026-02-02T00:00:00Z'), issue(4, '2026-04-30T00:00:00Z')],
    totalCount: 4,
    incomplete: false,
  }, 3);

  assert.deepEqual(merged.items.map(({ id }) => id), [1, 2, 4]);
  assert.equal(merged.truncated, true);
});

test('parseRepositoryInput accepts slugs and GitHub URLs but rejects other hosts', () => {
  assert.deepEqual(parseRepositoryInput('Kychee-Com/run402'), {
    owner: 'Kychee-Com',
    repo: 'run402',
    key: 'kychee-com/run402',
  });
  assert.deepEqual(parseRepositoryInput('https://github.com/kychee-com/run402.git'), {
    owner: 'kychee-com',
    repo: 'run402',
    key: 'kychee-com/run402',
  });
  assert.throws(() => parseRepositoryInput('https://example.com/kychee-com/run402'), /Only public github.com/);
});

test('assembleSnapshot excludes Frank Fiegel and keeps a complete month axis', () => {
  const window = completedMonthWindow(new Date('2026-07-20T00:00:00Z'));
  const commit = (sha, name, date, login) => ({
    sha,
    commit: {
      message: `${name} work\n\nDetails`,
      author: { name, email: `${login}@users.noreply.github.com`, date },
      committer: { name, email: `${login}@users.noreply.github.com`, date },
    },
    author: { login, avatar_url: 'https://avatars.githubusercontent.com/u/123?v=4' },
    committer: { login, avatar_url: 'https://avatars.githubusercontent.com/u/123?v=4' },
    parents: [],
  });
  const snapshot = assembleSnapshot({
    full_name: 'kychee-com/run402',
    html_url: 'https://github.com/kychee-com/run402',
    default_branch: 'main',
  }, {
    commits: {
      items: [
        commit('a'.repeat(40), 'Ada Lovelace', '2026-02-01T12:00:00Z', 'ada'),
        commit('f'.repeat(40), 'Frank Fiegel', '2026-03-01T12:00:00Z', 'frank-fiegel'),
      ],
      truncated: false,
    },
    branches: { items: [{ name: 'main', commit: { sha: 'a'.repeat(40) } }], truncated: false },
    issues: { items: [], truncated: false },
  }, window, new Date('2026-07-30T00:00:00Z'));

  assert.equal(snapshot.commits.length, 1);
  assert.equal(snapshot.contributors.length, 1);
  assert.equal(snapshot.contributors[0].name, 'Ada Lovelace');
  assert.equal(snapshot.contributors[0].avatarUrl, 'https://avatars.githubusercontent.com/u/123?v=4&s=96');
  assert.equal(snapshot.contributors[0].avatarSource, 'github');
  assert.equal(snapshot.meta.excludedCommits, 1);
  assert.equal(snapshot.months.length, 12);
  assert.equal(snapshot.meta.period, '2026-06');
});

test('assembleSnapshot creates a Gravatar fallback without exporting raw email', () => {
  const window = completedMonthWindow(new Date('2026-07-20T00:00:00Z'));
  const email = 'Grace.Hopper@Example.com';
  const snapshot = assembleSnapshot({
    full_name: 'example/repository',
    html_url: 'https://github.com/example/repository',
    default_branch: 'main',
  }, {
    commits: {
      items: [{
        sha: 'b'.repeat(40),
        commit: {
          message: 'Compiler work',
          author: { name: 'Grace Hopper', email, date: '2026-02-10T12:00:00Z' },
          committer: { name: 'Grace Hopper', email, date: '2026-02-10T12:00:00Z' },
        },
        author: null,
        committer: null,
        parents: [],
      }],
      truncated: false,
    },
    branches: { items: [], truncated: false },
    issues: { items: [], truncated: false },
  }, window, new Date('2026-07-30T00:00:00Z'));

  const gravatarHash = createHash('sha256').update(email.toLowerCase()).digest('hex');
  assert.equal(snapshot.contributors[0].avatarUrl, `https://gravatar.com/avatar/${gravatarHash}?s=96&d=identicon&r=g`);
  assert.equal(snapshot.contributors[0].avatarSource, 'gravatar');
  assert.equal(JSON.stringify(snapshot).includes(email), false);
});

test('assembleSkyline returns compact repository landmarks without commit payloads', () => {
  const skyline = assembleSkyline([{
    meta: {
      repo: 'block/buzz',
      repoUrl: 'https://github.com/block/buzz',
      end: '2026-06-30T23:59:59.999Z',
      commits: 1_145,
      branches: 300,
      issues: 25,
      contributors: 22,
    },
    months: [{ commits: 90 }, { commits: 120 }],
    generated_at: '2026-07-30T12:00:00.000Z',
  }], new Date('2026-07-30T19:45:00Z'));

  assert.deepEqual(skyline.repositories[0], {
    repo: 'block/buzz',
    repoUrl: 'https://github.com/block/buzz',
    end: '2026-06-30T23:59:59.999Z',
    commits: 1_145,
    branches: 300,
    issues: 25,
    contributors: 22,
    monthCommits: [90, 120],
    generatedAt: '2026-07-30T12:00:00.000Z',
  });
  assert.equal('snapshot' in skyline.repositories[0], false);
});

test('assembleSkyline returns every unique repository sorted by commits', () => {
  const row = (repo, commits, generatedAt) => ({
    meta: { repo, commits, branches: 1, issues: 2, contributors: 3 },
    months: [],
    generated_at: generatedAt,
  });
  const skyline = assembleSkyline([
    row('small/repo', 10, '2026-07-01T00:00:00Z'),
    row('Big/Repo', 200, '2026-07-01T00:00:00Z'),
    row('big/repo', 220, '2026-06-01T00:00:00Z'),
    row('middle/repo', 80, '2026-07-01T00:00:00Z'),
  ], new Date('2026-08-02T00:00:00Z'));

  assert.deepEqual(skyline.repositories.map(({ repo, commits }) => [repo, commits]), [
    ['Big/Repo', 200],
    ['middle/repo', 80],
    ['small/repo', 10],
  ]);
});
