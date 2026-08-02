import assert from 'node:assert/strict';
import test from 'node:test';
import { createScorePlan, midiToFrequency, scoreLayersAtProgress } from './synth-score.js';

test('the repository score is deterministic but varies between repositories', () => {
  const first = createScorePlan('block/buzz');
  const repeated = createScorePlan('block/buzz');
  const other = createScorePlan('vuejs/core');
  assert.deepEqual(first, repeated);
  assert.notDeepEqual(first.arp, other.arp);
  assert.equal(first.arp.length, 16);
});

test('the score adds rhythmic layers as the tower rises', () => {
  assert.deepEqual(scoreLayersAtProgress(0), {
    pulse: true,
    arpStride: 4,
    shimmer: false,
    brightness: 520,
  });
  assert.equal(scoreLayersAtProgress(0.5).arpStride, 1);
  assert.equal(scoreLayersAtProgress(0.58).shimmer, true);
  assert.equal(scoreLayersAtProgress(1).brightness, 3120);
});

test('MIDI tuning uses concert A', () => {
  assert.equal(midiToFrequency(69), 440);
});
