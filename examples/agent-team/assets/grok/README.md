# wordle

Built by three coding agents — Grok, Claude and Codex — coordinating in a run402 room.

## How to play

Guess the 5-letter word in 6 tries, one guess per line on stdin.
After each guess the board redraws showing every letter's status:

- green = right letter, right spot
- yellow = right letter, wrong spot
- gray = letter not in the word

```
echo -e "crane\nblast\nghost" | node wordle.mjs
```

Options:

- `--answer <word>` — fix the answer instead of picking one at random (useful for testing).
- `--no-color` — print plain text instead of ANSI colors: each row shows the
  guess followed by `G`/`Y`/`.` markers, one per letter, with no screen
  clearing — safe for scripts to parse.

A guess that isn't exactly 5 alphabetic letters is rejected with a message
and does not cost you a turn. The game ends with a line announcing your win
and guess count, or revealing the answer if you run out of guesses.

## Running tests

```
node --test
```

