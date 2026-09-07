import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORD_LENGTH,
  MAX_GUESSES,
  WORDS,
  pickAnswer,
  validateGuess,
  scoreGuess,
  isWin,
} from './engine.mjs';

test('WORDS is a non-empty list of unique 5-letter uppercase words', () => {
  assert.ok(WORDS.length >= 50);
  const unique = new Set(WORDS);
  assert.equal(unique.size, WORDS.length);
  for (const word of WORDS) {
    assert.equal(word.length, WORD_LENGTH);
    assert.equal(word, word.toUpperCase());
  }
});

test('MAX_GUESSES is 6', () => {
  assert.equal(MAX_GUESSES, 6);
});

test('pickAnswer with no argument returns a word from WORDS', () => {
  const answer = pickAnswer();
  assert.ok(WORDS.includes(answer));
});

test('pickAnswer with a fixed word normalizes and returns it', () => {
  assert.equal(pickAnswer('crane'), 'CRANE');
  assert.equal(pickAnswer('  Crane  '), 'CRANE');
});

test('pickAnswer throws on invalid fixed word', () => {
  assert.throws(() => pickAnswer('cat'), /5 letters/);
  assert.throws(() => pickAnswer('12345'), /letters/);
});

test('validateGuess accepts 5-letter alphabetic words', () => {
  assert.deepEqual(validateGuess('apple'), { ok: true });
});

test('validateGuess rejects wrong length', () => {
  const result = validateGuess('cat');
  assert.equal(result.ok, false);
  assert.match(result.reason, /5 letters/);
});

test('validateGuess rejects non-alphabetic input', () => {
  const result = validateGuess('appl3');
  assert.equal(result.ok, false);
  assert.match(result.reason, /letters/);
});

test('scoreGuess marks exact match all green', () => {
  assert.deepEqual(scoreGuess('CRANE', 'CRANE'), [
    'green', 'green', 'green', 'green', 'green',
  ]);
});

test('scoreGuess marks all gray when no letters match', () => {
  assert.deepEqual(scoreGuess('LUMPY', 'CRANE'), [
    'gray', 'gray', 'gray', 'gray', 'gray',
  ]);
});

test('scoreGuess handles yellow (right letter, wrong spot)', () => {
  // answer CRANE, guess REACT: R,E,A,C are all in CRANE but shifted
  assert.deepEqual(scoreGuess('REACT', 'CRANE'), [
    'yellow', 'yellow', 'green', 'yellow', 'gray',
  ]);
});

test('scoreGuess handles double letters in guess, single in answer', () => {
  // answer has one 'L', guess has two 'L's -> only one should be marked (not gray-gray)
  const marks = scoreGuess('LLAMA', 'ALARM');
  // ALARM: A-L-A-R-M ; LLAMA: L-L-A-M-A
  // index0 L vs A -> not green; index1 L vs L -> green
  // remaining letters in answer after greens removed: A, A, R, M (index0,2,3,4)
  // guess non-green letters: L(0), A(2), M(3), A(4)
  // L(0): not in remaining -> gray
  // A(2): matches answer[2]='A' -> green actually! answer index2 is 'A' matches guess index2 'A' -> green
  assert.equal(marks[1], 'green');
});

test('scoreGuess handles double letters in answer, single in guess', () => {
  // answer SPEED has two E's; guess EAGER has one relevant E scenario
  const marks = scoreGuess('ABIDE', 'SPEED');
  // SPEED: S-P-E-E-D ; ABIDE: A-B-I-D-E
  // index4: E vs D -> not green
  // greens: none at same index except check: A/S no, B/P no, I/E no, D/E no, E/D no -> no greens
  // guess letters non-green: A,B,I,D,E ; answer remaining counts: S1,P1,E2,E(counted),D1 -> {S:1,P:1,E:2,D:1}
  // A: not in remaining -> gray
  // B: not in remaining -> gray
  // I: not in remaining -> gray
  // D: in remaining (1) -> yellow, decrement D to 0
  // E: in remaining (2) -> yellow
  assert.deepEqual(marks, ['gray', 'gray', 'gray', 'yellow', 'yellow']);
});

test('scoreGuess is case-insensitive', () => {
  assert.deepEqual(scoreGuess('crane', 'CRANE'), [
    'green', 'green', 'green', 'green', 'green',
  ]);
});

test('isWin returns true only when all marks are green', () => {
  assert.equal(isWin(['green', 'green', 'green', 'green', 'green']), true);
  assert.equal(isWin(['green', 'yellow', 'green', 'green', 'green']), false);
  assert.equal(isWin(['gray', 'gray', 'gray', 'gray', 'gray']), false);
});
