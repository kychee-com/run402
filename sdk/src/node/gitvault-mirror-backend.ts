/**
 * gitvault-mirror-and-recover — mirror storage backends (design D1/D2/D7,
 * task 2.2).
 *
 * S3-or-directory behind ONE interface, so the writer/reconcile engine
 * (`gitvault-mirror.ts`) and the recovery engine (`gitvault-recover.ts`)
 * never know which one they are talking to.
 *
 * `@run402/sdk` deliberately carries no AWS SDK dependency (see the package's
 * own dependency list — every crypto primitive is a narrowly-scoped,
 * individually-audited package, never a broad vendor SDK). The S3 backend
 * here is therefore a MINIMAL, hand-rolled AWS Signature Version 4 client
 * (Node's built-in `fetch` + `node:crypto`), covering exactly the four
 * operations the mirror needs: HEAD (existence/size), PUT (create-only where
 * the bucket honors `If-None-Match`), GET, and `ListObjectsV2`. This is a
 * DELIBERATE, DOCUMENTED SCOPE LIMIT: it does not implement the full AWS SDK
 * credential provider chain (no IMDS/EC2-role, no SSO, no assume-role) — only
 * the two mechanisms design D2 names: a NAMED PROFILE read from the
 * standard `~/.aws/credentials` + `~/.aws/config` files, and the AMBIENT
 * environment chain (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/
 * `AWS_SESSION_TOKEN`). Multipart upload is out of scope too — gitvault
 * objects are already capped well under S3's 5 GiB single-PUT limit by the
 * protocol's own object-size bounds (§4.6/§4.7).
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LocalError } from "../errors.js";
import type { GitvaultMirrorCredential, GitvaultMirrorDestination } from "./gitvault-mirror-config.js";

function fail(code: string, message: string, context: string, details?: unknown, nextActions?: unknown[]): never {
  throw new LocalError(message, context, { code, details, ...(nextActions ? { next_actions: nextActions } : {}) });
}

// ─── The interface ────────────────────────────────────────────────────────────

export interface GitvaultMirrorObjectMeta {
  size_bytes: string;
}

/**
 * gitvault-byo-primary-bucket task 3.1 — allocation-time bucket probe
 * (design D6): does this destination honor create-only `if-none-match`
 * writes, is bucket versioning off, and is a write actually permitted? Every
 * property is checked independently so a refusal names EXACTLY which one
 * failed, never a bundled "something is wrong". `detail` carries the
 * underlying HTTP/network fact for the property that failed — never a
 * credential, never bytes.
 */
export interface GitvaultBucketProbeResult {
  write_permitted: boolean;
  create_only_honored: boolean;
  versioning_off: boolean;
  detail?: string;
}

/**
 * Storage-agnostic mirror backend. Every method addresses a KEY relative to
 * the mirror's own root — the writer is responsible for using the exact same
 * key the gateway's objects listing names (§3 layout), so the mirror is a
 * byte-for-byte replica of `source/<repo_id>/` under the destination.
 */
export interface GitvaultMirrorBackend {
  /** A human-readable description of where this backend writes (for status/errors — never a credential). */
  describe(): string;
  /** `null` when the key is absent. */
  head(key: string): Promise<GitvaultMirrorObjectMeta | null>;
  /** Read the full bytes, or `null` when absent. */
  get(key: string): Promise<Uint8Array | null>;
  /**
   * Write bytes, create-only where the destination supports it (D7: "where
   * the destination honors if-none-match, recommended not required"). Returns
   * `created: false` when the key already existed — the caller decides
   * whether that is a benign dedup (matching size, matching hash) or a real
   * conflict.
   */
  putCreateOnly(key: string, bytes: Uint8Array): Promise<{ created: boolean }>;
  /** Every key under `prefix` (default: every key in the mirror), sorted. */
  list(prefix?: string): Promise<string[]>;
  /**
   * gitvault-byo-primary-bucket task 3.1 — the allocation-time bucket-policy
   * probe (design D6): create-only `if-none-match` honored, versioning off,
   * write permitted. Never throws on a failed property — it REPORTS the
   * three independent facts; the caller ({@link probeGitvaultByoDestination}
   * in `gitvault-byo-probe.js`) decides whether to refuse and names which
   * property failed. A backend implementation MAY throw for a genuinely
   * unexpected transport failure (network/DNS) rather than reporting a
   * property as false — the caller treats a thrown probe identically to a
   * failed one.
   */
  probeWritePolicy(): Promise<GitvaultBucketProbeResult>;
}

// ─── Directory backend ────────────────────────────────────────────────────────

/**
 * A local (or network-mounted) directory, laid out identically to the bucket
 * (`<root>/source/<repo_id>/head/<gen>`, etc. — but the backend is
 * repo-scoped, so `root` IS already `<destination>/source/<repo_id>`). Writes
 * are atomic (temp file + rename); create-only is REAL create-only via
 * `wx` (`O_CREAT|O_EXCL`) — never a silent overwrite of a differently-keyed
 * torn write.
 */
export class DirectoryMirrorBackend implements GitvaultMirrorBackend {
  constructor(private readonly root: string) {}

  describe(): string {
    return this.root;
  }

  private resolve(key: string): string {
    if (key.includes("..") || key.startsWith("/")) fail("GITVAULT_MIRROR_KEY_INVALID", `unsafe mirror key: ${key}`, "resolving gitvault mirror path", { key });
    return join(this.root, ...key.split("/"));
  }

  async head(key: string): Promise<GitvaultMirrorObjectMeta | null> {
    const path = this.resolve(key);
    if (!existsSync(path)) return null;
    const st = statSync(path);
    if (!st.isFile()) return null;
    return { size_bytes: String(st.size) };
  }

  async get(key: string): Promise<Uint8Array | null> {
    const path = this.resolve(key);
    if (!existsSync(path)) return null;
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      return null;
    }
  }

  async putCreateOnly(key: string, bytes: Uint8Array): Promise<{ created: boolean }> {
    const path = this.resolve(key);
    if (existsSync(path)) return { created: false };
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, bytes, { flag: "wx" });
    try {
      // Real create-only: `wx` on the FINAL path too, so a concurrent writer
      // racing us loses the rename, not the data — the loser's temp file is
      // cleaned up and it reports `created: false` (the winner's bytes are
      // trusted; the caller compares hashes if it cares which one landed).
      renameSync(tmp, path);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        /* best-effort cleanup */
      }
      if ((e as NodeJS.ErrnoException).code === "EEXIST" || existsSync(path)) return { created: false };
      throw e;
    }
    return { created: true };
  }

  async list(prefix = ""): Promise<string[]> {
    const out: string[] = [];
    const walk = (dir: string, rel: string): void => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.endsWith(".tmp")) continue;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        const childAbs = join(dir, entry.name);
        if (entry.isDirectory()) walk(childAbs, childRel);
        else if (entry.isFile()) out.push(childRel);
      }
    };
    walk(this.root, "");
    return out.filter((k) => k.startsWith(prefix)).sort();
  }

  /**
   * A local (or network-mounted) directory trivially satisfies every
   * property: there is no versioning concept, and create-only is REAL
   * create-only (see the class doc). `write_permitted` is still actually
   * EXERCISED (not assumed) — a read-only mount or missing permission fails
   * it honestly rather than reporting a directory backend as always-write.
   */
  async probeWritePolicy(): Promise<GitvaultBucketProbeResult> {
    const key = `_byo-probe/${randomBytes(16).toString("hex")}`;
    try {
      const first = await this.putCreateOnly(key, new TextEncoder().encode("gitvault-byo-primary-bucket allocation probe"));
      if (!first.created) return { write_permitted: false, create_only_honored: false, versioning_off: true, detail: "probe key already existed (unexpected — a fresh random key collided)" };
      const second = await this.putCreateOnly(key, new TextEncoder().encode("gitvault-byo-primary-bucket allocation probe — second write"));
      return { write_permitted: true, create_only_honored: !second.created, versioning_off: true };
    } catch (e) {
      return { write_permitted: false, create_only_honored: false, versioning_off: true, detail: e instanceof Error ? e.message : String(e) };
    }
  }
}

// ─── S3 backend (minimal hand-rolled SigV4; see the module doc for scope) ────

interface Sigv4Credentials {
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function amzDate(now: Date): { date: string; dateTime: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { dateTime: `${iso}`, date: iso.slice(0, 8) };
}

function signingKey(secretKey: string, date: string, region: string, service: string): Buffer {
  const kDate = hmacSha256(`AWS4${secretKey}`, date);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

/** One SigV4-signed request against an S3-compatible endpoint. */
async function s3Request(input: {
  method: "GET" | "PUT" | "HEAD";
  bucket: string;
  region: string;
  endpoint?: string;
  key: string;
  query?: Record<string, string>;
  credentials: Sigv4Credentials;
  body?: Uint8Array;
  extraHeaders?: Record<string, string>;
}): Promise<Response> {
  const host = input.endpoint ? new URL(input.endpoint).host : `${input.bucket}.s3.${input.region}.amazonaws.com`;
  const proto = input.endpoint ? new URL(input.endpoint).protocol.replace(":", "") : "https";
  const canonicalUri = `/${input.key.split("/").map(encodeURIComponent).join("/")}`;
  const query = { ...(input.query ?? {}) };
  const sortedQueryKeys = Object.keys(query).sort();
  const canonicalQuery = sortedQueryKeys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k]!)}`).join("&");
  const now = new Date();
  const { date, dateTime } = amzDate(now);
  const bodyHash = sha256Hex(Buffer.from(input.body ?? new Uint8Array(0)));
  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": bodyHash,
    "x-amz-date": dateTime,
    ...(input.credentials.session_token ? { "x-amz-security-token": input.credentials.session_token } : {}),
    ...(input.extraHeaders ?? {}),
  };
  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${headers[k]!.trim()}\n`).join("");
  const signedHeaders = sortedHeaderKeys.join(";");
  const canonicalRequest = [input.method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, bodyHash].join("\n");
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", dateTime, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = signingKey(input.credentials.secret_access_key, date, input.region, "s3");
  const signature = createHmac("sha256", key).update(stringToSign, "utf8").digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.access_key_id}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = `${proto}://${host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
  return fetch(url, {
    method: input.method,
    headers: { ...headers, authorization },
    ...(input.body ? { body: input.body as unknown as BodyInit } : {}),
  });
}

/** Resolve a NAMED PROFILE (`~/.aws/credentials` + `~/.aws/config`) or the AMBIENT environment chain — see the module doc's documented scope limit. */
export function resolveMirrorCredentials(credential: GitvaultMirrorCredential): Sigv4Credentials {
  if (credential.kind === "ambient") {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) {
      fail("GITVAULT_MIRROR_CREDENTIALS_UNRESOLVED", "no ambient AWS credentials found (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY unset)", "resolving gitvault mirror credentials", undefined, [{ action: "export AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or configure a named profile with `run402 repos mirror <destination> --profile <name>`" }]);
    }
    return { access_key_id: accessKeyId, secret_access_key: secretAccessKey, ...(process.env.AWS_SESSION_TOKEN ? { session_token: process.env.AWS_SESSION_TOKEN } : {}) };
  }
  const credsPath = join(homedir(), ".aws", "credentials");
  let text: string;
  try {
    text = readFileSync(credsPath, "utf8");
  } catch {
    fail("GITVAULT_MIRROR_CREDENTIALS_UNRESOLVED", `no AWS credentials file at ${credsPath}`, "resolving gitvault mirror credentials", { profile: credential.profile }, [{ action: `run 'aws configure --profile ${credential.profile}', or configure the destination for --ambient credentials instead` }]);
  }
  const section = parseIniSection(text, credential.profile);
  const accessKeyId = section.aws_access_key_id;
  const secretAccessKey = section.aws_secret_access_key;
  if (!accessKeyId || !secretAccessKey) {
    fail("GITVAULT_MIRROR_CREDENTIALS_UNRESOLVED", `profile '${credential.profile}' is missing aws_access_key_id/aws_secret_access_key in ${credsPath}`, "resolving gitvault mirror credentials", { profile: credential.profile }, [{ action: `run 'aws configure --profile ${credential.profile}'` }]);
  }
  return { access_key_id: accessKeyId, secret_access_key: secretAccessKey, ...(section.aws_session_token ? { session_token: section.aws_session_token } : {}) };
}

/** A minimal INI-section parser — no dependency, no more than the shape `~/.aws/credentials` actually needs. */
function parseIniSection(text: string, section: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inSection = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      inSection = header[1]!.trim() === section;
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

export class S3MirrorBackend implements GitvaultMirrorBackend {
  constructor(
    private readonly bucket: string,
    private readonly prefix: string,
    private readonly region: string,
    private readonly credential: GitvaultMirrorCredential,
    private readonly endpoint?: string,
  ) {}

  describe(): string {
    return `s3://${this.bucket}/${this.prefix}`;
  }

  private fullKey(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  private creds(): Sigv4Credentials {
    return resolveMirrorCredentials(this.credential);
  }

  async head(key: string): Promise<GitvaultMirrorObjectMeta | null> {
    const r = await s3Request({ method: "HEAD", bucket: this.bucket, region: this.region, endpoint: this.endpoint, key: this.fullKey(key), credentials: this.creds() });
    if (r.status === 404) return null;
    if (!r.ok) fail("GITVAULT_MIRROR_S3_ERROR", `HEAD ${key} failed (HTTP ${r.status})`, "reading gitvault mirror object", { key, status: r.status });
    const len = r.headers.get("content-length");
    return { size_bytes: len ?? "0" };
  }

  async get(key: string): Promise<Uint8Array | null> {
    const r = await s3Request({ method: "GET", bucket: this.bucket, region: this.region, endpoint: this.endpoint, key: this.fullKey(key), credentials: this.creds() });
    if (r.status === 404) return null;
    if (!r.ok) fail("GITVAULT_MIRROR_S3_ERROR", `GET ${key} failed (HTTP ${r.status})`, "reading gitvault mirror object", { key, status: r.status });
    return new Uint8Array(await r.arrayBuffer());
  }

  async putCreateOnly(key: string, bytes: Uint8Array): Promise<{ created: boolean }> {
    // `If-None-Match: *` create-only PUT — the same conditional-write
    // mechanism the primary vault bucket's own policy mandates (protocol
    // §3). Documented as "recommended, not required" (design D7): this is
    // the customer's bucket and their policy, so a provider/bucket that
    // rejects the header (older buckets, some S3-compatible stores) falls
    // back to read-and-compare instead of hard-failing the sync.
    const r = await s3Request({
      method: "PUT",
      bucket: this.bucket,
      region: this.region,
      endpoint: this.endpoint,
      key: this.fullKey(key),
      credentials: this.creds(),
      body: bytes,
      extraHeaders: { "if-none-match": "*", "content-length": String(bytes.length) },
    });
    if (r.status === 412 || r.status === 409) return { created: false };
    if (r.ok) return { created: true };
    if (r.status === 400 || r.status === 501) {
      // The condition itself was rejected (unsupported by this bucket/provider)
      // rather than failing — read-and-compare fallback.
      const existing = await this.head(key);
      if (existing) return { created: false };
      const retry = await s3Request({ method: "PUT", bucket: this.bucket, region: this.region, endpoint: this.endpoint, key: this.fullKey(key), credentials: this.creds(), body: bytes, extraHeaders: { "content-length": String(bytes.length) } });
      if (!retry.ok) fail("GITVAULT_MIRROR_S3_ERROR", `PUT ${key} failed (HTTP ${retry.status})`, "writing gitvault mirror object", { key, status: retry.status });
      return { created: true };
    }
    fail("GITVAULT_MIRROR_S3_ERROR", `PUT ${key} failed (HTTP ${r.status})`, "writing gitvault mirror object", { key, status: r.status });
  }

  async list(prefix = ""): Promise<string[]> {
    const out: string[] = [];
    let continuationToken: string | undefined;
    const fullPrefix = this.fullKey(prefix);
    for (;;) {
      const query: Record<string, string> = { "list-type": "2", prefix: fullPrefix };
      if (continuationToken) query["continuation-token"] = continuationToken;
      const r = await s3Request({ method: "GET", bucket: this.bucket, region: this.region, endpoint: this.endpoint, key: "", query, credentials: this.creds() });
      if (!r.ok) fail("GITVAULT_MIRROR_S3_ERROR", `ListObjectsV2 failed (HTTP ${r.status})`, "listing gitvault mirror objects", { status: r.status });
      const xml = await r.text();
      for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) {
        const full = decodeXmlEntities(m[1]!);
        out.push(this.prefix ? full.slice(this.prefix.length + 1) : full);
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      if (!truncated) break;
      const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml);
      if (!next) break;
      continuationToken = decodeXmlEntities(next[1]!);
    }
    return out.sort();
  }

  /**
   * gitvault-byo-primary-bucket task 3.1 (design D6). Deliberately does NOT
   * reuse {@link putCreateOnly}'s own read-and-compare fallback for a bucket
   * that rejects the `if-none-match` header (400/501): that fallback is a
   * best-effort DEGRADATION for ordinary writes, and the whole point of the
   * probe is to report the STRICT signal — does this bucket actually
   * enforce atomic create-only writes — so a bucket that cannot even
   * understand the condition is correctly reported as NOT honoring it,
   * never silently upgraded to "fine, we'll compare after the fact".
   *
   * Runs two independent PUTs at the SAME probe key (create-only, `p1` then
   * `p2` bytes): the first proves `write_permitted`; the second, at the
   * SAME key, proves `create_only_honored` — a bucket that lets the second
   * PUT succeed is silently overwriting, exactly the hazard §3's
   * "versioning disabled + mandatory if-none-match" profile exists to rule
   * out. `versioning_off` is a SEPARATE bucket-level `GET ?versioning` call
   * — a bucket whose versioning state cannot even be READ (e.g. missing
   * `s3:GetBucketVersioning`) is conservatively reported as NOT off, per the
   * fail-closed doctrine (D6): "no vault half-exists" beats "probably fine".
   * "Suspended" versioning is treated as compliant — the hazard the profile
   * guards against (a create-only PUT silently becoming a new object
   * version instead of a real conflict) applies only to `Enabled`.
   */
  async probeWritePolicy(): Promise<GitvaultBucketProbeResult> {
    const key = `_byo-probe/${randomBytes(16).toString("hex")}`;
    const creds = this.creds();
    let writePermitted = false;
    let createOnlyHonored = false;
    let detail: string | undefined;
    try {
      const first = await s3Request({
        method: "PUT", bucket: this.bucket, region: this.region, endpoint: this.endpoint, key: this.fullKey(key), credentials: creds,
        body: new TextEncoder().encode("gitvault-byo-primary-bucket allocation probe"),
        extraHeaders: { "if-none-match": "*" },
      });
      if (!first.ok) {
        detail = `probe PUT failed (HTTP ${first.status})`;
      } else {
        writePermitted = true;
        const second = await s3Request({
          method: "PUT", bucket: this.bucket, region: this.region, endpoint: this.endpoint, key: this.fullKey(key), credentials: creds,
          body: new TextEncoder().encode("gitvault-byo-primary-bucket allocation probe — second write"),
          extraHeaders: { "if-none-match": "*" },
        });
        // 412/409: the condition was evaluated and correctly refused the
        // overwrite — honored. Anything else (2xx overwrote it; 400/501 the
        // bucket did not understand the condition at all) is NOT honored.
        createOnlyHonored = second.status === 412 || second.status === 409;
        if (!createOnlyHonored) detail = second.ok ? "a second create-only PUT to the same key succeeded — this bucket does not enforce if-none-match" : `the condition was not understood (HTTP ${second.status})`;
      }
    } catch (e) {
      detail = e instanceof Error ? e.message : String(e);
    }
    const versioning = await this.probeVersioningOff(creds);
    const combinedDetail = [detail, versioning.detail].filter(Boolean).join("; ") || undefined;
    return { write_permitted: writePermitted, create_only_honored: createOnlyHonored, versioning_off: versioning.off, ...(combinedDetail ? { detail: combinedDetail } : {}) };
  }

  private async probeVersioningOff(creds: Sigv4Credentials): Promise<{ off: boolean; detail?: string }> {
    try {
      const r = await s3Request({ method: "GET", bucket: this.bucket, region: this.region, endpoint: this.endpoint, key: "", query: { versioning: "" }, credentials: creds });
      if (!r.ok) return { off: false, detail: `bucket versioning could not be read (HTTP ${r.status}) — cannot confirm it is disabled` };
      const xml = await r.text();
      const enabled = /<Status>\s*Enabled\s*<\/Status>/.test(xml);
      return enabled ? { off: false, detail: "bucket versioning is Enabled" } : { off: true };
    } catch (e) {
      return { off: false, detail: `bucket versioning could not be read: ${e instanceof Error ? e.message : String(e)} — cannot confirm it is disabled` };
    }
  }
}

function decodeXmlEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (m, entity: string) => {
    switch (entity) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return "\"";
      case "apos": return "'";
      default: return entity.startsWith("#") ? String.fromCharCode(Number(entity.slice(1))) : m;
    }
  });
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/** Open the backend for one vault's mirror config — repo-scoped: the directory backend's root and the S3 prefix both already carry `source/<repo_id>`. */
export function openGitvaultMirrorBackend(destination: GitvaultMirrorDestination, repoId: string, credential?: GitvaultMirrorCredential): GitvaultMirrorBackend {
  if (destination.kind === "directory") {
    return new DirectoryMirrorBackend(join(destination.path, "source", repoId));
  }
  if (!credential) fail("GITVAULT_MIRROR_CREDENTIAL_REQUIRED", "an s3 mirror destination needs a credential", "opening gitvault mirror backend");
  const prefix = destination.prefix ? `${destination.prefix}/source/${repoId}` : `source/${repoId}`;
  return new S3MirrorBackend(destination.bucket, prefix, destination.region, credential, destination.endpoint);
}

/**
 * gitvault-byo-primary-bucket task 3.1 — open a backend at the DESTINATION
 * ROOT, with no `source/<repo_id>` scoping. Two callers need this shape,
 * both because `repo_id` is not (yet) in scope: the allocation-time probe
 * (a fresh destination has no repo_id until allocation MINTS one — the
 * probe writes/reads a `_byo-probe/<random>` key at the destination's own
 * root, never colliding with any vault's `source/<repo_id>/` prefix), and
 * BYO payload writes (task 3.2), whose server-issued `key` already carries
 * the full `source/<repo_id>/...` path — this is the SAME opener
 * {@link discoverMirroredRepoIds} already used inline for mirror discovery,
 * factored out here so it has one implementation instead of two.
 */
export function openGitvaultDestinationBackend(destination: GitvaultMirrorDestination, credential?: GitvaultMirrorCredential): GitvaultMirrorBackend {
  if (destination.kind === "directory") return new DirectoryMirrorBackend(destination.path);
  if (!credential) fail("GITVAULT_MIRROR_CREDENTIAL_REQUIRED", "an s3 destination needs a credential", "opening gitvault destination backend");
  return new S3MirrorBackend(destination.bucket, destination.prefix, destination.region, credential, destination.endpoint);
}

/**
 * List every `repo_id` mirrored under a destination's root (`source/<repo_id>/…`),
 * WITHOUT repo-scoping the backend first — the discovery step `recover
 * <source>` needs before it can even open the repo-scoped backend {@link
 * openGitvaultMirrorBackend} expects. Used only to resolve which vault a bare
 * destination URL (no `--repo`) names.
 */
export async function discoverMirroredRepoIds(destination: GitvaultMirrorDestination, credential?: GitvaultMirrorCredential): Promise<string[]> {
  const root = openGitvaultDestinationBackend(destination, credential);
  const keys = await root.list("source/");
  const ids = new Set<string>();
  for (const key of keys) {
    const m = /^source\/(src_[0-9a-f]{32})\//.exec(key);
    if (m) ids.add(m[1]!);
  }
  return [...ids].sort();
}

/** Best-effort recursive delete of an empty (or now-empty) mirror root — used by `mirror remove --purge` semantics if ever added; NOT called by plain `mirror remove` (design: config removal never touches the customer's bytes). Exported for tests. */
export function _rmMirrorRoot(destination: GitvaultMirrorDestination, repoId: string): void {
  if (destination.kind !== "directory") return;
  rmSync(join(destination.path, "source", repoId), { recursive: true, force: true });
}
