import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "./config.mjs";

export const UPDATE_CHECK_CACHE_VERSION = 1;
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_TIMEOUT_MS = 1500;
export const UPDATE_NOTICE_TYPE = "cli.update_available";

const CLI_PACKAGE_URL = new URL("../package.json", import.meta.url);
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const KNOWN_PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

export function currentRun402Version({ packageUrl = CLI_PACKAGE_URL } = {}) {
  try {
    const pkg = JSON.parse(readFileSync(packageUrl, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function updateCachePath({ dir = configDir() } = {}) {
  return join(dir, "cli-update-check.json");
}

export function readUpdateCache({ path = updateCachePath() } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || parsed.schema_version !== UPDATE_CHECK_CACHE_VERSION) {
      return null;
    }
    if (typeof parsed.checked_at !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeUpdateCache(record, { path = updateCachePath() } = {}) {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({
      schema_version: UPDATE_CHECK_CACHE_VERSION,
      package: "run402",
      ...record,
    }, null, 2) + "\n", { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function isUpdateOptedOut(env = process.env) {
  return envFlag(env.RUN402_NO_UPDATE_CHECK) === true;
}

export function shouldRunLiveUpdateCheck({
  env = process.env,
  stderrIsTTY = process.stderr?.isTTY,
  stdoutIsTTY = process.stdout?.isTTY,
  explicit = false,
} = {}) {
  if (isUpdateOptedOut(env)) return false;
  if (explicit) return true;
  if (envFlag(env.RUN402_UPDATE_CHECK) === true) return true;
  if (isCi(env)) return false;
  return Boolean(stderrIsTTY || stdoutIsTTY);
}

export function isCacheFresh(cache, { now = Date.now(), ttlMs = UPDATE_CHECK_TTL_MS } = {}) {
  if (!cache?.checked_at) return false;
  const checked = Date.parse(cache.checked_at);
  if (!Number.isFinite(checked)) return false;
  return now - checked >= 0 && now - checked < ttlMs;
}

export function npmRegistryBase(env = process.env) {
  const value = env.RUN402_NPM_REGISTRY || env.npm_config_registry || "https://registry.npmjs.org/";
  try {
    const url = new URL(value);
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url.toString();
  } catch {
    return "https://registry.npmjs.org/";
  }
}

export async function fetchLatestRun402Version({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = UPDATE_CHECK_TIMEOUT_MS,
  registry = npmRegistryBase(env),
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is unavailable");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(new URL("run402/latest", registry), {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`npm registry returned HTTP ${res.status}`);
    const body = await res.json();
    const latest = body?.version;
    if (!isValidSemver(latest)) {
      throw new Error("npm registry response did not contain a valid latest version");
    }
    return { latest, registry, checked_at: new Date().toISOString(), source: "registry" };
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshUpdateCheck({
  env = process.env,
  fetchImpl = globalThis.fetch,
  current = currentRun402Version(),
  cachePath = updateCachePath(),
  timeoutMs = UPDATE_CHECK_TIMEOUT_MS,
  registry = npmRegistryBase(env),
} = {}) {
  try {
    const latest = await fetchLatestRun402Version({ env, fetchImpl, timeoutMs, registry });
    const record = {
      current,
      latest: latest.latest,
      checked_at: latest.checked_at,
      source: latest.source,
      registry: latest.registry,
      error: null,
    };
    writeUpdateCache(record, { path: cachePath });
    return { ok: true, ...record };
  } catch (err) {
    const record = {
      current,
      latest: null,
      checked_at: new Date().toISOString(),
      source: "registry",
      registry,
      error: {
        code: errorCode(err),
        message: err instanceof Error ? err.message : String(err),
      },
    };
    writeUpdateCache(record, { path: cachePath });
    return { ok: false, ...record };
  }
}

export function createUpdateCheckScheduler({
  cwd = process.cwd(),
  env = process.env,
  argv = process.argv,
  execPath = process.argv[1],
  current = currentRun402Version(),
  now = Date.now(),
  cachePath = updateCachePath(),
  fetchImpl = globalThis.fetch,
  stderrIsTTY = process.stderr?.isTTY,
  stdoutIsTTY = process.stdout?.isTTY,
  command = ["run402", ...argv.slice(2)],
} = {}) {
  const cache = isUpdateOptedOut(env) ? null : readUpdateCache({ path: cachePath });
  const cachedNotice = cache ? updateNoticeFromRecord(cache, {
    cwd,
    env,
    argv,
    execPath,
    current,
    now,
    command,
    source: "cache",
  }) : null;

  let liveCompleted = false;
  let liveNotice = null;
  let livePromise = null;
  const shouldRefresh = !isUpdateOptedOut(env) &&
    !isCacheFresh(cache, { now }) &&
    shouldRunLiveUpdateCheck({ env, stderrIsTTY, stdoutIsTTY });

  if (shouldRefresh) {
    livePromise = refreshUpdateCheck({ env, fetchImpl, current, cachePath })
      .then((record) => {
        liveNotice = updateNoticeFromRecord(record, {
          cwd,
          env,
          argv,
          execPath,
          current,
          now: Date.now(),
          command,
          source: "registry",
        });
        liveCompleted = true;
        return liveNotice;
      })
      .catch(() => {
        liveCompleted = true;
        return null;
      });
  }

  return {
    cache,
    cachedNotice,
    livePromise,
    getCompletedLiveNotice() {
      return liveCompleted ? liveNotice : null;
    },
  };
}

export async function doctorUpdateCheck({
  refresh = false,
  cwd = process.cwd(),
  env = process.env,
  argv = process.argv,
  execPath = process.argv[1],
  current = currentRun402Version(),
  cachePath = updateCachePath(),
  fetchImpl = globalThis.fetch,
  now = Date.now(),
} = {}) {
  const install = detectInstallContext({ cwd, env, argv, execPath });
  if (isUpdateOptedOut(env)) {
    return {
      name: "cli_update",
      status: "skipped",
      value: {
        current,
        latest: null,
        install_context: install.kind,
        confidence: install.confidence,
        package_manager: install.package_manager,
        cache: { path: cachePath, fresh: false, source: "disabled" },
      },
      hint: "RUN402_NO_UPDATE_CHECK=1 is set.",
    };
  }

  let record = readUpdateCache({ path: cachePath });
  if (refresh) {
    record = await refreshUpdateCheck({ env, fetchImpl, current, cachePath });
  }

  if (!record) {
    return {
      name: "cli_update",
      status: "unknown",
      value: {
        current,
        latest: null,
        install_context: install.kind,
        confidence: install.confidence,
        package_manager: install.package_manager,
        cache: { path: cachePath, fresh: false, source: "none" },
      },
      hint: "No cached npm version check yet. Run 'run402 doctor --refresh' to check now.",
    };
  }

  const freshness = isCacheFresh(record, { now });
  const notice = updateNoticeFromRecord(record, {
    cwd,
    env,
    argv,
    execPath,
    current,
    now,
    command: ["run402", "doctor"],
    source: record.source ?? "cache",
  });
  const comparison = compareSemver(current, record.latest);
  const stale = notice !== null;
  const status = stale ? "warning" : record.latest && comparison !== null ? "ok" : "unknown";
  return {
    name: "cli_update",
    status,
    value: {
      current,
      latest: record.latest ?? null,
      checked_at: record.checked_at,
      install_context: install.kind,
      confidence: install.confidence,
      package_manager: install.package_manager,
      cache: {
        path: cachePath,
        fresh: freshness,
        source: record.source ?? "cache",
        error: record.error ?? null,
      },
      ...(stale ? { next_actions: notice.next_actions } : {}),
    },
    ...(stale
      ? { hint: `A newer run402 CLI is available (${current} -> ${record.latest}).` }
      : record.error
        ? { hint: "Could not check npm for the latest run402 version; other doctor checks still ran." }
        : {}),
  };
}

export function updateNoticeFromRecord(record, {
  cwd = process.cwd(),
  env = process.env,
  argv = process.argv,
  execPath = process.argv[1],
  current = currentRun402Version(),
  now = Date.now(),
  command = ["run402", ...argv.slice(2)],
  source = "cache",
} = {}) {
  if (!record || isUpdateOptedOut(env)) return null;
  const latest = record.latest;
  if (!isValidSemver(current) || !isValidSemver(latest)) return null;
  const comparison = compareSemver(current, latest);
  if (comparison === null || comparison >= 0) return null;
  const install = detectInstallContext({ cwd, env, argv, execPath });
  const next_actions = upgradeNextActions({ install, cwd, command });
  return {
    type: UPDATE_NOTICE_TYPE,
    schema_version: 1,
    severity: "warning",
    package: "run402",
    current,
    latest,
    install_context: install.kind,
    confidence: install.confidence,
    checked_at: record.checked_at ?? new Date(now).toISOString(),
    source,
    next_actions,
  };
}

export function emitUpdateNotice(notice, {
  jsonStream = false,
  quiet = false,
  stdout = console.log,
  stderr = console.error,
} = {}) {
  if (!notice) return false;
  if (jsonStream) {
    stdout(JSON.stringify(notice));
    return true;
  }
  if (quiet) return false;
  stderr(JSON.stringify(notice));
  return true;
}

export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return null;
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease && right.prerelease) return 1;
  if (left.prerelease && !right.prerelease) return -1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function isValidSemver(value) {
  return parseSemver(value) !== null;
}

export function detectInstallContext({
  cwd = process.cwd(),
  env = process.env,
  argv = process.argv,
  execPath = process.argv[1],
  platform = process.platform,
} = {}) {
  const resolvedCwd = safeResolve(cwd);
  const executable = normalizePath(execPath || env._ || "");
  const packageInfos = findPackageAncestry(resolvedCwd);
  const nearestPackageInfo = packageInfos[0] ?? null;
  const run402PackageInfo = packageInfos.find((info) => declaresRun402(info.pkg)) ?? null;
  const workspacePackageInfo = packageInfos.find((info) => hasWorkspaces(info.pkg)) ?? null;
  const packageInfo = run402PackageInfo ?? workspacePackageInfo ?? nearestPackageInfo;
  const packageManager = detectPackageManager({ cwd: resolvedCwd, env, packageInfo });
  const command = detectExecCommand({ env, argv, executable });
  const run402Declared = Boolean(run402PackageInfo);
  const projectRoot = packageInfo?.dir ? normalizePath(packageInfo.dir) : null;
  const executableUnderProject = projectRoot ? isPathInside(executable, projectRoot) : false;
  const localNodeModules = executableUnderProject &&
    (containsPathSegment(executable, "node_modules") || command === "yarn_pnp");
  const packageManagerShim = isPackageManagerShim(executable);
  const globalRun402Path = looksLikeGlobalRun402Path(executable, env, platform);
  const explicitNpxCachePath = containsPathSegment(executable, "_npx");
  const packageExecUsesDeclaredRun402 = run402Declared &&
    !globalRun402Path &&
    !explicitNpxCachePath &&
    (localNodeModules ||
      packageManagerShim ||
      command === "npm_exec" ||
      command === "yarn_pnp" ||
      command === "direct");

  if (!packageExecUsesDeclaredRun402 && (command === "npx" || command === "npm_exec" || command === "bunx")) {
    return {
      kind: "ephemeral_exec",
      confidence: command === "npx" || command === "bunx" ? "high" : "medium",
      package_manager: command === "bunx" ? "bun" : packageManager.name,
      cwd: resolvedCwd,
      package_root: packageInfo?.dir ?? nearestPackageInfo?.dir ?? null,
      reasons: [command],
    };
  }

  if (packageExecUsesDeclaredRun402) {
    return {
      kind: "local_project",
      confidence: localNodeModules || packageManagerShim ? "high" : "medium",
      package_manager: packageManager.name,
      cwd: packageInfo?.dir ?? resolvedCwd,
      package_root: packageInfo?.dir ?? nearestPackageInfo?.dir ?? null,
      reasons: [
        ...(localNodeModules ? ["project_node_modules"] : []),
        ...(packageManagerShim ? ["package_manager_shim"] : []),
        ...(command === "npm_exec" ? ["package_manager_exec"] : []),
        ...(command === "yarn_pnp" ? ["yarn_pnp"] : []),
        "package_declares_run402",
        ...(workspacePackageInfo && workspacePackageInfo !== nearestPackageInfo ? ["workspace_root"] : []),
      ],
    };
  }

  if (globalRun402Path) {
    return {
      kind: "global_npm",
      confidence: "high",
      package_manager: "npm",
      cwd: resolvedCwd,
      package_root: packageInfo?.dir ?? nearestPackageInfo?.dir ?? null,
      reasons: ["global_node_modules"],
    };
  }

  if (containsPathSegment(executable, ".pnpm") && projectRoot && executableUnderProject) {
    return {
      kind: "local_project",
      confidence: "medium",
      package_manager: "pnpm",
      cwd: packageInfo?.dir ?? resolvedCwd,
      package_root: packageInfo?.dir ?? nearestPackageInfo?.dir ?? null,
      reasons: ["pnpm_store_layout"],
    };
  }

  if (packageManagerShim) {
    return {
      kind: "package_manager_shim",
      confidence: "low",
      package_manager: packageManager.name,
      cwd: packageInfo?.dir ?? resolvedCwd,
      package_root: packageInfo?.dir ?? nearestPackageInfo?.dir ?? null,
      reasons: ["shim_path"],
    };
  }

  return {
    kind: "custom_path",
    confidence: executable ? "low" : "medium",
    package_manager: packageManager.name,
    cwd: packageInfo?.dir ?? resolvedCwd,
    package_root: packageInfo?.dir ?? nearestPackageInfo?.dir ?? null,
    reasons: executable ? ["unclassified_executable"] : ["missing_executable_path"],
  };
}

export function detectPackageManager({ cwd = process.cwd(), env = process.env, packageInfo = findNearestPackageInfo(cwd) } = {}) {
  const fromPackageManager = packageInfo?.pkg?.packageManager;
  if (typeof fromPackageManager === "string") {
    const name = fromPackageManager.split("@")[0];
    if (KNOWN_PACKAGE_MANAGERS.has(name)) return { name, source: "packageManager", confidence: "high" };
  }

  const userAgent = env.npm_config_user_agent;
  if (typeof userAgent === "string") {
    const name = userAgent.split(/[ /]/)[0];
    if (KNOWN_PACKAGE_MANAGERS.has(name)) return { name, source: "npm_config_user_agent", confidence: "medium" };
  }

  const lockfileManager = detectLockfileManager(packageInfo?.dir ?? cwd);
  if (lockfileManager) return { name: lockfileManager, source: "lockfile", confidence: "medium" };

  return { name: "npm", source: "default", confidence: "low" };
}

export function upgradeNextActions({ install, cwd = process.cwd(), command = ["run402"] } = {}) {
  const resolvedCwd = install?.cwd ?? safeResolve(cwd);
  const context = install?.kind ?? "custom_path";
  const pm = install?.package_manager ?? "npm";
  if (context === "local_project") {
    const argv = localUpgradeArgv(pm);
    return [upgradeAction({
      argv,
      cwd: resolvedCwd,
      install,
      mutates_project: true,
      mutates_global_install: false,
    })];
  }
  if (context === "global_npm") {
    return [upgradeAction({
      argv: ["npm", "install", "-g", "run402@latest"],
      cwd: resolvedCwd,
      install,
      mutates_project: false,
      mutates_global_install: true,
    })];
  }
  if (context === "ephemeral_exec") {
    const rerun = command?.[0] === "run402" ? command.slice(1) : command ?? [];
    const launcher = pm === "bun" ? ["bunx", "run402@latest"] : ["npx", "-y", "run402@latest"];
    return [upgradeAction({
      argv: [...launcher, ...rerun],
      cwd: resolvedCwd,
      install,
      mutates_project: false,
      mutates_global_install: false,
    })];
  }
  return [upgradeAction({
    argv: ["run402", "doctor", "--refresh"],
    cwd: resolvedCwd,
    install,
    mutates_project: false,
    mutates_global_install: false,
    why: "The current run402 executable path is custom or ambiguous; doctor can show more context.",
  })];
}

function upgradeAction({ argv, cwd, install, mutates_project, mutates_global_install, why }) {
  return {
    type: "upgrade_client",
    package: "run402",
    target: "latest",
    command: shellCommand(argv),
    argv,
    cwd,
    install_context: install?.kind ?? "custom_path",
    package_manager: install?.package_manager ?? null,
    confidence: install?.confidence ?? "low",
    mutates_project,
    mutates_global_install,
    ...(why ? { why } : {}),
  };
}

function localUpgradeArgv(pm) {
  if (pm === "pnpm") return ["pnpm", "add", "-D", "run402@latest"];
  if (pm === "yarn") return ["yarn", "add", "-D", "run402@latest"];
  if (pm === "bun") return ["bun", "add", "-d", "run402@latest"];
  return ["npm", "install", "-D", "run402@latest"];
}

function shellCommand(argv) {
  return argv.map((part) => /^[A-Za-z0-9_./:=@+-]+$/.test(part) ? part : JSON.stringify(part)).join(" ");
}

function parseSemver(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? "",
  };
}

function comparePrerelease(a, b) {
  const left = String(a).split(".");
  const right = String(b).split(".");
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l) ? Number(l) : null;
    const rn = /^\d+$/.test(r) ? Number(r) : null;
    if (ln !== null && rn !== null) {
      if (ln < rn) return -1;
      if (ln > rn) return 1;
    } else if (ln !== null) {
      return -1;
    } else if (rn !== null) {
      return 1;
    } else {
      const cmp = l.localeCompare(r);
      if (cmp !== 0) return cmp < 0 ? -1 : 1;
    }
  }
  return 0;
}

function detectExecCommand({ env, argv, executable }) {
  const joinedArgv = Array.isArray(argv) ? argv.join(" ") : "";
  if (containsPathSegment(executable, "_npx") || /\bnpx\b/.test(joinedArgv) || env.npm_config_npx === "true") {
    return "npx";
  }
  if (env.npm_command === "exec" || env.npm_lifecycle_event === "npx") return "npm_exec";
  if (containsPathSegment(executable, "bunx") || /\bbunx\b/.test(joinedArgv) || env.BUN_INSTALL) {
    if (env.npm_command === "exec" || containsPathSegment(executable, "bunx")) return "bunx";
  }
  if (typeof env.NODE_OPTIONS === "string" && env.NODE_OPTIONS.includes(".pnp.")) return "yarn_pnp";
  return "direct";
}

function findNearestPackageInfo(startDir) {
  return findPackageAncestry(startDir)[0] ?? null;
}

function findPackageAncestry(startDir) {
  const packages = [];
  let current = safeResolve(startDir);
  for (;;) {
    const pkgPath = join(current, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      packages.push({ dir: current, pkg });
    } catch {
      // keep walking
    }
    const parent = dirname(current);
    if (parent === current) return packages;
    current = parent;
  }
}

function detectLockfileManager(dir) {
  const files = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
  ];
  for (const [file, pm] of files) {
    try {
      readFileSync(join(dir, file));
      return pm;
    } catch {
      // ignore
    }
  }
  return null;
}

function declaresRun402(pkg) {
  if (!pkg || typeof pkg !== "object") return false;
  return Boolean(
    pkg.dependencies?.run402 ||
    pkg.devDependencies?.run402 ||
    pkg.optionalDependencies?.run402 ||
    pkg.peerDependencies?.run402,
  );
}

function hasWorkspaces(pkg) {
  if (!pkg || typeof pkg !== "object") return false;
  return Array.isArray(pkg.workspaces) || Array.isArray(pkg.workspaces?.packages);
}

function looksLikeGlobalRun402Path(executable, env, platform) {
  if (!executable) return false;
  const prefix = env.npm_config_prefix ? normalizePath(env.npm_config_prefix) : "";
  if (prefix && isPathInside(executable, prefix) && containsPathSegment(executable, "run402")) return true;
  if (platform === "win32" && /[\\/]npm[\\/]node_modules[\\/]run402[\\/]/i.test(executable)) return true;
  return /[\\/]lib[\\/]node_modules[\\/]run402[\\/]/.test(executable);
}

function isPackageManagerShim(executable) {
  return /[\\/]node_modules[\\/]\.bin[\\/]run402(?:\.cmd|\.ps1)?$/i.test(executable) ||
    /[\\/]bin[\\/]run402(?:\.cmd|\.ps1)?$/i.test(executable) ||
    executable.endsWith(`${sep}run402.cmd`) ||
    executable.endsWith(`${sep}run402.ps1`);
}

function containsPathSegment(path, segment) {
  if (!path) return false;
  const normalized = normalizePath(path).toLowerCase();
  return normalized.split(/[\\/]+/).includes(segment.toLowerCase());
}

function normalizePath(value) {
  if (!value || typeof value !== "string") return "";
  return normalize(value.replace(/\\/g, sep));
}

function safeResolve(value) {
  try {
    return resolve(value);
  } catch {
    return process.cwd();
  }
}

function isPathInside(child, parent) {
  const normalizedChild = normalizePath(child);
  const normalizedParent = normalizePath(parent);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedParent.endsWith(sep) ? normalizedParent : normalizedParent + sep);
}

function envFlag(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return null;
}

function isCi(env) {
  return env.CI === "true" || env.GITHUB_ACTIONS === "true" || env.BUILDKITE === "true" || env.GITLAB_CI === "true";
}

function errorCode(err) {
  if (err?.name === "AbortError") return "TIMEOUT";
  if (err instanceof Error && /valid latest version/.test(err.message)) return "INVALID_LATEST";
  return "NETWORK_ERROR";
}

export const __filename = fileURLToPath(import.meta.url);
