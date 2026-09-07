#!/usr/bin/env node
import readline from 'node:readline';
import {
  WORD_LENGTH,
  MAX_GUESSES,
  pickAnswer,
  validateGuess,
  scoreGuess,
  isWin,
} from './engine.mjs';

export function parseArgs(argv) {
  const args = { color: true, answer: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-color') {
      args.color = false;
    } else if (a === '--answer') {
      args.answer = argv[++i];
    } else if (a.startsWith('--answer=')) {
      args.answer = a.slice('--answer='.length);
    }
  }
  return args;
}

const MARK_BG = { green: '\x1b[30;42m', yellow: '\x1b[30;43m', gray: '\x1b[97;100m' };
const RESET = '\x1b[0m';
const MARK_SYMBOL = { green: 'G', yellow: 'Y', gray: '.' };
const CLEAR_SCREEN = '\x1b[2J\x1b[H';

export function formatRow(word, marks, color) {
  if (color) {
    return marks.map((m, i) => `${MARK_BG[m]} ${word[i].toUpperCase()} ${RESET}`).join('');
  }
  return `${word.toUpperCase()}  ${marks.map((m) => MARK_SYMBOL[m]).join('')}`;
}

export function renderBoard(history, color) {
  return history.map(({ word, marks }) => formatRow(word, marks, color)).join('\n');
}

export async function main(argv = process.argv.slice(2), input = process.stdin, output = process.stdout) {
  const args = parseArgs(argv);

  let answer;
  try {
    answer = pickAnswer(args.answer);
  } catch (err) {
    output.write(`Error: ${err.message}\n`);
    return 1;
  }

  const color = args.color;
  const history = [];

  output.write(`Guess the ${WORD_LENGTH}-letter word. You have ${MAX_GUESSES} guesses.\n`);

  const rl = readline.createInterface({ input, terminal: false });

  for await (const rawLine of rl) {
    const guess = rawLine.trim();
    if (guess === '') continue;

    const check = validateGuess(guess);
    if (!check.ok) {
      output.write(`Invalid guess: ${check.reason}\n`);
      continue;
    }

    const marks = scoreGuess(guess, answer);
    history.push({ word: guess, marks });

    if (color) output.write(CLEAR_SCREEN);
    output.write(renderBoard(history, color) + '\n');

    if (isWin(marks)) {
      output.write(`You won in ${history.length} guess${history.length === 1 ? '' : 'es'}!\n`);
      rl.close();
      return 0;
    }

    if (history.length >= MAX_GUESSES) {
      output.write(`Out of guesses. The word was ${answer}.\n`);
      rl.close();
      return 0;
    }
  }

  output.write(`No more input. The word was ${answer}.\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  });
}
