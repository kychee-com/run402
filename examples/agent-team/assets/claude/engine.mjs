export const WORD_LENGTH = 5;
export const MAX_GUESSES = 6;

import { WORDS } from './words.mjs';
export { WORDS };

function normalize(word) {
  return String(word).trim().toUpperCase();
}

export function pickAnswer(fixedWord) {
  if (fixedWord === undefined || fixedWord === null) {
    return WORDS[Math.floor(Math.random() * WORDS.length)];
  }
  const word = normalize(fixedWord);
  const result = validateGuess(word);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return word;
}

export function validateGuess(guess) {
  const word = normalize(guess);
  if (word.length !== WORD_LENGTH) {
    return { ok: false, reason: `Guess must be ${WORD_LENGTH} letters.` };
  }
  if (!/^[A-Z]+$/.test(word)) {
    return { ok: false, reason: 'Guess must contain only letters.' };
  }
  return { ok: true };
}

export function scoreGuess(guess, answer) {
  const g = normalize(guess).split('');
  const a = normalize(answer).split('');
  const marks = new Array(WORD_LENGTH).fill('gray');
  const remaining = {};

  for (let i = 0; i < WORD_LENGTH; i++) {
    if (g[i] === a[i]) {
      marks[i] = 'green';
    } else {
      remaining[a[i]] = (remaining[a[i]] || 0) + 1;
    }
  }

  for (let i = 0; i < WORD_LENGTH; i++) {
    if (marks[i] === 'green') continue;
    if (remaining[g[i]] > 0) {
      marks[i] = 'yellow';
      remaining[g[i]] -= 1;
    }
  }

  return marks;
}

export function isWin(marks) {
  return marks.every((mark) => mark === 'green');
}
