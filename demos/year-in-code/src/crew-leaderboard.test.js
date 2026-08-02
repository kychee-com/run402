import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCrewCommitCounts,
  crewCommitShare,
  moveCrewCommitCounts,
  rankCrewContributors,
  stepCrewRankMotion,
} from './crew-leaderboard.js';

const contributors = [
  { id: 'builder-b', name: 'Builder B' },
  { id: 'builder-a', name: 'Builder A' },
];
const commits = [
  { authorId: 'builder-a' },
  { authorId: 'builder-b' },
  { authorId: 'builder-b' },
];

test('crew leaderboard changes rank as the timeline advances', () => {
  const counts = createCrewCommitCounts(contributors, commits, 0);
  assert.deepEqual(rankCrewContributors(contributors, counts).map((person) => person.id), ['builder-b', 'builder-a']);

  moveCrewCommitCounts(counts, commits, 0, 1);
  assert.deepEqual(rankCrewContributors(contributors, counts).map((person) => person.id), ['builder-a', 'builder-b']);
  assert.equal(counts.get('builder-a'), 1);

  moveCrewCommitCounts(counts, commits, 1, commits.length);
  assert.deepEqual(rankCrewContributors(contributors, counts).map((person) => person.id), ['builder-b', 'builder-a']);
  assert.equal(counts.get('builder-b'), 2);
});

test('crew leaderboard rewinds counts without going negative', () => {
  const counts = createCrewCommitCounts(contributors, commits);
  moveCrewCommitCounts(counts, commits, commits.length, 0);
  assert.equal(counts.get('builder-a'), 0);
  assert.equal(counts.get('builder-b'), 0);
});

test('crew commit share scales each bar against the current leader', () => {
  assert.equal(crewCommitShare(25, 100), 0.25);
  assert.equal(crewCommitShare(100, 100), 1);
  assert.equal(crewCommitShare(0, 0), 0);
  assert.equal(crewCommitShare(120, 100), 1);
});

test('capture rank motion follows the leaderboard easing at a fixed frame step', () => {
  const motion = new Map();
  stepCrewRankMotion(motion, ['builder-a', 'builder-b'], { reset: true });
  stepCrewRankMotion(motion, ['builder-b', 'builder-a']);

  assert.ok(motion.get('builder-b').position < 1);
  assert.ok(motion.get('builder-b').position > 0);
  assert.ok(motion.get('builder-a').position > 0);
  assert.ok(motion.get('builder-a').position < 1);

  for (let frame = 0; frame < 20; frame += 1) {
    stepCrewRankMotion(motion, ['builder-b', 'builder-a']);
  }
  assert.equal(motion.get('builder-b').position, 0);
  assert.equal(motion.get('builder-a').position, 1);
});

test('capture rank motion remains continuous when a reorder is interrupted', () => {
  const motion = new Map();
  stepCrewRankMotion(motion, ['builder-a', 'builder-b'], { reset: true });
  stepCrewRankMotion(motion, ['builder-b', 'builder-a']);
  const interruptedPosition = motion.get('builder-a').position;
  stepCrewRankMotion(motion, ['builder-a', 'builder-b']);

  assert.ok(motion.get('builder-a').position <= interruptedPosition);
  assert.ok(motion.get('builder-a').position >= 0);
});
