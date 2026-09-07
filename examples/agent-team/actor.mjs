#!/usr/bin/env node
// A seat in the PERFORMANCE: plays one role from screenplay.mjs.
//
// The room is the clock. Every seat watches the room; when the previous beat
// has landed (a real message from the right cast member), the seat whose beat
// is next performs its actions — real file writes, real commits, real pushes,
// real test runs, output shown — then sends its line as a real message. No
// timers coordinate the seats, only the messages they send each other, which
// is also why the transcript pane shows genuine timestamps.
//
//   DEMO_DIR=… node actor.mjs <grok|claude|codex>
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BEATS, CAST } from "./screenplay.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROLE = process.argv[2];
if (!CAST[ROLE]) { console.error("actor.mjs <grok|claude|codex>"); process.exit(2); }
const ME = CAST[ROLE].name;
const DEMO_DIR = process.env.DEMO_DIR;
if (!DEMO_DIR) { console.error("set DEMO_DIR"); process.exit(2); }
const FAST = process.env.DEMO_FAST === "1";
const WORK = join(DEMO_DIR, "work", ROLE);
const ASSETS = join(HERE, "assets");
process.chdir(WORK);
process.env.RUN402_CONFIG_DIR = join(DEMO_DIR, "cfg", ROLE);
process.env.RUN402_SESSION_KEY = `agent-team-${ROLE}`;
process.env.RUN402_NO_TASK_FROM_TITLE = "1";

// ── pane stagecraft ────────────────────────────────────────────────────────
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c("2", s);
const me = (s) => c(`1;${CAST[ROLE].hue}`, s);
const stamp = () => new Date().toISOString().slice(11, 19);
const sleep = (ms) => new Promise((r) => setTimeout(r, FAST ? Math.min(ms, 150) : ms));
const say = async (s) => { for (const l of wrap(s)) { process.stdout.write(`${me("│")} ${l}\n`); await sleep(350); } };
const wrap = (s, w = 92) => s.split("\n").flatMap((line) => { const out = []; while (line.length > w) { const cut = line.lastIndexOf(" ", w); const at = cut > 20 ? cut : w; out.push(line.slice(0, at)); line = line.slice(at).trimStart(); } out.push(line); return out; });

function sh(cmd, { show = true, quiet = false } = {}) {
  if (show) process.stdout.write(`${dim(stamp())} ${dim("$")} ${dim(cmd)}\n`);
  const r = spawnSync("bash", ["-lc", cmd], { encoding: "utf8", env: process.env });
  const out = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
  if (!quiet && out) for (const l of out.split("\n").slice(0, 14)) process.stdout.write(`   ${dim("↳")} ${l}\n`);
  return { code: r.status ?? 1, out };
}
function run402(args) {
  const r = spawnSync("run402", args, { encoding: "utf8", env: process.env });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}
function parse(s) { try { return JSON.parse(s); } catch { return null; } }

// ── the actions a beat can perform ─────────────────────────────────────────
const ACTIONS = {
  async branch(name) { sh(`git checkout -q -b ${name} 2>/dev/null || git checkout -q ${name}`, { quiet: true }); },
  async claim(globs) {
    for (const g of globs) {
      process.stdout.write(`${dim(stamp())} ${me("🏷  claim")} ${dim(`repo:${g}`)}\n`);
      run402(["claims", "create", `repo:${g}`, "--note", `${ME}'s slice`]);
      await sleep(300);
    }
  },
  async write(files) {
    for (const [src, dst] of files) {
      process.stdout.write(`${dim(stamp())} ${me("✎ write")} ${dst}\n`);
      mkdirSync(dirname(join(WORK, dst)), { recursive: true });
      copyFileSync(join(ASSETS, src), join(WORK, dst));
      await sleep(900);
    }
  },
  async merge(branches) {
    sh(`git fetch -q origin ${branches.join(" ")}`, { quiet: true });
    for (const b of branches) sh(`git merge -q --no-edit origin/${b}`, { quiet: true });
  },
  async test(expect) {
    const r = sh("node --test 2>&1 | grep -E '^# (tests|pass|fail)'");
    if (expect && !r.out.includes(`# pass ${expect}`)) process.stdout.write(`   ${c("31", "expected " + expect + " passing")}\n`);
    await sleep(600);
  },
  async cmd(line) { sh(line); await sleep(800); },
  async commit(msg) { sh(`git add -A && git commit -q -m ${JSON.stringify(msg)} && git log --oneline -1`); await sleep(400); },
  async push(branch) {
    process.stdout.write(`${dim(stamp())} ${me("⇧ push")} ${dim(`git push origin ${branch}`)}\n`);
    sh(`git push -q origin ${branch}`, { show: false, quiet: true });
    await sleep(500);
  },
  async think(ms) { await sleep(ms); },
  async note(s) { await say(s); },
};

// ── the room as the clock ──────────────────────────────────────────────────
const castNames = new Set(Object.values(CAST).map((x) => x.name));
let seen = 0;                      // screenplay beats observed in the room
let backlog = [];                  // messages fetched but not yet counted

function countNew(page) {
  for (const m of page?.messages ?? []) {
    if (!castNames.has(m.sender)) continue;
    seen += 1;
  }
}
async function waitForBeat(n) {
  // Block until at least n cast messages have landed. First read is a plain
  // list from the seat's cursor (registered at setup); later reads hold on
  // the gateway.
  while (seen < n) {
    const r = run402(["messages", "wait", "--timeout", "25", "--json"]);
    const page = parse(r.out);
    if (page) countNew(page);
  }
}

process.stdout.write(`${me(`● ${ME}`)} ${dim(`· ${CAST[ROLE].tagline}`)}\n`);
process.stdout.write(`${dim(stamp())} ${me("👂 listening")} ${dim("run402 messages wait")}\n`);

for (let i = 0; i < BEATS.length; i++) {
  const beat = BEATS[i];
  await waitForBeat(i);            // everything before me has landed
  if (beat.who !== ROLE) {
    if (i === 0) continue;
    // Someone else's line: a short reaction keeps the pane alive.
    if (beat.react?.[ROLE]) { await sleep(FAST ? 100 : 900); await say(beat.react[ROLE]); }
    continue;
  }
  // The pause reads as the seat working, not as a dead pane.
  if (!FAST) process.stdout.write(`${dim(stamp())} ${dim(`● ${ME} is thinking…`)}\n`);
  await sleep(FAST ? 100 : beat.think ?? 1800);
  for (const [action, arg] of beat.do ?? []) await ACTIONS[action](arg);
  const to = beat.to?.map((r) => CAST[r].name).join(",");
  process.stdout.write(`${dim(stamp())} ${me("💬 send")}${to ? dim(` → ${to}`) : ""}\n`);
  for (const l of wrap(beat.text)) process.stdout.write(`   ${l}\n`);
  const args = ["messages", "send", beat.text];
  if (to) args.push("--to", to);
  const r = run402(args);
  if (r.code !== 0) process.stdout.write(`   ${c("31", "send failed: " + (r.err || r.out).slice(0, 200))}\n`);
  seen += 1;                       // my own line counts once it is sent
}

process.stdout.write(`\n${me(`■ ${ME}`)} ${dim("signed off")}\n`);
