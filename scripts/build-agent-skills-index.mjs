#!/usr/bin/env node
/**
 * Build the complete first-party Agent Skills Discovery publication tree.
 *
 * The public repository is authoritative for both artifact bytes and metadata:
 *
 *   .well-known/agent-skills/index.json
 *   skills/run402/<sha256>/SKILL.md
 *   skills/run402-buzz/<sha256>/run402-buzz.tgz
 *   agent-skills-release.json (deployment metadata; not publicly advertised)
 *
 * Usage:
 *   node scripts/build-agent-skills-index.mjs
 *   node scripts/build-agent-skills-index.mjs --check
 *   node scripts/build-agent-skills-index.mjs --output-dir /tmp/run402-skills
 */
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_PATH = join(ROOT, ".well-known", "agent-skills", "index.json");
const DEFAULT_OUTPUT_DIR = join(ROOT, ".artifacts", "agent-skills");
const APEX_ORIGIN = "https://run402.com";

export const BUZZ_ARCHIVE_FILES = Object.freeze([
  "SKILL.md",
  "fixtures/buzz-v0.4.26-desktop-owner-negative.json",
  "fixtures/buzz-v0.4.26-managed-agent-kind1.json",
  "fixtures/buzz-v0.5.2-community-authority.json",
  "fixtures/buzz-v0.5.2-browser-fragment-v1.json",
  "fixtures/buzz-v0.5.2-cli-capabilities.json",
  "fixtures/identity-link-v1-golden.json",
  "fixtures/run402-buzz-doctor-v1-contract.json",
  "references/community-control-plane.md",
  "references/conversations.md",
  "references/identity-and-security.md",
  "references/installation.md",
  "references/preflight.md",
  "references/receipts.md",
  "scripts/buzz-publish-proof.mjs",
  "scripts/doctor-report.mjs",
  "scripts/setup.mjs",
  "scripts/strict-json.mjs",
]);

const ARTIFACT_CACHE_CONTROL = "public, max-age=31536000, immutable";
const INDEX_CACHE_CONTROL = "public, max-age=300, must-revalidate";
const MAX_BUZZ_ARCHIVE_BYTES = 5 * 1024 * 1024;
const SECRET_PATTERNS = [
  /\bnsec1[023456789acdefghjklmnpqrstuvwxyz]{20,}\b/i,
  /-----BEGIN (?:EC |RSA |OPENSSH )?PRIVATE KEY-----/,
  /(?:private[_ -]?key|mnemonic|seed)\s*[:=]\s*["'][^"']{8,}["']/i,
];

function parseFrontmatter(markdown, label) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error(`${label} has no YAML frontmatter`);
  const name = match[1].match(/^name:\s*(.+?)\s*$/m)?.[1];
  const description = match[1].match(/^description:\s*(.+?)\s*$/m)?.[1];
  if (!name) throw new Error(`${label} frontmatter is missing name`);
  if (!description) throw new Error(`${label} frontmatter is missing description`);
  if (description.length > 1024) throw new Error(`${label} description exceeds 1024 characters`);
  return { name, description };
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSafeArchivePath(path) {
  if (!path || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) {
    throw new Error(`unsafe Buzz archive path: ${path}`);
  }
  if (path.includes("\\") || path.includes("\0") || path.split("/").some((part) => part === ".." || part === ".")) {
    throw new Error(`unsafe Buzz archive path: ${path}`);
  }
  if (Buffer.byteLength(path) > 100) throw new Error(`Buzz archive path is too long for ustar: ${path}`);
}

function assertNoSecretMaterial(path, bytes) {
  const text = bytes.toString("utf8");
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) throw new Error(`possible secret material in Buzz archive source: ${path}`);
  }
}

function writeTarString(header, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`tar field exceeds ${length} bytes: ${value}`);
  bytes.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  const octal = value.toString(8);
  if (octal.length > length - 1) throw new Error(`tar value does not fit field: ${value}`);
  writeTarString(header, offset, length, `${octal.padStart(length - 1, "0")}\0`);
}

function createTarHeader(path, size) {
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, path);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  writeTarString(header, 257, 6, "ustar\0");
  writeTarString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredDeflate(bytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length || (bytes.length === 0 && offset === 0); offset += 0xffff) {
    const length = Math.min(0xffff, bytes.length - offset);
    const final = offset + length >= bytes.length;
    const blockHeader = Buffer.alloc(5);
    blockHeader[0] = final ? 0x01 : 0x00;
    blockHeader.writeUInt16LE(length, 1);
    blockHeader.writeUInt16LE((~length) & 0xffff, 3);
    chunks.push(blockHeader, bytes.subarray(offset, offset + length));
    if (final) break;
  }
  return Buffer.concat(chunks);
}

export function createDeterministicTarGz(entries) {
  const chunks = [];
  for (const [path, bytes] of [...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    assertSafeArchivePath(path);
    chunks.push(createTarHeader(path, bytes.length), bytes);
    const padding = (512 - (bytes.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  const tar = Buffer.concat(chunks);
  const compressed = createStoredDeflate(tar);
  const header = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(tar), 0);
  trailer.writeUInt32LE(tar.length >>> 0, 4);
  return Buffer.concat([header, compressed, trailer]);
}

export function inspectTarGz(bytes) {
  const tar = gunzipSync(bytes);
  const entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const readString = (start, length) => {
      const field = header.subarray(start, start + length);
      const nul = field.indexOf(0);
      return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
    };
    const path = readString(0, 100);
    const size = Number.parseInt(readString(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 0x30);
    assertSafeArchivePath(path);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`invalid tar size for ${path}`);
    if (type !== "0") throw new Error(`Buzz archive contains non-file entry ${path} (${type})`);
    if (entries.some((entry) => entry.path === path)) throw new Error(`Buzz archive contains duplicate entry: ${path}`);
    offset += 512;
    if (offset + size > tar.length) throw new Error(`truncated tar entry: ${path}`);
    entries.push({ path, type, bytes: Buffer.from(tar.subarray(offset, offset + size)) });
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

function loadBuzzEntries(root) {
  const buzzRoot = join(root, "buzz");
  let totalBytes = 0;
  return BUZZ_ARCHIVE_FILES.map((path) => {
    assertSafeArchivePath(path);
    const absolutePath = join(buzzRoot, path);
    const relativePath = relative(buzzRoot, absolutePath);
    if (relativePath.startsWith("..")) throw new Error(`Buzz archive path escapes package: ${path}`);
    const stat = lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Buzz archive source is not a regular file: ${path}`);
    const bytes = readFileSync(absolutePath);
    totalBytes += bytes.length;
    if (totalBytes > MAX_BUZZ_ARCHIVE_BYTES) throw new Error("Buzz archive exceeds size bound");
    assertNoSecretMaterial(path, bytes);
    return [path, bytes];
  });
}

export function buildAgentSkillDistribution({ root = ROOT } = {}) {
  const genericBytes = readFileSync(join(root, "SKILL.md"));
  const genericMetadata = parseFrontmatter(genericBytes.toString("utf8"), "SKILL.md");
  if (genericMetadata.name !== "run402") throw new Error("root SKILL.md must identify as run402");

  const buzzEntries = loadBuzzEntries(root);
  const buzzMetadata = parseFrontmatter(
    buzzEntries.find(([path]) => path === "SKILL.md")[1].toString("utf8"),
    "buzz/SKILL.md",
  );
  if (buzzMetadata.name !== "run402-buzz") throw new Error("buzz/SKILL.md must identify as run402-buzz");
  const buzzArchiveBytes = createDeterministicTarGz(buzzEntries);

  const genericSha = sha256Hex(genericBytes);
  const buzzSha = sha256Hex(buzzArchiveBytes);
  const genericPath = `skills/run402/${genericSha}/SKILL.md`;
  const buzzPath = `skills/run402-buzz/${buzzSha}/run402-buzz.tgz`;
  const skills = [
    {
      name: genericMetadata.name,
      type: "skill-md",
      description: genericMetadata.description,
      url: `${APEX_ORIGIN}/${genericPath}`,
      digest: `sha256:${genericSha}`,
    },
    {
      name: buzzMetadata.name,
      type: "archive",
      description: buzzMetadata.description,
      url: `${APEX_ORIGIN}/${buzzPath}`,
      digest: `sha256:${buzzSha}`,
    },
  ];
  const indexBytes = Buffer.from(`${JSON.stringify({
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills,
  }, null, 2)}\n`);
  const release = {
    schema_version: 1,
    index: {
      path: ".well-known/agent-skills/index.json",
      content_type: "application/json; charset=utf-8",
      cache_control: INDEX_CACHE_CONTROL,
      sha256: sha256Hex(indexBytes),
    },
    artifacts: [
      {
        name: "run402",
        type: "skill-md",
        path: genericPath,
        url: `${APEX_ORIGIN}/${genericPath}`,
        digest: `sha256:${genericSha}`,
        content_type: "text/markdown; charset=utf-8",
        cache_control: ARTIFACT_CACHE_CONTROL,
      },
      {
        name: "run402-buzz",
        type: "archive",
        path: buzzPath,
        url: `${APEX_ORIGIN}/${buzzPath}`,
        digest: `sha256:${buzzSha}`,
        content_type: "application/gzip",
        cache_control: ARTIFACT_CACHE_CONTROL,
      },
    ],
  };
  const releaseBytes = Buffer.from(`${JSON.stringify(release, null, 2)}\n`);
  return {
    indexBytes,
    releaseBytes,
    release,
    artifacts: new Map([
      [genericPath, genericBytes],
      [buzzPath, buzzArchiveBytes],
    ]),
  };
}

export function writeDistribution(outputDir, distribution) {
  const files = new Map([
    [".well-known/agent-skills/index.json", distribution.indexBytes],
    ["agent-skills-release.json", distribution.releaseBytes],
    ...distribution.artifacts,
  ]);
  for (const [path, bytes] of files) {
    const destination = join(outputDir, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
}

function parseArgs(argv) {
  let check = false;
  let outputDir = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      check = true;
    } else if (arg === "--output-dir") {
      outputDir = argv[index + 1];
      index += 1;
      if (!outputDir) throw new Error("--output-dir requires a path");
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (check && outputDir) throw new Error("--check and --output-dir cannot be combined");
  return { check, outputDir };
}

function main() {
  const { check, outputDir } = parseArgs(process.argv.slice(2));
  const distribution = buildAgentSkillDistribution();
  const secondBuild = buildAgentSkillDistribution();
  if (!distribution.indexBytes.equals(secondBuild.indexBytes)) throw new Error("index build is not reproducible");
  for (const [path, bytes] of distribution.artifacts) {
    if (!bytes.equals(secondBuild.artifacts.get(path))) throw new Error(`artifact build is not reproducible: ${path}`);
  }

  if (check) {
    let existing = Buffer.alloc(0);
    try {
      existing = readFileSync(INDEX_PATH);
    } catch {
      // A missing index is stale.
    }
    if (!existing.equals(distribution.indexBytes)) {
      console.error("agent-skills index is stale — run: node scripts/build-agent-skills-index.mjs");
      process.exitCode = 1;
      return;
    }
    console.log("agent-skills index and deterministic artifacts are up to date");
    return;
  }

  if (outputDir) {
    const resolvedOutput = resolve(outputDir);
    writeDistribution(resolvedOutput, distribution);
    console.log(`wrote Agent Skills publication tree to ${resolvedOutput}`);
    return;
  }

  mkdirSync(dirname(INDEX_PATH), { recursive: true });
  writeFileSync(INDEX_PATH, distribution.indexBytes);
  writeDistribution(DEFAULT_OUTPUT_DIR, distribution);
  console.log(`wrote ${INDEX_PATH}`);
  console.log(`wrote Agent Skills publication tree to ${DEFAULT_OUTPUT_DIR}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
