#!/usr/bin/env node
// Turns `claude -p --output-format stream-json --verbose` into a readable live
// feed for one pane: what the agent says, what it runs, what it writes — and
// every room message it sends, called out so the audience can follow the
// collaboration from the agent's side too.
//
//   claude -p … --output-format stream-json --verbose | node feed.mjs Claude
import readline from "node:readline";

const NAME = process.argv[2] ?? "agent";
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c("2", s), bold = (s) => c("1", s);
const hue = { Grok: "33", Claude: "36", Codex: "32" }[NAME] ?? "35";
const me = (s) => c(`1;${hue}`, s);

const stamp = () => new Date().toISOString().slice(11, 19);
const wrap = (s, w = 96) =>
  s.split("\n").flatMap((line) => {
    const out = [];
    while (line.length > w) { const cut = line.lastIndexOf(" ", w); const at = cut > 20 ? cut : w; out.push(line.slice(0, at)); line = line.slice(at).trimStart(); }
    out.push(line); return out;
  });

process.stdout.write(`${me(`● ${NAME}`)} ${dim("is thinking…")}\n`);

function showTool(name, input) {
  if (name === "Bash") {
    const cmd = String(input.command ?? "").trim();
    const m = cmd.match(/run402\s+messages\s+send\s+(.*)$/s);
    if (m) {
      const body = (m[1].match(/^"((?:[^"\\]|\\.)*)"|^'((?:[^'\\]|\\.)*)'/) ?? [])[1] ?? m[1];
      const to = (m[1].match(/--to\s+(\S+)/) ?? [])[1];
      process.stdout.write(`${dim(stamp())} ${me("💬 send")}${to ? dim(` → ${to}`) : ""}\n`);
      for (const l of wrap(body.replace(/\\n/g, "\n"))) process.stdout.write(`   ${l}\n`);
      return;
    }
    if (/run402\s+messages\s+wait/.test(cmd)) { process.stdout.write(`${dim(stamp())} ${me("👂 listening")} ${dim(cmd.replace(/.*run402/, "run402"))}\n`); return; }
    if (/run402\s+claims\s+create/.test(cmd)) { process.stdout.write(`${dim(stamp())} ${me("🏷  claim")} ${dim(cmd.replace(/.*run402/, "run402"))}\n`); return; }
    if (/git\s+push/.test(cmd)) { process.stdout.write(`${dim(stamp())} ${me("⇧ push")} ${dim(cmd)}\n`); return; }
    process.stdout.write(`${dim(stamp())} ${dim("$")} ${dim(cmd.split("\n")[0].slice(0, 110))}\n`);
    return;
  }
  if (name === "Write" || name === "Edit" || name === "MultiEdit") {
    process.stdout.write(`${dim(stamp())} ${me("✎ " + name.toLowerCase())} ${input.file_path ?? ""}\n`);
    return;
  }
  if (name === "Read") { process.stdout.write(`${dim(stamp())} ${dim("read " + (input.file_path ?? ""))}\n`); return; }
  process.stdout.write(`${dim(stamp())} ${dim(name)}\n`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let ev; try { ev = JSON.parse(line); } catch { return; }
  if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
    for (const part of ev.message.content) {
      if (part.type === "text" && part.text?.trim()) {
        for (const l of wrap(part.text.trim())) process.stdout.write(`${me("│")} ${l}\n`);
      } else if (part.type === "tool_use") {
        showTool(part.name, part.input ?? {});
      }
    }
  } else if (ev.type === "user" && Array.isArray(ev.message?.content)) {
    for (const part of ev.message.content) {
      if (part.type !== "tool_result") continue;
      const raw = typeof part.content === "string" ? part.content : Array.isArray(part.content) ? part.content.map((x) => x.text ?? "").join("\n") : "";
      const first = raw.split("\n").find((l) => l.trim()) ?? "";
      if (first && !/^\{/.test(first)) process.stdout.write(`   ${dim("↳ " + first.slice(0, 100))}\n`);
    }
  } else if (ev.type === "result") {
    const cost = ev.total_cost_usd != null ? ` · $${Number(ev.total_cost_usd).toFixed(2)}` : "";
    process.stdout.write(`\n${me(`■ ${NAME} done`)} ${dim(`(${ev.subtype}${cost})`)}\n`);
  }
});
