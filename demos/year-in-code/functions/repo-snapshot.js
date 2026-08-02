import { createHash } from 'node:crypto';

const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const CACHE_SCHEMA_VERSION = 4;
const PAGE_SIZE = 100;
const FETCH_CONCURRENCY = 6;
const MAX_COMMITS = 3_000;
const MAX_BRANCHES = 300;
const MAX_ISSUES = 400;
const FETCH_BUDGET_MS = 8_000;
const MAX_RESPONSE_BYTES = 5_700_000;
const EXCLUDED_IDENTITIES = new Set(['frankfiegel']);

class PublicError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function compactIdentity(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function isExcludedContributor(commit) {
  const candidates = [
    commit?.commit?.author?.name,
    commit?.commit?.author?.email,
    commit?.author?.login,
    commit?.commit?.committer?.name,
    commit?.committer?.login,
  ];
  return candidates.some((candidate) => {
    const normalized = compactIdentity(candidate);
    return EXCLUDED_IDENTITIES.has(normalized) || normalized.startsWith('frankfiegel');
  });
}

function hashId(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function gravatarAvatarUrl(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  const hash = createHash('sha256').update(normalized).digest('hex');
  return `https://gravatar.com/avatar/${hash}?s=96&d=identicon&r=g`;
}

function githubAvatarUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['avatars.githubusercontent.com', 'github.com'].includes(url.hostname)) return null;
    url.searchParams.set('s', '96');
    return url.toString();
  } catch {
    return null;
  }
}

function safeDate(value, fallback) {
  const date = new Date(value || fallback);
  return Number.isNaN(date.valueOf()) ? fallback : date.toISOString();
}

function dateWithin(value, start, end) {
  if (!value) return false;
  const timestamp = new Date(value).valueOf();
  return timestamp >= start.valueOf() && timestamp <= end.valueOf();
}

function hashNumber(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function completedMonthWindow(now = new Date()) {
  const resolved = new Date(now);
  if (Number.isNaN(resolved.valueOf())) throw new TypeError('now must be a valid date');
  const endExclusive = new Date(Date.UTC(resolved.getUTCFullYear(), resolved.getUTCMonth(), 1));
  const start = new Date(Date.UTC(endExclusive.getUTCFullYear() - 1, endExclusive.getUTCMonth(), 1));
  const end = new Date(endExclusive.valueOf() - 1);
  const periodKey = `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, '0')}`;
  return {
    start,
    end,
    endExclusive,
    periodKey,
    cacheUntil: new Date(Date.UTC(resolved.getUTCFullYear(), resolved.getUTCMonth() + 1, 1)),
  };
}

export function parseRepositoryInput(input) {
  const raw = String(input || '').trim();
  if (!raw || raw.length > 240) {
    throw new PublicError(400, 'REPOSITORY_REQUIRED', 'Enter a public GitHub repository such as owner/repo.');
  }

  let path = raw;
  if (/^https?:\/\//i.test(raw)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new PublicError(400, 'REPOSITORY_INVALID', 'That is not a valid GitHub repository URL.');
    }
    if (parsed.hostname.toLowerCase() !== 'github.com') {
      throw new PublicError(400, 'REPOSITORY_INVALID', 'Only public github.com repositories are supported.');
    }
    path = parsed.pathname;
  }

  const parts = path.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2) {
    throw new PublicError(400, 'REPOSITORY_INVALID', 'Use owner/repo or a full github.com/owner/repo URL.');
  }
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
    throw new PublicError(400, 'REPOSITORY_INVALID', 'The GitHub owner or repository name is invalid.');
  }
  return { owner, repo, key: `${owner.toLowerCase()}/${repo.toLowerCase()}` };
}

function githubHeaders() {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'run402-git-tower',
    'x-github-api-version': GITHUB_API_VERSION,
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function githubRequest(path, signal) {
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: githubHeaders(),
    signal,
  });
  if (response.ok) return response;

  let detail = '';
  try {
    const body = await response.json();
    detail = typeof body?.message === 'string' ? body.message : '';
  } catch {
    // Public errors below intentionally avoid forwarding an arbitrary upstream body.
  }
  if (response.status === 404) {
    throw new PublicError(404, 'REPOSITORY_NOT_FOUND', 'That public GitHub repository could not be found.');
  }
  if (response.status === 403 || response.status === 429) {
    throw new PublicError(429, 'GITHUB_RATE_LIMITED', 'GitHub is busy right now. Try this repository again shortly.');
  }
  throw new PublicError(502, 'GITHUB_UNAVAILABLE', detail || 'GitHub did not return repository data.');
}

function lastPageFromLink(link) {
  if (!link) return 1;
  const last = link.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  if (last) return Number(last[1]);
  return /rel="next"/.test(link) ? 2 : 1;
}

async function mapInBatches(values, concurrency, mapper) {
  const output = [];
  for (let index = 0; index < values.length; index += concurrency) {
    const batch = values.slice(index, index + concurrency);
    output.push(...await Promise.all(batch.map(mapper)));
  }
  return output;
}

async function fetchCollection(path, params, limit, signal) {
  const maxPages = Math.ceil(limit / PAGE_SIZE);
  const makePath = (page) => {
    const query = new URLSearchParams({ ...params, per_page: String(PAGE_SIZE), page: String(page) });
    return `${path}?${query}`;
  };
  const firstResponse = await githubRequest(makePath(1), signal);
  const firstPage = await firstResponse.json();
  const reportedLastPage = lastPageFromLink(firstResponse.headers.get('link'));
  const pageCount = Math.min(reportedLastPage, maxPages);
  const remainingPages = Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) => index + 2);
  const rest = await mapInBatches(remainingPages, FETCH_CONCURRENCY, async (page) => {
    const response = await githubRequest(makePath(page), signal);
    return response.json();
  });
  return {
    items: [firstPage, ...rest].flat().slice(0, limit),
    truncated: reportedLastPage > maxPages,
  };
}

function dateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

export function quarterlyIssueWindows(window) {
  return Array.from({ length: 4 }, (_, index) => {
    const start = new Date(Date.UTC(
      window.start.getUTCFullYear(),
      window.start.getUTCMonth() + index * 3,
      1,
    ));
    const endExclusive = index === 3
      ? window.endExclusive
      : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 3, 1));
    return {
      start: dateKey(start),
      end: dateKey(new Date(endExclusive.valueOf() - 1)),
    };
  });
}

async function fetchIssueSearchPage(repoKey, range, order, perPage, signal) {
  const query = new URLSearchParams({
    q: `repo:${repoKey} is:issue updated:${range.start}..${range.end}`,
    sort: 'updated',
    order,
    per_page: String(perPage),
    page: '1',
  });
  const response = await githubRequest(`/search/issues?${query}`, signal);
  const body = await response.json();
  return {
    items: Array.isArray(body.items) ? body.items : [],
    totalCount: Math.max(0, Number(body.total_count) || 0),
    incomplete: body.incomplete_results === true,
  };
}

export function mergeIssueWindowPages(first, last, limit) {
  const unique = new Map();
  for (const issue of [...first.items, ...(last?.items || [])]) {
    const key = issue.id || issue.node_id || issue.number;
    if (key == null || unique.has(key)) continue;
    unique.set(key, issue);
  }
  return {
    items: [...unique.values()]
      .sort((left, right) => new Date(left.updated_at) - new Date(right.updated_at))
      .slice(0, limit),
    truncated: first.incomplete || Boolean(last?.incomplete) || first.totalCount > limit,
  };
}

async function fetchIssuesAcrossWindow(repoKey, window, limit, signal) {
  const ranges = quarterlyIssueWindows(window);
  const perRange = Math.min(PAGE_SIZE, Math.ceil(limit / ranges.length));
  const pages = await mapInBatches(ranges, FETCH_CONCURRENCY, (range) => (
    fetchIssueSearchPage(repoKey, range, 'desc', perRange, signal)
  ));
  const merged = ranges.map((_, index) => (
    mergeIssueWindowPages(pages[index], null, perRange)
  ));
  return {
    items: merged.flatMap((page) => page.items).slice(0, limit),
    truncated: merged.some((page) => page.truncated),
  };
}

function identityForCommit(commit, role = 'author') {
  const gitIdentity = commit.commit?.[role] || {};
  const account = commit[role] || {};
  const basis = account.login ? `github:${account.login.toLowerCase()}` : `git:${compactIdentity(gitIdentity.name)}`;
  const githubAvatar = githubAvatarUrl(account.avatar_url);
  const gravatarAvatar = gravatarAvatarUrl(gitIdentity.email);
  return {
    id: hashId(basis || `unknown:${role}`),
    name: gitIdentity.name || account.login || 'Unknown contributor',
    avatarUrl: githubAvatar || gravatarAvatar,
    avatarSource: githubAvatar ? 'github' : gravatarAvatar ? 'gravatar' : null,
  };
}

function makeMonths(window) {
  const formatter = new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const months = new Map();
  for (let index = 0; index < 12; index += 1) {
    const date = new Date(Date.UTC(window.start.getUTCFullYear(), window.start.getUTCMonth() + index, 1));
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    months.set(key, {
      key,
      label: formatter.format(date),
      commits: 0,
      insertions: 0,
      deletions: 0,
      authorIds: new Set(),
    });
  }
  return months;
}

export function assembleSnapshot(repoInfo, collections, window, generatedAt = new Date()) {
  let excludedCommits = 0;
  const commits = collections.commits.items
    .filter((commit) => {
      const excluded = isExcludedContributor(commit);
      if (excluded) excludedCommits += 1;
      return !excluded;
    })
    .map((commit) => {
      const author = identityForCommit(commit, 'author');
      const committer = identityForCommit(commit, 'committer');
      const date = safeDate(commit.commit?.author?.date, window.start.toISOString());
      return {
        hash: commit.sha,
        shortHash: commit.sha.slice(0, 8),
        parents: (commit.parents || []).map((parent) => parent.sha),
        date,
        author: author.name,
        authorId: author.id,
        authorAvatarUrl: author.avatarUrl,
        authorAvatarSource: author.avatarSource,
        committer: committer.name,
        committerId: committer.id,
        subject: String(commit.commit?.message || 'Untitled commit').split('\n')[0].slice(0, 240),
        refs: [],
        files: 0,
        insertions: 0,
        deletions: 0,
      };
    })
    .filter((commit) => dateWithin(commit.date, window.start, window.end))
    .sort((left, right) => new Date(left.date) - new Date(right.date));

  const commitIndex = new Map(commits.map((commit, index) => [commit.hash, index]));
  const branches = collections.branches.items.map((branch) => {
    const exactIndex = commitIndex.get(branch.commit?.sha);
    const fallbackIndex = commits.length ? hashNumber(branch.commit?.sha || branch.name) % commits.length : 0;
    const resolvedIndex = exactIndex ?? fallbackIndex;
    const anchor = commits[resolvedIndex];
    const name = `origin/${branch.name}`;
    if (exactIndex != null) commits[exactIndex].refs.push(name);
    return {
      name,
      scope: 'remote',
      hash: branch.commit?.sha || '',
      shortHash: String(branch.commit?.sha || '').slice(0, 8),
      date: anchor?.date || window.end.toISOString(),
      author: anchor?.author || 'GitHub branch',
      subject: exactIndex == null ? 'Branch tip outside sampled default-branch history' : anchor.subject,
      commitIndex: commits.length ? resolvedIndex : null,
      tipResolved: exactIndex != null,
    };
  }).sort((left, right) => new Date(left.date) - new Date(right.date));

  const issues = collections.issues.items
    .filter((issue) => !issue.pull_request)
    .filter((issue) => {
      const created = dateWithin(issue.created_at, window.start, window.end);
      const updated = dateWithin(issue.updated_at, window.start, window.end);
      const closed = dateWithin(issue.closed_at, window.start, window.end);
      return new Date(issue.created_at) <= window.end && (created || updated || closed);
    })
    .map((issue) => {
      const closedInWindow = issue.closed_at && new Date(issue.closed_at) <= window.end;
      return {
        number: issue.number,
        title: issue.title,
        state: closedInWindow ? 'closed' : 'open',
        stateReason: closedInWindow ? issue.state_reason : null,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        closedAt: closedInWindow ? issue.closed_at : null,
        author: issue.user?.login || 'unknown',
        assignees: (issue.assignees || []).map((assignee) => assignee.login),
        labels: (issue.labels || []).map((label) => typeof label === 'string' ? label : label.name).filter(Boolean),
        comments: issue.comments || 0,
        url: issue.html_url,
      };
    })
    .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt));

  const contributorMap = new Map();
  const months = makeMonths(window);
  for (const commit of commits) {
    const contributor = contributorMap.get(commit.authorId) || {
      id: commit.authorId,
      name: commit.author,
      avatarUrl: commit.authorAvatarUrl,
      avatarSource: commit.authorAvatarSource,
      commits: 0,
      insertions: 0,
      deletions: 0,
      firstCommit: commit.date,
      lastCommit: commit.date,
    };
    contributor.commits += 1;
    contributor.lastCommit = commit.date;
    contributorMap.set(commit.authorId, contributor);

    const date = new Date(commit.date);
    const monthKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const month = months.get(monthKey);
    if (month) {
      month.commits += 1;
      month.authorIds.add(commit.authorId);
    }
  }

  const contributors = [...contributorMap.values()].sort((left, right) => right.commits - left.commits);
  const monthList = [...months.values()].map(({ authorIds, ...month }) => ({
    ...month,
    authors: authorIds.size,
  }));
  const generated = new Date(generatedAt).toISOString();

  return {
    meta: {
      repo: repoInfo.full_name,
      repoUrl: repoInfo.html_url,
      defaultBranch: repoInfo.default_branch,
      start: window.start.toISOString(),
      end: window.end.toISOString(),
      period: window.periodKey,
      cacheUntil: window.cacheUntil.toISOString(),
      generatedAt: generated,
      commits: commits.length,
      branches: branches.length,
      excludedDisconnectedRefs: 0,
      issues: issues.length,
      openIssues: issues.filter((issue) => issue.state === 'open').length,
      closedIssues: issues.filter((issue) => issue.state === 'closed').length,
      contributors: contributors.length,
      insertions: 0,
      deletions: 0,
      statsAvailable: false,
      historyScope: 'default_branch_plus_branch_tips',
      excludedContributors: ['Frank Fiegel'],
      excludedCommits,
      truncated: {
        commits: collections.commits.truncated,
        branches: collections.branches.truncated,
        issues: collections.issues.truncated,
      },
    },
    months: monthList,
    contributors,
    branches,
    issues,
    commits,
  };
}

export async function fetchRepositorySnapshot(repository, now = new Date(), signal) {
  const window = completedMonthWindow(now);
  const repoPath = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
  const repoResponse = await githubRequest(repoPath, signal);
  const repoInfo = await repoResponse.json();
  if (repoInfo.private) {
    throw new PublicError(404, 'REPOSITORY_NOT_FOUND', 'That public GitHub repository could not be found.');
  }

  const [commits, branches, issues] = await Promise.all([
    fetchCollection(`${repoPath}/commits`, {
      sha: repoInfo.default_branch,
      since: window.start.toISOString(),
      until: window.end.toISOString(),
    }, MAX_COMMITS, signal),
    fetchCollection(`${repoPath}/branches`, {}, MAX_BRANCHES, signal),
    fetchIssuesAcrossWindow(repoInfo.full_name, window, MAX_ISSUES, signal),
  ]);

  const snapshot = assembleSnapshot(repoInfo, { commits, branches, issues }, window);
  if (!snapshot.commits.length) {
    throw new PublicError(422, 'NO_COMMITS_IN_PERIOD', `No default-branch commits were found from ${window.start.toISOString().slice(0, 10)} through ${window.end.toISOString().slice(0, 10)}.`);
  }
  return snapshot;
}

function responseHeaders(cacheStatus) {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, no-store',
    'x-git-tower-cache': cacheStatus,
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function assembleSkyline(rows, now = new Date()) {
  const window = completedMonthWindow(now);
  const unique = new Map();
  for (const row of rows || []) {
    const meta = row.meta;
    if (!meta?.repo || !Number.isFinite(Number(meta.commits))) continue;
    const repository = {
      repo: meta.repo,
      repoUrl: meta.repoUrl,
      end: meta.end,
      commits: Number(meta.commits) || 0,
      branches: Number(meta.branches) || 0,
      issues: Number(meta.issues) || 0,
      contributors: Number(meta.contributors) || 0,
      monthCommits: Array.isArray(row.months) ? row.months.map((month) => Number(month?.commits) || 0).slice(0, 12) : [],
      generatedAt: safeDate(row.generated_at, meta.generatedAt || now.toISOString()),
    };
    const key = meta.repo.toLowerCase();
    const existing = unique.get(key);
    if (!existing || new Date(repository.generatedAt) > new Date(existing.generatedAt)) unique.set(key, repository);
  }
  const repositories = [...unique.values()].sort((left, right) => (
    right.commits - left.commits || left.repo.localeCompare(right.repo)
  ));
  return {
    period: window.periodKey,
    cacheUntil: window.cacheUntil.toISOString(),
    repositories,
  };
}

export default async function handler(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse({ error: 'METHOD_NOT_ALLOWED', message: 'Use GET.' }, 405, { allow: 'GET, HEAD' });
  }

  const now = new Date();
  const window = completedMonthWindow(now);
  try {
    const requestUrl = new URL(request.url);
    const { adminDb } = await import('@run402/functions');
    const database = adminDb();
    if (requestUrl.searchParams.get('view') === 'skyline') {
      const city = await database.sql(
        `SELECT repo_key, meta, months, generated_at
           FROM (
             SELECT DISTINCT ON (repo_key)
                    repo_key,
                    snapshot -> 'meta' AS meta,
                    snapshot -> 'months' AS months,
                    generated_at
               FROM git_tower_snapshots
              ORDER BY repo_key, period_key DESC, schema_version DESC, generated_at DESC
           ) latest
          ORDER BY COALESCE((meta ->> 'commits')::integer, 0) DESC, repo_key ASC`,
      );
      const body = JSON.stringify(assembleSkyline(city.rows, now));
      const headers = responseHeaders('skyline');
      return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
    }

    const repository = parseRepositoryInput(requestUrl.searchParams.get('repo'));
    const cached = await database.sql(
      `SELECT snapshot
         FROM git_tower_snapshots
        WHERE repo_key = $1 AND period_key = $2 AND schema_version = $3
        LIMIT 1`,
      [repository.key, window.periodKey, CACHE_SCHEMA_VERSION],
    );
    if (cached.rows?.[0]?.snapshot) {
      const snapshot = cached.rows[0].snapshot;
      const body = JSON.stringify(snapshot);
      const headers = responseHeaders('hit');
      return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_BUDGET_MS);
    let snapshot;
    try {
      snapshot = await fetchRepositorySnapshot(repository, now, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
    const body = JSON.stringify(snapshot);
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
      throw new PublicError(413, 'SNAPSHOT_TOO_LARGE', 'This repository is too large for the live demo.');
    }

    await database.sql(
      `INSERT INTO git_tower_snapshots (repo_key, period_key, schema_version, snapshot, generated_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       ON CONFLICT (repo_key, period_key, schema_version)
       DO UPDATE SET snapshot = EXCLUDED.snapshot, generated_at = EXCLUDED.generated_at`,
      [repository.key, window.periodKey, CACHE_SCHEMA_VERSION, body],
    );
    const headers = responseHeaders('miss');
    return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
  } catch (error) {
    if (error?.name === 'AbortError') {
      return jsonResponse({ error: 'SNAPSHOT_TIMEOUT', message: 'This repository took too long to read. Try a smaller one.' }, 504, { 'cache-control': 'no-store' });
    }
    const status = error instanceof PublicError ? error.status : 500;
    const code = error instanceof PublicError ? error.code : 'SNAPSHOT_FAILED';
    const message = error instanceof PublicError ? error.message : 'The repository snapshot could not be built.';
    console.error('git tower snapshot failed', { code, message: error?.message });
    return jsonResponse({ error: code, message }, status, { 'cache-control': 'no-store' });
  }
}
