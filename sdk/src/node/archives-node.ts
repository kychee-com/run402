import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, opendir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { LocalError, NetworkError } from "../errors.js";
import type { Client } from "../kernel.js";
import { Archives } from "../namespaces/archives.js";
import type {
  ArchiveDiagnostic,
  ArchiveExportReport,
  ArchiveImportResult,
  ArchiveImportToCoreOptions,
  ArchivePortabilityReport,
  ArchiveSecretRequirement,
  ArchiveVerifyResult,
} from "../namespaces/archives.types.js";

const DEFAULT_CORE_URL = "http://127.0.0.1:4020";
const PROJECT_ARCHIVE_VERSION = "run402-project-archive.v1";
const PROJECT_ARCHIVE_DIGEST_IDENTITY = "run402-project-archive-logical-v1";
const TAR_BLOCK_BYTES = 512;
const ZERO_BLOCK = Buffer.alloc(TAR_BLOCK_BYTES);
const SUPPORTED_CAPABILITIES = new Set([
  "run402.core.release-state.v1",
  "run402.core.database.phased-postgres-copy.v1",
  "run402.core.storage.cas.v1",
  "run402.core.functions.node22.v1",
  "run402.core.astro-ssr.v1",
  "run402.core.auth-stubs.v1",
  "run402.core.secret-requirements.v1",
]);

interface ArchiveEntries {
  entries: Map<string, Uint8Array>;
  transport: "directory" | "tar";
  totalBytes: number;
}

interface ArchiveDescriptor {
  mediaType?: string;
  digest?: string;
  size?: number;
  path?: string;
}

interface ArchiveIndex {
  archive_version?: string;
  archive_digest?: `sha256:${string}`;
  required_capabilities?: string[];
  identity_descriptors?: string[];
  descriptors?: Record<string, ArchiveDescriptor>;
}

export class NodeArchives extends Archives {
  constructor(client: Client) {
    super(client);
  }

  inspect(archivePath: string): Promise<ArchiveVerifyResult> {
    return inspectArchive(archivePath);
  }

  verify(archivePath: string): Promise<ArchiveVerifyResult> {
    return verifyArchive(archivePath);
  }

  importToCore(opts: ArchiveImportToCoreOptions): Promise<ArchiveImportResult> {
    return importArchiveToCore(opts);
  }
}

export async function inspectArchive(archivePath: string): Promise<ArchiveVerifyResult> {
  return verifyLocalPortableArchive(path.resolve(archivePath));
}

export async function verifyArchive(archivePath: string): Promise<ArchiveVerifyResult> {
  return verifyLocalPortableArchive(path.resolve(archivePath));
}

export async function importArchiveToCore(opts: ArchiveImportToCoreOptions): Promise<ArchiveImportResult> {
  const archivePath = path.resolve(opts.archivePath);
  const verification = await verifyLocalPortableArchive(archivePath);
  if (!verification.ok) {
    return failedImportResult({
      archiveDigest: verification.archive_digest,
      requiredSecrets: verification.required_secrets,
      diagnostics: [
        diagnostic({
          code: "IMPORT_VERIFY_FAILED",
          resourceType: "archive",
          message: "Portable archive verification failed locally; Core import was not called.",
          context: { diagnostic_count: verification.diagnostics.length },
        }),
        ...verification.diagnostics,
      ],
      nextAction: {
        type: "run_command",
        message: "Run `run402 archives verify <archive> --json`, fix the archive issue, then retry import.",
      },
    });
  }

  const secretValues = {
    ...(opts.envFile ? await readEnvFile(opts.envFile) : {}),
    ...(opts.secretValues ?? {}),
  };

  const staged = await stageArchiveForCoreImport(archivePath, verification);
  try {
    const coreUrl = normalizeCoreUrl(opts.coreUrl);
    let res: Response;
    try {
      res = await fetch(`${coreUrl}/archives/v1/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          archive_path: staged.archivePath,
          name: opts.name,
          dry_run: opts.dryRun ?? false,
          require_runnable: opts.requireRunnable ?? false,
          secret_values: secretValues,
        }),
      });
    } catch (err) {
      throw new NetworkError(
        `Network error while importing archive into Core: ${(err as Error).message}`,
        err,
        "importing archive into Core",
      );
    }

    const body = await parseJsonBody(res);
    if (isImportResult(body)) return body;
    if (!res.ok) {
      return failedImportResult({
        archiveDigest: verification.archive_digest,
        requiredSecrets: verification.required_secrets,
        diagnostics: [
          diagnostic({
            code: bodyErrorCode(body),
            resourceType: "core_import",
            message: bodyErrorMessage(body, `Core import failed with HTTP ${res.status}.`),
            retryable: res.status >= 500 || res.status === 429,
            context: {
              http_status: res.status,
              core_url: coreUrl,
              body: safeBodyContext(body),
            },
          }),
        ],
        nextAction: {
          type: res.status >= 500 ? "retry_later" : "read_docs",
          message: "Fix the reported Core import error and retry.",
        },
      });
    }
    return failedImportResult({
      archiveDigest: verification.archive_digest,
      requiredSecrets: verification.required_secrets,
      diagnostics: [
        diagnostic({
          code: "IMPORT_CONFORMANCE_FAILED",
          resourceType: "core_import",
          message: "Core import returned an unexpected success body.",
          context: { core_url: coreUrl, body: safeBodyContext(body) },
        }),
      ],
      nextAction: {
        type: "contact_support",
        message: "Report the unexpected Core import response with the JSON body.",
      },
    });
  } finally {
    if (staged.cleanupPath) {
      await rm(staged.cleanupPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function readEnvFile(envFile: string): Promise<Record<string, string>> {
  const fullPath = path.resolve(envFile);
  const text = await readFile(fullPath, "utf8");
  const values: Record<string, string> = {};
  let lineNo = 0;
  for (const originalLine of text.split(/\r?\n/)) {
    lineNo += 1;
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = normalized.indexOf("=");
    if (eq <= 0) {
      throw new LocalError(`Invalid env file line ${lineNo}: expected KEY=value`, "reading archive env file", {
        code: "INVALID_ENV_FILE",
        details: { path: fullPath, line: lineNo },
      });
    }
    const key = normalized.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new LocalError(`Invalid env var name on line ${lineNo}: ${key}`, "reading archive env file", {
        code: "INVALID_ENV_FILE",
        details: { path: fullPath, line: lineNo, key },
      });
    }
    values[key] = parseEnvValue(normalized.slice(eq + 1).trim());
  }
  return values;
}

async function stageArchiveForCoreImport(
  archivePath: string,
  verification: ArchiveVerifyResult,
): Promise<{ archivePath: string; cleanupPath: string | null }> {
  if (verification.transport === "directory") {
    return { archivePath, cleanupPath: null };
  }
  if (verification.transport !== "tar") {
    throw new LocalError("Core import supports directory or uncompressed tar archives only.", "staging archive for Core import", {
      code: "ARCHIVE_MEDIA_TYPE_UNSUPPORTED",
      details: { transport: verification.transport },
    });
  }
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "run402-archive-"));
  await extractUncompressedTar(archivePath, tmpRoot);
  return { archivePath: tmpRoot, cleanupPath: tmpRoot };
}

async function verifyLocalPortableArchive(archivePath: string): Promise<ArchiveVerifyResult> {
  const diagnostics: ArchiveDiagnostic[] = [];
  let archive: ArchiveEntries;
  try {
    archive = await readArchiveEntries(archivePath);
  } catch (err) {
    const d = errorToDiagnostic(err);
    return {
      ok: false,
      archive_version: null,
      archive_digest: null,
      transport: null,
      file_count: 0,
      total_bytes: 0,
      descriptor_count: 0,
      required_capabilities: [],
      required_secrets: [],
      auth_subject_stub_count: 0,
      export_report: null,
      portability_report: null,
      diagnostics: [d],
    };
  }

  const layout = parseJsonEntry<Record<string, unknown>>(archive, "run402-layout.json", diagnostics);
  const index = parseJsonEntry<ArchiveIndex>(archive, "index.json", diagnostics);
  let archiveDigest: `sha256:${string}` | null = null;
  let requiredSecrets: ArchiveSecretRequirement[] = [];
  let authSubjectStubCount = 0;
  let exportReport: ArchiveExportReport | null = null;
  let portabilityReport: ArchivePortabilityReport | null = null;

  if (layout && layout.archive_version !== PROJECT_ARCHIVE_VERSION) {
    diagnostics.push(diagnostic({
      code: "ARCHIVE_UNSUPPORTED_VERSION",
      resourceType: "layout",
      path: "run402-layout.json",
      message: "Archive layout version is not supported.",
      context: { archive_version: layout.archive_version },
    }));
  }
  if (!index) {
    diagnostics.push(diagnostic({
      code: "ARCHIVE_DESCRIPTOR_MISSING",
      resourceType: "archive",
      path: "index.json",
      message: "Portable archive is missing index.json.",
    }));
  } else {
    if (index.archive_version !== PROJECT_ARCHIVE_VERSION) {
      diagnostics.push(diagnostic({
        code: "ARCHIVE_UNSUPPORTED_VERSION",
        resourceType: "archive",
        path: "index.json",
        message: "Archive version is not supported.",
        context: { archive_version: index.archive_version },
      }));
    }
    for (const cap of index.required_capabilities ?? []) {
      if (!SUPPORTED_CAPABILITIES.has(cap)) {
        diagnostics.push(diagnostic({
          code: "ARCHIVE_UNSUPPORTED_REQUIRED_CAPABILITY",
          resourceType: "capability",
          resourceId: cap,
          message: `Archive requires unsupported capability ${cap}.`,
          context: { capability: cap },
        }));
      }
    }
    verifyDescriptors(index, archive, diagnostics);
    archiveDigest = computeLogicalDigest(index);
    if (index.archive_digest && index.archive_digest !== archiveDigest) {
      diagnostics.push(diagnostic({
        code: "ARCHIVE_DIGEST_MISMATCH",
        resourceType: "archive",
        path: "index.json",
        message: "Archive logical digest does not match index.json.",
        context: { expected_digest: index.archive_digest, actual_digest: archiveDigest },
      }));
    }
    exportReport = readJsonDescriptor<ArchiveExportReport>(index, archive, "export_report", diagnostics);
    portabilityReport = readJsonDescriptor<ArchivePortabilityReport>(index, archive, "portability_report", diagnostics);
    const secretRequirements = readJsonDescriptor<{ secrets?: ArchiveSecretRequirement[] }>(
      index,
      archive,
      "secret_requirements",
      diagnostics,
    );
    requiredSecrets = Array.isArray(secretRequirements?.secrets)
      ? secretRequirements.secrets.filter((s) => typeof s?.name === "string")
      : [];
    authSubjectStubCount = countAuthSubjectStubs(index, archive);
    if (Array.isArray(portabilityReport?.entries)) {
      diagnostics.push(...portabilityReport.entries.filter(isArchiveDiagnostic));
    }
  }

  return {
    ok: !diagnostics.some((d) => d.severity === "blocking"),
    archive_version: index?.archive_version === PROJECT_ARCHIVE_VERSION ? PROJECT_ARCHIVE_VERSION : null,
    archive_digest: archiveDigest,
    transport: archive.transport,
    file_count: archive.entries.size,
    total_bytes: archive.totalBytes,
    descriptor_count: index?.descriptors ? Object.keys(index.descriptors).length : 0,
    required_capabilities: Array.isArray(index?.required_capabilities) ? index.required_capabilities : [],
    required_secrets: requiredSecrets,
    auth_subject_stub_count: authSubjectStubCount,
    export_report: exportReport,
    portability_report: portabilityReport,
    diagnostics,
  };
}

async function readArchiveEntries(archivePath: string): Promise<ArchiveEntries> {
  const st = await lstat(archivePath);
  if (st.isDirectory()) {
    const entries = new Map<string, Uint8Array>();
    let totalBytes = 0;
    async function walk(current: string, relBase: string): Promise<void> {
      const dir = await opendir(current);
      for await (const entry of dir) {
        const abs = path.join(current, entry.name);
        const rel = path.posix.join(relBase, entry.name);
        const childStat = await lstat(abs);
        if (childStat.isSymbolicLink()) {
          throw new LocalError(`Archive contains unsupported symlink: ${rel}`, "reading archive", {
            code: "ARCHIVE_ENTRY_TYPE_UNSUPPORTED",
            details: { path: rel },
          });
        }
        if (childStat.isDirectory()) {
          await walk(abs, rel);
        } else if (childStat.isFile()) {
          const safeRel = sanitizeTarPath(rel);
          if (entries.has(safeRel)) {
            throw new LocalError(`Duplicate archive path: ${safeRel}`, "reading archive", {
              code: "ARCHIVE_DUPLICATE_PATH",
              details: { path: safeRel },
            });
          }
          const bytes = await readFile(abs);
          entries.set(safeRel, bytes);
          totalBytes += bytes.byteLength;
        } else {
          throw new LocalError(`Archive contains unsupported entry: ${rel}`, "reading archive", {
            code: "ARCHIVE_ENTRY_TYPE_UNSUPPORTED",
            details: { path: rel },
          });
        }
      }
    }
    await walk(archivePath, "");
    return { entries, transport: "directory", totalBytes };
  }
  if (!st.isFile()) {
    throw new LocalError("Archive path must be a directory or uncompressed tar file.", "reading archive", {
      code: "ARCHIVE_ENTRY_TYPE_UNSUPPORTED",
    });
  }
  return readTarEntries(archivePath);
}

async function readTarEntries(tarPath: string): Promise<ArchiveEntries> {
  const bytes = await readFile(tarPath);
  const entries = new Map<string, Uint8Array>();
  let totalBytes = 0;
  let offset = 0;
  while (offset + TAR_BLOCK_BYTES <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK_BYTES);
    offset += TAR_BLOCK_BYTES;
    if (header.equals(ZERO_BLOCK)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const type = readTarString(header, 156, 1) || "0";
    const size = readTarOctal(header, 124, 12);
    const rel = sanitizeTarPath(prefix ? `${prefix}/${name}` : name);
    if (entries.has(rel)) {
      throw new LocalError(`Duplicate archive path: ${rel}`, "reading archive tar", {
        code: "ARCHIVE_DUPLICATE_PATH",
        details: { path: rel },
      });
    }
    if (type === "5") {
      offset += Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
      continue;
    }
    if (type !== "0" && type !== "\0") {
      throw new LocalError(`Unsupported tar entry type ${JSON.stringify(type)} at ${rel}`, "reading archive tar", {
        code: "ARCHIVE_ENTRY_TYPE_UNSUPPORTED",
        details: { path: rel, type },
      });
    }
    const end = offset + size;
    if (end > bytes.byteLength) {
      throw new LocalError("Malformed tar: entry exceeds file size", "reading archive tar", {
        code: "ARCHIVE_MALFORMED_TAR",
        details: { path: rel },
      });
    }
    const payload = bytes.subarray(offset, end);
    entries.set(rel, payload);
    totalBytes += payload.byteLength;
    offset += Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
  }
  return { entries, transport: "tar", totalBytes };
}

function parseJsonEntry<T>(archive: ArchiveEntries, relPath: string, diagnostics: ArchiveDiagnostic[]): T | null {
  const bytes = archive.entries.get(relPath);
  if (!bytes) {
    diagnostics.push(diagnostic({
      code: "ARCHIVE_DESCRIPTOR_MISSING",
      resourceType: "descriptor",
      path: relPath,
      message: `Archive descriptor ${relPath} is missing.`,
    }));
    return null;
  }
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
  } catch (err) {
    diagnostics.push(diagnostic({
      code: "ARCHIVE_MALFORMED_JSON",
      resourceType: "descriptor",
      path: relPath,
      message: `Archive descriptor ${relPath} is not valid JSON.`,
      context: { error: (err as Error).message },
    }));
    return null;
  }
}

function readJsonDescriptor<T>(
  index: ArchiveIndex,
  archive: ArchiveEntries,
  key: string,
  diagnostics: ArchiveDiagnostic[],
): T | null {
  const descriptor = index.descriptors?.[key];
  const relPath = descriptor?.path ?? fallbackDescriptorPath(key);
  if (!relPath || !archive.entries.has(relPath)) return null;
  return parseJsonEntry<T>(archive, relPath, diagnostics);
}

function fallbackDescriptorPath(key: string): string | null {
  switch (key) {
    case "export_report": return "manifest/export-report.json";
    case "portability_report": return "manifest/portability-report.json";
    case "secret_requirements": return "secrets/requirements.json";
    case "auth_subjects": return "auth/subjects.ndjson";
    default: return null;
  }
}

function verifyDescriptors(index: ArchiveIndex, archive: ArchiveEntries, diagnostics: ArchiveDiagnostic[]): void {
  for (const [name, descriptor] of Object.entries(index.descriptors ?? {})) {
    if (!descriptor.path) continue;
    let rel: string;
    try {
      rel = sanitizeTarPath(descriptor.path);
    } catch (err) {
      diagnostics.push(errorToDiagnostic(err));
      continue;
    }
    const bytes = archive.entries.get(rel);
    if (!bytes) {
      diagnostics.push(diagnostic({
        code: descriptor.mediaType === "application/octet-stream" ? "ARCHIVE_BLOB_MISSING" : "ARCHIVE_DESCRIPTOR_MISSING",
        resourceType: "descriptor",
        resourceId: name,
        path: rel,
        message: `Archive descriptor ${name} references missing path ${rel}.`,
      }));
      continue;
    }
    if (typeof descriptor.size === "number" && descriptor.size !== bytes.byteLength) {
      diagnostics.push(diagnostic({
        code: "ARCHIVE_SIZE_MISMATCH",
        resourceType: "descriptor",
        resourceId: name,
        path: rel,
        message: `Archive descriptor ${name} size mismatch.`,
        context: { expected_size: descriptor.size, actual_size: bytes.byteLength },
      }));
    }
    if (descriptor.digest && descriptor.digest !== digestBytes(bytes)) {
      diagnostics.push(diagnostic({
        code: "ARCHIVE_DIGEST_MISMATCH",
        resourceType: "descriptor",
        resourceId: name,
        path: rel,
        message: `Archive descriptor ${name} digest mismatch.`,
        context: { expected_digest: descriptor.digest, actual_digest: digestBytes(bytes) },
      }));
    }
  }
}

function computeLogicalDigest(index: ArchiveIndex): `sha256:${string}` {
  const descriptors = [...(index.identity_descriptors ?? [])].sort().map((name) => {
    const d = index.descriptors?.[name];
    return { name, mediaType: d?.mediaType, digest: d?.digest, size: d?.size, path: d?.path };
  });
  return digestBytes(Buffer.from(stableJson({
    identity: PROJECT_ARCHIVE_DIGEST_IDENTITY,
    archive_version: index.archive_version,
    core_compatibility: (index as { core_compatibility?: unknown }).core_compatibility,
    required_capabilities: [...(index.required_capabilities ?? [])].sort(),
    consistency: (index as { consistency?: unknown }).consistency ?? null,
    descriptors,
  }), "utf8"));
}

function countAuthSubjectStubs(index: ArchiveIndex, archive: ArchiveEntries): number {
  const rel = index.descriptors?.auth_subjects?.path ?? "auth/subjects.ndjson";
  const bytes = archive.entries.get(rel);
  if (!bytes) return 0;
  return Buffer.from(bytes).toString("utf8").split(/\r?\n/).filter((line) => line.trim()).length;
}

function digestBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(",")}}`;
}

function isArchiveDiagnostic(value: unknown): value is ArchiveDiagnostic {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).code === "string" &&
      typeof (value as Record<string, unknown>).message === "string",
  );
}

function errorToDiagnostic(err: unknown): ArchiveDiagnostic {
  const message = err instanceof Error ? err.message : String(err);
  const body = err && typeof err === "object" && !Array.isArray(err)
    ? (err as Record<string, unknown>).body
    : null;
  const bodyRecord = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
  const details = bodyRecord?.details && typeof bodyRecord.details === "object" && !Array.isArray(bodyRecord.details)
    ? (bodyRecord.details as Record<string, unknown>)
    : undefined;
  const code =
    (bodyRecord && typeof bodyRecord.code === "string" ? bodyRecord.code : null) ??
    (err && typeof err === "object" && typeof (err as Record<string, unknown>).code === "string"
      ? ((err as Record<string, unknown>).code as string)
      : null) ??
    "IMPORT_VERIFY_FAILED";
  return diagnostic({
    code,
    resourceType: "archive",
    path: typeof details?.path === "string" ? details.path : undefined,
    message,
    context: details,
  });
}

async function extractUncompressedTar(tarPath: string, destDir: string): Promise<void> {
  const bytes = await readFile(tarPath);
  const seen = new Set<string>();
  let offset = 0;
  while (offset + TAR_BLOCK_BYTES <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK_BYTES);
    offset += TAR_BLOCK_BYTES;
    if (header.equals(ZERO_BLOCK)) break;

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const type = readTarString(header, 156, 1) || "0";
    const size = readTarOctal(header, 124, 12);
    const rel = sanitizeTarPath(prefix ? `${prefix}/${name}` : name);
    if (seen.has(rel)) {
      throw new LocalError(`Duplicate archive path while extracting: ${rel}`, "extracting archive tar", {
        code: "ARCHIVE_DUPLICATE_PATH",
        details: { path: rel },
      });
    }
    seen.add(rel);
    const outputPath = path.join(destDir, rel);
    if (!outputPath.startsWith(`${destDir}${path.sep}`)) {
      throw new LocalError(`Unsafe archive path while extracting: ${rel}`, "extracting archive tar", {
        code: "ARCHIVE_PATH_UNSAFE",
        details: { path: rel },
      });
    }

    if (type === "5") {
      await mkdir(outputPath, { recursive: true });
    } else if (type === "0" || type === "\0") {
      const end = offset + size;
      if (end > bytes.byteLength) {
        throw new LocalError("Malformed tar: entry exceeds file size", "extracting archive tar", {
          code: "ARCHIVE_MALFORMED_TAR",
          details: { path: rel },
        });
      }
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, bytes.subarray(offset, end));
      await stat(outputPath).then((s) => {
        if (!s.isFile()) {
          throw new LocalError(`Archive entry did not extract as a regular file: ${rel}`, "extracting archive tar", {
            code: "ARCHIVE_ENTRY_TYPE_UNSUPPORTED",
            details: { path: rel },
          });
        }
      });
    } else {
      throw new LocalError(`Unsupported tar entry type ${JSON.stringify(type)} at ${rel}`, "extracting archive tar", {
        code: "ARCHIVE_ENTRY_TYPE_UNSUPPORTED",
        details: { path: rel, type },
      });
    }
    offset += Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
  }
}

function readTarString(header: Buffer, start: number, len: number): string {
  const slice = header.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString("utf8").trim();
}

function readTarOctal(header: Buffer, start: number, len: number): number {
  const raw = readTarString(header, start, len).replace(/\0/g, "").trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) {
    throw new LocalError(`Malformed tar octal value: ${raw}`, "extracting archive tar", {
      code: "ARCHIVE_MALFORMED_TAR",
    });
  }
  return Number.parseInt(raw, 8);
}

function sanitizeTarPath(value: string): string {
  const normalized = path.posix.normalize(value);
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    /[\x00-\x1f\x7f]/.test(normalized)
  ) {
    throw new LocalError(`Unsafe archive path: ${value}`, "extracting archive tar", {
      code: "ARCHIVE_PATH_UNSAFE",
      details: { path: value },
    });
  }
  return normalized;
}

function parseEnvValue(raw: string): string {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  const comment = raw.search(/\s#/);
  return (comment === -1 ? raw : raw.slice(0, comment)).trim();
}

function normalizeCoreUrl(value: string | undefined): string {
  return (value ?? process.env.RUN402_CORE_URL ?? process.env.CORE_GATEWAY_URL ?? DEFAULT_CORE_URL).replace(/\/+$/, "");
}

async function parseJsonBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: "NON_JSON_RESPONSE", message: text.slice(0, 500) };
  }
}

function isImportResult(value: unknown): value is ArchiveImportResult {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).schema_version === "run402.project_archive.import_result.v1",
  );
}

function failedImportResult(input: {
  archiveDigest: ArchiveImportResult["archive_digest"];
  requiredSecrets: ArchiveImportResult["required_secrets"];
  diagnostics: ArchiveDiagnostic[];
  nextAction: ArchiveImportResult["next_action"];
}): ArchiveImportResult {
  return {
    schema_version: "run402.project_archive.import_result.v1",
    status: "failed",
    archive_digest: input.archiveDigest,
    required_secrets: input.requiredSecrets,
    diagnostics: input.diagnostics,
    next_action: input.nextAction,
  };
}

function diagnostic(input: {
  code: string;
  resourceType: string;
  message: string;
  resourceId?: string;
  path?: string;
  retryable?: boolean;
  context?: Record<string, unknown>;
}): ArchiveDiagnostic {
  return {
    code: input.code,
    severity: "blocking",
    resource_type: input.resourceType,
    ...(input.resourceId ? { resource_id: input.resourceId } : {}),
    ...(input.path ? { path: input.path } : {}),
    message: input.message,
    next_action: { type: "read_docs", message: "Review the archive diagnostic and retry." },
    retryable: input.retryable ?? false,
    ...(input.context ? { context: input.context } : {}),
  };
}

function bodyErrorCode(body: unknown): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const obj = body as Record<string, unknown>;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.code === "string") return obj.code;
  }
  return "IMPORT_CONFORMANCE_FAILED";
}

function bodyErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const obj = body as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
  }
  return fallback;
}

function safeBodyContext(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const { details, ...rest } = body as Record<string, unknown>;
  return {
    ...rest,
    ...(details && typeof details === "object" && !Array.isArray(details)
      ? { details: redactContext(details as Record<string, unknown>) }
      : {}),
  };
}

function redactContext(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (/secret|token|password|credential|private/i.test(key)) {
      out[key] = "[redacted]";
    } else {
      out[key] = value;
    }
  }
  return out;
}
