import test from 'node:test';
import assert from 'node:assert/strict';
import { getRepositoryActionState, normalizeRepositoryInput } from './repository-input.js';

test('repository input accepts GitHub URLs and normalizes them to owner/repo', () => {
  assert.equal(normalizeRepositoryInput('https://github.com/kychee-com/run402.git'), 'kychee-com/run402');
});

test('the loaded repository enables Watch and disables Build', () => {
  const state = getRepositoryActionState('kychee-com/run402', { currentRepository: 'kychee-com/run402' });
  assert.equal(state.buildEnabled, false);
  assert.equal(state.watchEnabled, true);
});

test('a different valid repository enables Build and disables Watch', () => {
  const state = getRepositoryActionState('kychee-com/run402-core', { currentRepository: 'kychee-com/run402' });
  assert.equal(state.buildEnabled, true);
  assert.equal(state.watchEnabled, false);
});

test('invalid and loading states disable both actions', () => {
  const invalid = getRepositoryActionState('not-a-repository', { currentRepository: 'kychee-com/run402' });
  const loading = getRepositoryActionState('kychee-com/run402-core', { currentRepository: 'kychee-com/run402', loading: true });
  assert.deepEqual([invalid.buildEnabled, invalid.watchEnabled], [false, false]);
  assert.deepEqual([loading.buildEnabled, loading.watchEnabled], [false, false]);
});
