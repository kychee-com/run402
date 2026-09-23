/**
 * `docs` — the discovery surface for `run`.
 *
 * Answers from two files that ship inside the `run402-mcp` package, copied
 * there by `npm run build`: the SDK reference (`sdk/llms-sdk.txt`, generated
 * from `docs-site/src/content/docs/sdk/**`) and the `run` primer
 * (`docs-site/src/content/docs/mcp/run.md`). The text a host reads is therefore
 * the SDK the snippet runs against, never a newer or older copy from the
 * network; this tool never fetches anything.
 *
 * `topic` is `index` (the default: the primer, the `r` namespace table, and the
 * list of topics), `sdk` (the whole reference), or one section of it: a
 * namespace such as `assets` or `project.apply`, or a section slug such as
 * `local-state`. `search` returns the sections whose heading or body contains
 * every word, capped. Every answer goes through the result store, so a long
 * one is a window plus a `ref` that `expand_result` pages.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { storeResult } from "../result-store.js";

/** Lines shown inline; the index fits inside one window. */
export const DOCS_WINDOW_LINES = 200;
/** Sections a search returns at most. */
export const DOCS_SEARCH_MAX_SECTIONS = 8;

import type { ToolError, ToolResult } from "../structured.js";

export const docsSchema = {
  topic: z
    .string()
    .optional()
    .describe("`index` (default: the run primer, the r namespace table, the topics), `sdk` (the whole SDK reference), or one section: a namespace such as `projects`, `assets`, `project.apply`, `rooms`, or a section slug from the index."),
  search: z
    .string()
    .optional()
    .describe(`Words to look for; returns up to ${DOCS_SEARCH_MAX_SECTIONS} SDK reference sections whose heading or body contain all of them.`),
};

interface Section {
  heading: string;
  level: 2 | 3;
  /** Topic keys that name this section. */
  keys: string[];
  /** Lines of the section, heading included, up to the next heading of the same or a higher level. */
  lines: string[];
  /** Lines up to the next heading of any level (what a search returns). */
  leaf: string[];
  /** Whether the section documents an `r` namespace (under "Namespaces", or a top-level section named for one). */
  namespace: boolean;
}

interface Corpus {
  reference: string[];
  primer: string[];
  sections: Section[];
}

const here = dirname(fileURLToPath(import.meta.url));

function readPackaged(name: string, sourcePath: string[]): string {
  // Published package: dist/tools/docs.js reads dist/docs/<name>. In the
  // repository (tests, `tsx`), fall back to the source the build copies.
  const packaged = join(here, "..", "docs", name);
  const path = existsSync(packaged) ? packaged : join(here, "..", "..", ...sourcePath);
  return readFileSync(path, "utf8");
}

let corpus: Corpus | null = null;

function load(): Corpus {
  if (corpus) return corpus;
  const reference = readPackaged("llms-sdk.txt", ["sdk", "llms-sdk.txt"]).replace(/\n+$/, "").split("\n");
  const primerRaw = readPackaged("run.md", ["docs-site", "src", "content", "docs", "mcp", "run.md"]);
  const primer = primerRaw.replace(/^---\n[\s\S]*?\n---\n+/, "").replace(/\n+$/, "").split("\n");
  corpus = { reference, primer, sections: parseSections(reference) };
  return corpus;
}

/** Split the reference at `##` / `###` headings outside code fences. */
function parseSections(lines: string[]): Section[] {
  const heads: Array<{ index: number; level: 2 | 3; heading: string }> = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) return;
    const m = /^(##|###) (.+)$/.exec(line);
    if (m) heads.push({ index, level: m[1] === "##" ? 2 : 3, heading: m[2]!.trim() });
  });
  let inNamespaces = false;
  return heads.map((h, i) => {
    if (h.level === 2) inNamespaces = /^Namespaces\b/.test(h.heading);
    const nextSame = heads.slice(i + 1).find((n) => n.level <= h.level);
    const nextAny = heads[i + 1];
    const keys = topicKeys(h.heading);
    const namedForR = /`r\./.test(h.heading);
    return {
      heading: h.heading,
      level: h.level,
      keys,
      lines: lines.slice(h.index, nextSame ? nextSame.index : lines.length),
      leaf: lines.slice(h.index, nextAny ? nextAny.index : lines.length),
      namespace: (h.level === 3 && inNamespaces) || (h.level === 2 && namedForR),
    };
  });
}

/** `### \`r.project(id).apply\`` → ["project.apply", "r-project-id-apply"]; every `r.x` a heading names is a key. */
function topicKeys(heading: string): string[] {
  const keys: string[] = [];
  for (const m of heading.matchAll(/`r\.([A-Za-z][\w]*(?:\([^)`]*\))?(?:\.[A-Za-z][\w]*(?:\([^)`]*\))?)*)`?/g)) {
    keys.push(m[1]!.replace(/\([^)]*\)/g, ""));
  }
  const short = slug(heading.replace(/\s*\(.*$/, "").replace(/\s+—.*$/, ""));
  if (short) keys.push(short);
  keys.push(slug(heading));
  return [...new Set(keys)];
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** One line per namespace: its topic key and the method names its signature block lists. */
function namespaceTable(sections: Section[]): string[] {
  const rows = ["| topic | what `r` offers there |", "|---|---|"];
  for (const s of sections.filter((x) => x.namespace)) {
    const key = s.keys[0]!;
    rows.push(`| \`${key}\` | ${summarize(s)} |`);
  }
  return rows;
}

const JS_KEYWORDS = new Set(["if", "for", "while", "switch", "return", "await", "const", "let", "function", "catch", "new", "typeof"]);

function summarize(s: Section): string {
  const methods: string[] = [];
  let fenced = false;
  let sawFence = false;
  for (const line of s.lines.slice(1)) {
    if (/^\s*```/.test(line)) {
      if (fenced) break;
      fenced = true;
      sawFence = true;
      continue;
    }
    if (!fenced) continue;
    const m = /^\s*(?:r\.[\w.]+\.)?([a-zA-Z]\w*)\s*[(<]/.exec(line);
    if (m && !JS_KEYWORDS.has(m[1]!) && !methods.includes(m[1]!)) methods.push(m[1]!);
  }
  if (methods.length > 0) {
    const shown = methods.slice(0, 8).join(", ");
    return methods.length > 8 ? `${shown}, … (${methods.length} methods)` : shown;
  }
  const prose = s.lines.slice(1).find((l) => l.trim() && !/^\s*(```|>|\||-|#)/.test(l));
  if (prose && !sawFence) return truncate(prose.trim(), 110);
  return truncate(prose?.trim() ?? s.heading, 110);
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\|/g, "\\|");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function indexLines(c: Corpus): string[] {
  const topics = c.sections.filter((s) => s.level === 2).map((s) => `\`${s.keys[0]}\``);
  return [
    "# run402-mcp docs: index",
    "",
    "Eight tools: `up` and `deploy` (the first deploy), `status`, `whoami`, `doctor`, `docs` (this), `run`, and `expand_result`. Every other operation is a `run` snippet against `r`, the Node SDK client.",
    "",
    ...c.primer,
    "",
    "## `r` namespaces",
    "",
    "Call `docs` with the topic for the full section. Node-only local state (`r.wallets` selection, `r.orgs` context, `r.doctor()`, `r.init()`, `r.status()`, `r.diagnostics.probeOrigin()`) is topic `local-state`.",
    "",
    ...namespaceTable(c.sections),
    "",
    "## Other topics",
    "",
    `\`sdk\` (the whole reference), ${topics.join(", ")}.`,
    "",
    "`docs({ search: \"words\" })` finds sections by content.",
  ];
}

function findSection(c: Corpus, topic: string): Section | null {
  const wanted = topic.trim().replace(/^r\./, "").toLowerCase();
  const ordered = [...c.sections.filter((s) => s.namespace), ...c.sections.filter((s) => !s.namespace)];
  return (
    ordered.find((s) => s.keys.some((k) => k.toLowerCase() === wanted)) ??
    ordered.find((s) => s.keys.some((k) => k.toLowerCase() === slug(wanted))) ??
    null
  );
}

function searchLines(c: Corpus, query: string): { lines: string[]; matched: number } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = c.sections.filter((s) => {
    const text = s.leaf.join("\n").toLowerCase();
    return words.every((w) => text.includes(w));
  });
  const lines: string[] = [];
  for (const s of hits.slice(0, DOCS_SEARCH_MAX_SECTIONS)) {
    if (lines.length) lines.push("");
    lines.push(`(topic \`${s.keys[0]}\`)`, ...s.leaf);
  }
  return { lines, matched: hits.length };
}

function respond(kind: string, header: string, lines: string[], error?: ToolError): ToolResult {
  const view = storeResult(kind, lines, { shown: DOCS_WINDOW_LINES });
  const where =
    view.shown < view.total
      ? `lines 1–${view.shown} of ${view.total}; expand_result with ref ${view.ref} and offset ${view.shown} pages the rest.`
      : `${view.total} lines, all shown (ref ${view.ref}).`;
  const text = [`${header} — ${where}`, "", ...view.items].join("\n");
  const page = { kind, ref: view.ref, shown: view.shown, total: view.total, lines: view.items };
  if (error) return { content: [{ type: "text", text }], structuredContent: { status: "error", ...page, error }, isError: true };
  return { content: [{ type: "text", text }], structuredContent: { status: "ok", ...page } };
}

export async function handleDocs(args: { topic?: string; search?: string }): Promise<ToolResult> {
  const c = load();
  if (args.search !== undefined && args.search.trim()) {
    const { lines, matched } = searchLines(c, args.search);
    if (matched === 0) {
      return respond("docs", `docs search "${args.search}": no section matches`, ["No SDK reference section contains all of those words. Try fewer words, or `docs` with no arguments for the index."]);
    }
    const capped = matched > DOCS_SEARCH_MAX_SECTIONS ? ` (showing the first ${DOCS_SEARCH_MAX_SECTIONS} of ${matched} matching sections; add words to narrow)` : ` (${matched} matching section${matched === 1 ? "" : "s"})`;
    return respond("docs", `docs search "${args.search}"${capped}`, lines);
  }

  const topic = (args.topic ?? "index").trim() || "index";
  if (topic === "index") return respond("docs", "docs: index", indexLines(c));
  if (topic === "sdk") return respond("docs", "docs: the whole SDK reference", c.reference);
  if (topic === "run") return respond("docs", "docs: run", c.primer);

  const section = findSection(c, topic);
  if (!section) {
    const topics = c.sections.map((s) => s.keys[0]!);
    return respond(
      "docs",
      `docs: unknown topic "${topic}"`,
      [`No topic "${topic}". Topics: index, sdk, run, ${topics.join(", ")}.`, "", "Or search: docs({ search: \"words\" })."],
      {
        code: "DOCS_TOPIC_NOT_FOUND",
        message: `No topic "${topic}".`,
        next_actions: [{ type: "call_tool", tool: "docs", why: "Call docs with no arguments for the topic list, or pass search." }],
      },
    );
  }
  return respond("docs", `docs: ${section.keys[0]}`, section.lines);
}
