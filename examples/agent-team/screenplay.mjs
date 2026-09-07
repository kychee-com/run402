// The screenplay for the PERFORMANCE mode.
//
// Every line below is sent as a real message in a real room, in order, each
// seat acting only when it sees the previous beat land. Every action is real:
// the files are the ones three agents actually wrote in an unscripted run
// (see README), the commits and pushes go to a real shared repo, the tests
// really run, and the bug in beat 10 is really there until beat 12 fixes it.
// What is authored is the wording and the pacing — the difference between a
// good pairing session and a great one you can watch in four minutes.

export const CAST = {
  grok:   { name: "Grok",   hue: "33", tagline: "brought the job — words, README, acceptance" },
  claude: { name: "Claude", hue: "36", tagline: "engine — and the merge" },
  codex:  { name: "Codex",  hue: "32", tagline: "the TUI" },
};

const ACCEPT = "printf 'slate\\ncrane\\n' | node wordle.mjs --answer crane --no-color";

export const BEATS = [
  {
    who: "grok", to: ["claude", "codex"], think: 1200,
    do: [["branch", "grok-work"], ["claim", ["words.mjs", "README.md", "package.json"]]],
    text:
      "Job just landed: a terminal Wordle. Node 22, zero deps, tests, README, ships today. " +
      "Three of us, three slices. I take the word list, package.json, README and acceptance. " +
      "Claude — engine? Codex — the TUI? Sixty seconds to object.",
    react: {
      claude: "A job. Engine it is — but nobody types a line until the seam between us is written down.",
      codex: "TUI. Waiting for Claude's interface before I touch a file.",
    },
  },
  {
    who: "claude", to: ["grok", "codex"], think: 3500,
    do: [["branch", "claude-work"], ["claim", ["engine.mjs", "engine.test.mjs"]]],
    text:
      "Engine's mine. So nobody guesses: engine.mjs exports scoreGuess(guess, answer) → five marks, " +
      "validateGuess(guess) → {ok, reason}, isWin(marks), pickAnswer(fixed?). Two-pass scoring so double " +
      "letters can't lie. Words come from Grok's ./words.mjs. Marks as 'G' / 'Y' / '.' — objections?",
    react: {
      grok: "Interface reads right. Starting the word list — fifty words, none of them embarrassing.",
    },
  },
  {
    who: "codex", to: ["claude"], think: 3000,
    do: [["branch", "codex-work"], ["claim", ["wordle.mjs", "wordle.test.mjs"]]],
    text:
      "One amendment: give me 'green' | 'yellow' | 'gray', not letters. You score, I render — the " +
      "letters are a rendering decision and --no-color is my problem, not yours. Also: who uppercases? " +
      "I'd rather hand you exactly what the human typed.",
  },
  {
    who: "claude", to: ["codex"], think: 2200,
    text:
      "Both fair. Colours it is, and the engine normalises — send me whatever they typed, including " +
      "the trailing newline they will definitely leave in. Building.",
    react: { codex: "Interface agreed. Now I can build against something that won't move." },
  },
  {
    who: "grok", to: ["claude", "codex"], think: 1500,
    do: [
      ["write", [["grok/words.mjs", "words.mjs"], ["grok/package.json", "package.json"], ["grok/README.md", "README.md"]]],
      ["cmd", "node -e \"import('./words.mjs').then(m => console.log(m.WORDS.length + ' words, all ' + (m.WORDS.every(w => w.length === 5) ? '5 letters' : 'WRONG')))\""],
      ["commit", "Add words.mjs (50 words), package.json, README skeleton"],
      ["push", "grok-work"],
    ],
    text:
      "pushed grok-work: words.mjs — fifty common words, no plurals, nothing you'd regret on a " +
      "projector — plus package.json (type: module, npm test → node --test) and a README skeleton. " +
      "Handing off: import { WORDS } from './words.mjs'.",
  },
  {
    who: "claude", to: ["codex", "grok"], think: 2500,
    do: [
      ["merge", ["grok-work"]],
      ["write", [["claude/engine.mjs", "engine.mjs"], ["claude/engine.test.mjs", "engine.test.mjs"]]],
      ["test", 15],
      ["commit", "Add wordle engine: scoring, validation, answer selection"],
      ["push", "claude-work"],
    ],
    text:
      "pushed claude-work: engine.mjs + engine.test.mjs — 15 passing, both double-letter directions " +
      "covered (doubles in the guess, doubles in the answer). Pulled Grok's words.mjs; imports clean. " +
      "Handing off the engine: import { scoreGuess, validateGuess, isWin, pickAnswer } from " +
      "'./engine.mjs'. Codex, you're unblocked.",
    react: { codex: "Engine landed. Pulling both branches and wiring the board to it." },
  },
  {
    who: "codex", to: ["grok"], think: 4000,
    text:
      "Question for whoever owns the README: --no-color — print G/Y/. per row as it goes, or a legend " +
      "at the end? Scripts are going to parse this.",
  },
  {
    who: "grok", to: ["codex"], think: 1800,
    text:
      "Per row, no legend. --no-color is for scripts; humans get colours. If it can't be grepped it " +
      "isn't done.",
  },
  {
    who: "codex", to: ["claude", "grok"], think: 2500,
    do: [
      ["merge", ["grok-work", "claude-work"]],
      ["write", [["codex/wordle.mjs", "wordle.mjs"], ["codex/wordle.test.mjs", "wordle.test.mjs"]]],
      ["test", 26],
      ["commit", "Add wordle.mjs TUI + tests"],
      ["push", "codex-work"],
    ],
    text:
      "pushed codex-work: wordle.mjs — stdin loop, board redrawn every guess, ANSI colours, --answer, " +
      "--no-color — plus wordle.test.mjs. Pulled both your branches and ran the lot: 26/26. Interface " +
      "fit first try. Ready to merge.",
    react: { claude: "All three branches are up. Merging to main and running it for real, not just the tests." },
  },
  {
    who: "claude", to: ["codex"], think: 2000,
    do: [
      ["cmd", "git checkout -q main"],
      ["merge", ["grok-work", "claude-work", "codex-work"]],
      ["test", 26],
      ["note", "Tests are green. Now the thing the tests don't see — the actual output:"],
      ["cmd", ACCEPT],
    ],
    text:
      "Merged to main — 26/26, win, lose and invalid-guess all behave. But look at the --no-color " +
      "output: the board reprints its full history every turn, so by guess six each row is on screen " +
      "six times. wordle.mjs:74, renderBoard() in the no-colour branch. Yours or mine?",
    react: { grok: "Good catch. That's exactly the thing a test doesn't notice and a script would choke on." },
  },
  {
    who: "codex", to: ["claude"], think: 1600,
    text: "Mine — I own it, and I can see it from here. Newest row only in --no-color; the colour path keeps the clear-screen and the full board. Thirty seconds.",
  },
  {
    who: "codex", to: ["claude"], think: 1200,
    do: [
      ["write", [["codex-fixed/wordle.mjs", "wordle.mjs"]]],
      ["test", 26],
      ["cmd", ACCEPT],
      ["commit", "Fix duplicate rows in --no-color output"],
      ["push", "codex-work"],
    ],
    text: "pushed codex-work: --no-color prints just the new row. 26/26, and this time I looked at the output before I said so.",
  },
  {
    who: "claude", to: ["grok", "codex"], think: 1800,
    do: [
      ["merge", ["codex-work"]],
      ["test", 26],
      ["cmd", ACCEPT],
      ["push", "main"],
    ],
    text: "main is green: words + engine + TUI, 26/26, and the duplicate rows are gone. Grok, it's yours to accept.",
    react: { grok: "Pulling main. Running exactly what I promised, not a variation of it." },
  },
  {
    who: "grok", to: ["claude", "codex"], think: 1200,
    do: [
      ["cmd", "git checkout -q main && git pull -q origin main && git log --oneline | head -8"],
      ["cmd", ACCEPT],
      ["test", 26],
    ],
    text:
      "SHIPPED. " + ACCEPT + " → SLATE ..G.G / CRANE GGGGG / You won in 2. node --test 26/26. " +
      "Three agents, three vendors, one room, no meetings. Same room tomorrow?",
  },
  {
    who: "claude", to: ["grok", "codex"], think: 1800,
    text: "Anytime. The next one gets a --hard flag.",
  },
  {
    who: "codex", to: ["grok", "claude"], think: 1400,
    text: "Only if Claude scores it.",
  },
];
