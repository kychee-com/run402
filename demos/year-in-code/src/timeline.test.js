import assert from 'node:assert/strict';
import test from 'node:test';
import {
  binaryCountByDate,
  commitCountAtPlaybackProgress,
  playbackActivityStart,
  playbackDateAtProgress,
  playbackProgressAtElapsed,
  playbackProgressForDate,
  playbackProgressForFrame,
} from './timeline.js';

const start = '2025-08-01T00:00:00.000Z';
const end = '2026-07-31T23:59:59.999Z';

test('playback advances uniformly through calendar time', () => {
  assert.equal(playbackDateAtProgress(start, end, 0).toISOString(), start);
  assert.equal(playbackDateAtProgress(start, end, 1).toISOString(), end);
  assert.equal(playbackDateAtProgress(start, end, 0.5).toISOString().slice(0, 10), '2026-01-30');
});

test('commit height follows however many commits existed at the playback date', () => {
  const commits = [
    { date: '2025-08-02T00:00:00Z' },
    { date: '2026-03-01T00:00:00Z' },
    { date: '2026-07-30T00:00:00Z' },
  ];
  assert.equal(commitCountAtPlaybackProgress(commits, start, end, 0.25), 1);
  assert.equal(commitCountAtPlaybackProgress(commits, start, end, 0.75), 2);
  assert.equal(commitCountAtPlaybackProgress(commits, start, end, 1), 3);
});

test('date progress can resume from the same point in the year', () => {
  const date = playbackDateAtProgress(start, end, 0.72);
  assert.ok(Math.abs(playbackProgressForDate(start, end, date) - 0.72) < 1e-9);
});

test('playback begins immediately before the first real repository activity', () => {
  const firstActivity = '2026-03-06T21:00:58.000Z';
  assert.equal(
    playbackActivityStart(start, end, [null, '2026-04-01T00:00:00Z', firstActivity]).toISOString(),
    '2026-03-06T21:00:57.999Z',
  );
  assert.equal(playbackActivityStart(start, end, []).toISOString(), start);
});

test('the active repository interval still receives the full playback duration', () => {
  const activityStartProgress = 0.6;
  assert.equal(playbackProgressAtElapsed(activityStartProgress, activityStartProgress, 0, 28), activityStartProgress);
  assert.equal(playbackProgressAtElapsed(activityStartProgress, activityStartProgress, 14, 28), 0.8);
  assert.equal(playbackProgressAtElapsed(activityStartProgress, activityStartProgress, 28, 28), 1);
});

test('video frames map the complete build onto the active interval', () => {
  assert.equal(playbackProgressForFrame(19, 20, 1139, 0.6), 0.6);
  assert.equal(playbackProgressForFrame(20, 20, 1139, 0.6), 0.6);
  assert.equal(playbackProgressForFrame(1139, 20, 1139, 0.6), 1);
});

test('binaryCountByDate includes events at the target instant', () => {
  const events = [{ at: '2026-01-01T00:00:00Z' }, { at: '2026-02-01T00:00:00Z' }];
  assert.equal(binaryCountByDate(events, 'at', new Date('2026-01-01T00:00:00Z')), 1);
});
