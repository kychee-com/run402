import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { parseArgs, formatRow, renderBoard, main } from './wordle.mjs';

test('parseArgs: defaults to color on, no fixed answer', () => {
  const args = parseArgs([]);
  assert.equal(args.color, true);
  assert.equal(args.answer, undefined);
});

test('parseArgs: --no-color turns color off', () => {
  const args = parseArgs(['--no-color']);
  assert.equal(args.color, false);
});

test('parseArgs: --answer <word> sets fixed answer', () => {
  const args = parseArgs(['--answer', 'crane']);
  assert.equal(args.answer, 'crane');
});

test('parseArgs: --answer=<word> sets fixed answer', () => {
  const args = parseArgs(['--answer=crane']);
  assert.equal(args.answer, 'crane');
});

test('formatRow: no-color mode prints letters and G/Y/. markers', () => {
  const row = formatRow('crane', ['green', 'yellow', 'gray', 'gray', 'gray'], false);
  assert.equal(row, 'CRANE  GY...');
});

test('formatRow: color mode wraps each letter in ANSI codes', () => {
  const row = formatRow('abcde', ['green', 'green', 'green', 'green', 'green'], true);
  assert.match(row, /\x1b\[30;42m A \x1b\[0m/);
});

test('renderBoard: joins multiple guess rows with newlines', () => {
  const board = renderBoard(
    [
      { word: 'crane', marks: ['gray', 'gray', 'gray', 'gray', 'gray'] },
      { word: 'blast', marks: ['green', 'gray', 'gray', 'gray', 'gray'] },
    ],
    false,
  );
  assert.equal(board.split('\n').length, 2);
});

function makeInput(lines) {
  return Readable.from(lines.map((l) => `${l}\n`).join(''));
}

function makeOutput() {
  let data = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      data += chunk.toString();
      cb();
    },
  });
  return { stream, get text() { return data; } };
}

test('main: end-to-end win against real engine, --no-color', async () => {
  const output = makeOutput();
  const code = await main(['--no-color', '--answer', 'crane'], makeInput(['crane']), output.stream);
  assert.equal(code, 0);
  assert.match(output.text, /won/);
  assert.match(output.text, /1 guess/);
});

test('main: rejects non-5-letter guess without consuming a turn', async () => {
  const output = makeOutput();
  const code = await main(
    ['--no-color', '--answer', 'crane'],
    makeInput(['ab', 'crane']),
    output.stream,
  );
  assert.equal(code, 0);
  assert.match(output.text, /Invalid guess/);
  assert.match(output.text, /1 guess/);
});

test('main: reveals answer after running out of guesses', async () => {
  const output = makeOutput();
  const code = await main(
    ['--no-color', '--answer', 'crane'],
    makeInput(['blast', 'blast', 'blast', 'blast', 'blast', 'blast']),
    output.stream,
  );
  assert.equal(code, 0);
  assert.match(output.text, /CRANE/);
  assert.doesNotMatch(output.text, /won/);
});

test('main: invalid --answer exits with non-zero code', async () => {
  const output = makeOutput();
  const code = await main(['--answer', 'nope'], makeInput([]), output.stream);
  assert.equal(code, 1);
  assert.match(output.text, /Error/);
});
