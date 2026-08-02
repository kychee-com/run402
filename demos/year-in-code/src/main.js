import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  createCrewCommitCounts,
  crewCommitShare,
  moveCrewCommitCounts,
  rankCrewContributors,
  stepCrewRankMotion,
} from './crew-leaderboard.js';
import { getRepositoryActionState } from './repository-input.js';
import {
  createCityLayout,
  createNeighborBackdrop,
  createRepositoryDirectory,
} from './skyline-city.js';
import {
  binaryCountByDate,
  commitCountAtPlaybackProgress,
  playbackActivityStart,
  playbackDateAtProgress,
  playbackProgressAtElapsed,
  playbackProgressForDate,
  playbackProgressForFrame,
} from './timeline.js';
import { createSynthScore } from './synth-score.js';
import './styles.css';

const DEFAULT_REPOSITORY = 'kychee-com/run402';
const SNAPSHOT_TRANSFER_KEY = 'git-tower:repository-transfer';
const SNAPSHOT_TRANSFER_TTL_MS = 2 * 60 * 1000;
const BUILD_PROGRESS_START = 0.08;
const BUILD_PROGRESS_HANDOFF = 0.94;
const BUILD_DURATION_SECONDS = 28;
const appRoot = document.querySelector('#app');
const pageParameters = new URL(window.location.href).searchParams;
const requestedRepository = pageParameters.get('repo') || DEFAULT_REPOSITORY;
const isVideoCapture = pageParameters.get('capture') === 'video';
const isLeaderboardCapture = isVideoCapture && pageParameters.get('layer') === 'leaderboard';
const isFrameCapture = isVideoCapture && pageParameters.get('frames') === 'manual';

document.documentElement.classList.toggle('is-video-capture', isVideoCapture);
document.documentElement.classList.toggle('is-leaderboard-capture', isLeaderboardCapture);
document.documentElement.classList.toggle('is-frame-capture', isFrameCapture);

function takeRepositoryTransfer(repo) {
  try {
    const raw = window.sessionStorage.getItem(SNAPSHOT_TRANSFER_KEY);
    window.sessionStorage.removeItem(SNAPSHOT_TRANSFER_KEY);
    if (!raw) return null;
    const transfer = JSON.parse(raw);
    const snapshotRepo = transfer.snapshot?.meta?.repo;
    if (!snapshotRepo || snapshotRepo.toLowerCase() !== repo.toLowerCase()) return null;
    if (!Number.isFinite(transfer.storedAt) || Date.now() - transfer.storedAt > SNAPSHOT_TRANSFER_TTL_MS) return null;
    if (!Array.isArray(transfer.snapshot.commits) || !Array.isArray(transfer.snapshot.months)) return null;
    return transfer;
  } catch {
    return null;
  }
}

function saveRepositoryTransfer(repo, snapshot) {
  try {
    window.sessionStorage.setItem(SNAPSHOT_TRANSFER_KEY, JSON.stringify({ repo, snapshot, storedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

async function fetchRepositorySnapshot(repo, onProgress = () => {}) {
  onProgress(0.14, 'Opening the repository');
  const response = await fetch(`${import.meta.env.BASE_URL}api/repo-snapshot?repo=${encodeURIComponent(repo)}`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    credentials: 'omit',
  });
  onProgress(0.42, 'Repository connected');
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || `Repository snapshot failed to load (${response.status}).`);
  onProgress(0.76, 'Mapping commits, branches, and issues');
  body.meta.cacheStatus = response.headers.get('x-git-tower-cache') || 'browser';
  onProgress(0.86, 'Snapshot ready');
  return body;
}

async function fetchSkyline() {
  const response = await fetch(`${import.meta.env.BASE_URL}api/repo-snapshot?view=skyline`, {
    headers: { accept: 'application/json' },
    credentials: 'omit',
  });
  if (!response.ok) throw new Error(`The skyline could not be loaded (${response.status}).`);
  const body = await response.json();
  if (!Array.isArray(body.repositories)) throw new Error('The skyline response was incomplete.');
  return body;
}

function repositoryTransitionMarkup(
  repo,
  { active = false, progress = BUILD_PROGRESS_START, stage = 'Preparing the build' } = {},
) {
  const percentage = Math.round(progress * 100);
  return `
    <div
      class="repository-transition${active ? ' is-active' : ''}"
      id="repository-transition"
      style="--repository-progress:${progress}"
      aria-hidden="${String(!active)}"
    >
      <div class="repository-transition-glow" aria-hidden="true"></div>
      <div class="repository-transition-panel">
        <div class="repository-transition-heading">
          <span>Building skyline</span>
          <strong class="repository-transition-percent">${percentage}%</strong>
        </div>
        <p class="repository-transition-repo"><span>github.com/</span><strong>${escapeHtml(repo)}</strong></p>
        <div
          class="repository-transition-track"
          role="progressbar"
          aria-label="Repository build progress"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow="${percentage}"
        >
          <i></i>
        </div>
        <p class="repository-transition-stage" aria-live="polite">${escapeHtml(stage)}</p>
      </div>
    </div>
  `;
}

function updateRepositoryTransition(repo, progress, stage) {
  const overlay = document.querySelector('#repository-transition');
  if (!overlay) return;
  const percentage = Math.round(progress * 100);
  overlay.style.setProperty('--repository-progress', String(progress));
  overlay.querySelector('.repository-transition-repo strong').textContent = repo;
  overlay.querySelector('.repository-transition-percent').textContent = `${percentage}%`;
  overlay.querySelector('.repository-transition-stage').textContent = stage;
  overlay.querySelector('.repository-transition-track').setAttribute('aria-valuenow', String(percentage));
  overlay.classList.remove('is-complete');
  overlay.classList.add('is-active');
  overlay.setAttribute('aria-hidden', 'false');
  document.documentElement.classList.add('is-repository-switching');
}

function dismissRepositoryTransition() {
  const overlay = document.querySelector('#repository-transition');
  if (!overlay) return;
  overlay.classList.remove('is-active');
  overlay.setAttribute('aria-hidden', 'true');
  document.documentElement.classList.remove('is-repository-switching');
}

function completeRepositoryTransition(repo) {
  const overlay = document.querySelector('#repository-transition');
  if (!overlay?.classList.contains('is-active')) return;
  updateRepositoryTransition(repo, 1, 'Tower ready');
  const progressFill = overlay.querySelector('.repository-transition-track i');
  let completed = false;
  const revealTower = () => {
    if (completed) return;
    completed = true;
    overlay.classList.add('is-complete');
    overlay.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('is-repository-switching');
    let retired = false;
    const retireOverlay = () => {
      if (retired) return;
      retired = true;
      overlay.classList.remove('is-active', 'is-complete');
    };
    const retireAfterFade = (event) => {
      if (event.target !== overlay || event.propertyName !== 'opacity') return;
      overlay.removeEventListener('transitionend', retireAfterFade);
      retireOverlay();
    };
    overlay.addEventListener('transitionend', retireAfterFade);
    window.setTimeout(retireOverlay, 300);
  };
  progressFill.addEventListener('transitionend', revealTower, { once: true });
  window.setTimeout(revealTower, 520);
}

function repositoryFormMarkup(value, id, status = '') {
  return `
    <form class="repository-form" id="${id}" novalidate>
      <label for="${id}-input">Public GitHub repository</label>
      <div class="repository-input-row">
        <div class="repository-input-shell">
          <span class="repository-prefix" aria-hidden="true">github.com/</span>
          <textarea
            id="${id}-input"
            name="repo"
            rows="1"
            wrap="off"
            inputmode="url"
            enterkeyhint="go"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            data-lpignore="true"
            data-1p-ignore="true"
            data-bwignore="true"
            data-form-type="other"
            data-repository-field
            aria-label="GitHub repository owner and name"
            aria-describedby="${id}-status"
          >${escapeHtml(value)}</textarea>
        </div>
        <button type="submit"><span>Build</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14M14 7l5 5-5 5"/></svg></button>
      </div>
      <p class="repository-form-status" id="${id}-status" aria-live="polite">${escapeHtml(status)}</p>
    </form>
  `;
}

async function transitionToRepository(repo) {
  updateRepositoryTransition(repo, BUILD_PROGRESS_START, 'Preparing the build');
  const snapshot = await fetchRepositorySnapshot(repo, (progress, stage) => {
    updateRepositoryTransition(repo, progress, stage);
  });
  updateRepositoryTransition(repo, BUILD_PROGRESS_HANDOFF, 'Sculpting the new skyline');
  saveRepositoryTransfer(repo, snapshot);
  const destination = new URL(window.location.href);
  destination.searchParams.set('repo', repo);
  destination.searchParams.delete('release');
  window.location.assign(destination);
}

function wireRepositoryForm(form, { currentRepository = null, watchButton = null, initialLoading = false } = {}) {
  if (!form) return () => {};
  const input = form.querySelector('[data-repository-field]');
  const status = form.querySelector('.repository-form-status');
  const button = form.querySelector('button');
  const readyStatus = status.textContent;
  if (initialLoading) form.classList.add('is-loading');

  const syncActions = () => {
    const state = getRepositoryActionState(input.value, {
      currentRepository,
      loading: form.classList.contains('is-loading'),
    });
    const hasInput = input.value.trim().length > 0;
    const showError = !state.valid && hasInput && !form.classList.contains('is-loading');
    button.disabled = !state.buildEnabled;
    input.setAttribute('aria-invalid', String(showError));
    form.classList.toggle('has-error', showError);
    if (watchButton) {
      watchButton.disabled = !state.watchEnabled;
      watchButton.title = state.watchEnabled
        ? ''
        : state.valid && !state.matchesCurrent
          ? 'Build this repository before entering its tower.'
          : 'Enter a valid repository first.';
    }
    if (form.classList.contains('is-loading')) return state;
    if (!hasInput) status.textContent = 'Enter an owner/repository.';
    else if (!state.valid) status.textContent = state.inputError?.message || 'Use owner/repo, for example kychee-com/run402.';
    else if (state.matchesCurrent) status.textContent = readyStatus;
    else status.textContent = `Ready to build ${state.repo}.`;
    return state;
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const state = syncActions();
    if (!state.buildEnabled) return;
    status.textContent = `Building ${state.repo}…`;
    form.classList.add('is-loading');
    syncActions();
    try {
      await transitionToRepository(state.repo);
    } catch (error) {
      dismissRepositoryTransition();
      form.classList.remove('is-loading');
      syncActions();
      status.textContent = error.message || 'The repository could not be read.';
      form.classList.add('has-error');
    }
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    form.requestSubmit();
  });
  input.addEventListener('input', syncActions);
  syncActions();
  return syncActions;
}

const repositoryTransfer = takeRepositoryTransfer(requestedRepository);
const transferredRepositoryData = repositoryTransfer?.snapshot ?? null;
let loaderRepositoryForm = null;
let syncLoaderRepositoryForm = () => {};
if (!transferredRepositoryData) {
  appRoot.innerHTML = `
    <main class="repository-loader">
      <div class="loader-glow" aria-hidden="true"></div>
      <div class="loader-inner">
        <div class="loader-brand"><span class="loader-mark">K</span><span>Kychee / run<strong>402</strong></span></div>
        <p class="loader-kicker">Monthly repository observatory</p>
        <h1>Reading the<br><span>skyline.</span></h1>
        <p class="loader-copy">Commits, branch tips, contributors, and issues through the last completed calendar month.</p>
        ${repositoryFormMarkup(requestedRepository, 'loader-repository', `Building ${requestedRepository}…`)}
        <div class="loader-progress" aria-hidden="true"><i></i></div>
      </div>
    </main>
    ${repositoryTransitionMarkup(requestedRepository)}
  `;
  loaderRepositoryForm = document.querySelector('#loader-repository');
  syncLoaderRepositoryForm = wireRepositoryForm(loaderRepositoryForm, { initialLoading: true });
}

let repoData = transferredRepositoryData;
try {
  if (!repoData) repoData = await fetchRepositorySnapshot(requestedRepository);
} catch (error) {
  const loader = document.querySelector('.repository-loader');
  loader.classList.add('has-load-error');
  loader.querySelector('.loader-kicker').textContent = 'Repository unavailable';
  loader.querySelector('h1').innerHTML = 'The skyline<br><span>stayed dark.</span>';
  loader.querySelector('.loader-copy').textContent = error.message || 'The repository could not be read.';
  loaderRepositoryForm.classList.remove('is-loading');
  loader.querySelector('.repository-form-status').textContent = 'Try this repository again or enter another public repository.';
  syncLoaderRepositoryForm();
  throw error;
}

const { commits, branches, issues, contributors, months, meta } = repoData;
const skylineData = await fetchSkyline().catch(() => ({ repositories: [] }));
const repositoryDirectory = createRepositoryDirectory(skylineData.repositories, meta);
const cityEntryLimit = window.matchMedia('(max-width: 700px), (pointer: coarse) and (max-width: 1100px)').matches ? 12 : 24;
const cityEntries = createCityLayout(skylineData.repositories, meta, cityEntryLimit);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const compactViewport = window.matchMedia('(max-width: 700px)').matches;
const coarseMobilePointer = window.matchMedia('(pointer: coarse)').matches && Math.min(window.innerWidth, window.innerHeight) < 700;
const mobileRenderer = compactViewport || coarseMobilePointer;
const hoverCapable = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const bloomEnabled = !mobileRenderer;
const number = new Intl.NumberFormat('en-US');
const dateLong = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const dateShort = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const repositoryUrl = meta.repoUrl || `https://github.com/${meta.repo}`;
const repositoryShareUrl = new URL(window.location.pathname, window.location.origin);
repositoryShareUrl.searchParams.set('repo', meta.repo);
const repositoryName = meta.repo.split('/').at(-1);
const periodEndLabel = dateLong.format(new Date(meta.end));
document.title = `${repositoryName} — One Year in Code`;
const canonicalUrl = new URL(window.location.href);
canonicalUrl.searchParams.set('repo', meta.repo);
window.history.replaceState(null, '', canonicalUrl);
const contributorPalette = [
  '#00ff9f', '#ff6b57', '#66b8ff', '#d98cff', '#ffd166', '#3ee6d0',
  '#ff8fc7', '#a7f06a', '#ff9f43', '#8f9cff', '#f5f0e1', '#31d7ff',
  '#e8c547', '#c1ff72', '#ff7a90', '#7ce0b8', '#b995ff', '#70d6ff',
];
const contributorKey = (person) => person.authorId ?? person.id;
const contributorRank = new Map(contributors.map((person, index) => [person.id, index]));
const structuralIssues = issues;
const repairedStructuralIssues = structuralIssues.filter((issue) => issue.closedAt);
const openStructuralIssues = structuralIssues.filter((issue) => !issue.closedAt);

const icons = {
  brain: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/></svg>`,
  build: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 20h16M6 20V9l6-5 6 5v11M9 20v-6h6v6M9 10h.01M15 10h.01"/></svg>`,
  branch: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M8 8c5 0 8 0 8-2"/></svg>`,
  issue: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v5M12 16h.01"/></svg>`,
  crew: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="8" r="3"/><circle cx="17" cy="10" r="2"/><path d="M3.5 19c.6-3.4 2.4-5 5.5-5s4.9 1.6 5.5 5M14 15c2.8-.5 5 .7 6 3"/></svg>`,
  city: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M3 20h18M5 20V9l4-3v14M9 20V4l6 3v13M15 20v-9l4-2v11"/><path d="M7 11h.01M7 15h.01M12 9h.01M12 13h.01M12 17h.01M17 13h.01M17 16h.01"/></svg>`,
  play: `<svg class="icon-play" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m8 5 11 7-11 7Z"/></svg>`,
  pause: `<svg class="icon-pause" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>`,
  soundOn: `<svg class="icon-sound-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 15V9M9.5 18V6M14 15.5v-7M18.5 13v-2"/><path class="score-bar score-bar-1" d="M5 15V9"/><path class="score-bar score-bar-2" d="M9.5 18V6"/><path class="score-bar score-bar-3" d="M14 15.5v-7"/><path class="score-bar score-bar-4" d="M18.5 13v-2"/></svg>`,
  soundOff: `<svg class="icon-sound-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 14v-4M9.5 16V8M14 14.5v-5M18.5 13v-2"/><path d="m5 5 14 14"/></svg>`,
  arrow: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14M14 7l5 5-5 5"/></svg>`,
  share: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.5M8.2 13.2l7.6 4.5"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.2 4.2L19 7"/></svg>`,
  change: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h11a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5H7"/><path d="m8 4-4 3 4 3"/></svg>`,
  external: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M14 5h5v5M11 13l8-8M18 13v6H5V6h6"/></svg>`,
};

const directoryLeaderCommitCount = Math.max(1, ...repositoryDirectory.map((entry) => Number(entry.commits) || 0));
const repositoryDirectoryMarkup = `
  <section class="repository-directory" aria-labelledby="repository-directory-title">
    <div class="repository-directory-heading">
      <span><small>Built on Run402</small><strong id="repository-directory-title">Repository directory</strong></span>
      <span>${number.format(repositoryDirectory.length)} cached tower${repositoryDirectory.length === 1 ? '' : 's'} · sorted by commits</span>
    </div>
    <ol class="repository-directory-list">
      ${repositoryDirectory.map((entry, index) => {
        const isCurrent = entry.repo.toLowerCase() === meta.repo.toLowerCase();
        const commitCount = Math.max(0, Number(entry.commits) || 0);
        const share = Math.max(0.035, commitCount / directoryLeaderCommitCount);
        return `
          <li>
            <button
              class="repository-directory-row${isCurrent ? ' is-current' : ''}"
              type="button"
              data-directory-repository="${escapeHtml(entry.repo)}"
              style="--repository-share:${share}"
              ${isCurrent ? 'aria-current="page"' : ''}
            >
              <span class="repository-directory-rank">${String(index + 1).padStart(2, '0')}</span>
              <span class="repository-directory-name">${escapeHtml(entry.repo)}</span>
              <span class="repository-directory-commits"><strong>${number.format(commitCount)}</strong> commits</span>
              <span class="repository-directory-arrow" aria-hidden="true">${icons.arrow}</span>
            </button>
          </li>
        `;
      }).join('')}
    </ol>
    <p class="repository-directory-status" aria-live="polite"></p>
  </section>
`;

appRoot.innerHTML = `
  <main class="experience" aria-label="Run402 repository history visualization">
    <canvas class="scene-canvas" id="scene" aria-label="Interactive three-dimensional tower built from repository commits"></canvas>
    <div class="chrome">
      <header class="hud-top">
        <div class="brand-lockup" aria-label="Kychee and Run402">
          <div class="brand-mark">${icons.brain}<span>Kychee</span></div>
          <span class="brand-divider" aria-hidden="true"></span>
          <div class="run-wordmark">run<span>402</span></div>
        </div>
        <div class="status-cluster">
          <div class="repository-identity">
            <div class="status-chip repository-status-chip">
              <span class="repository-status-dot"></span>
              <span><strong>${escapeHtml(meta.repo)}</strong><small>through ${escapeHtml(periodEndLabel)}</small></span>
            </div>
            <div class="repository-quick-actions" aria-label="Repository actions">
              <button
                class="repository-quick-action"
                type="button"
                data-share-url="${escapeHtml(repositoryShareUrl.toString())}"
                data-share-label="Share"
                data-share-aria-label="Share ${escapeHtml(meta.repo)} tower link"
                aria-label="Share ${escapeHtml(meta.repo)} tower link"
              >
                <span class="share-button-icons" aria-hidden="true"><span>${icons.share}</span><span>${icons.check}</span></span>
                <span class="share-button-label" aria-live="polite">Share</span>
              </button>
              <button class="repository-quick-action" id="change-repository" type="button">
                <span class="repository-quick-action-icon" aria-hidden="true">${icons.change}</span>
                <span>Change repo</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      <nav class="view-rail" aria-label="Visualization layers">
        <button class="mode-button" type="button" data-mode="build" data-label="Build" aria-label="Show commit construction" aria-pressed="true">${icons.build}</button>
        <button class="mode-button" type="button" data-mode="branches" data-label="Branches" aria-label="Show repository branches" aria-pressed="false">${icons.branch}</button>
        <button class="mode-button" type="button" data-mode="issues" data-label="Repairs" aria-label="Show repository issues" aria-pressed="false">${icons.issue}</button>
        <button class="mode-button" type="button" data-mode="crews" data-label="Crews" aria-label="Show repository contributors" aria-pressed="false">${icons.crew}</button>
        <button class="mode-button city-mode-button" type="button" data-mode="city" data-label="City" aria-label="Explore the Run402 repository skyline" aria-pressed="false">${icons.city}</button>
      </nav>

      <aside class="detail-panel" id="detail-panel" aria-live="polite">
        <button class="close-button" id="close-detail" type="button" aria-label="Close details">×</button>
        <div id="detail-content"></div>
      </aside>

      <div class="orientation-hint" aria-hidden="true">
        <span class="keyboard-key">↔</span><span>drag to orbit</span>
        <span class="keyboard-key">⌁</span><span>scroll to ascend</span>
        <span class="keyboard-key">↵</span><span>click to inspect</span>
      </div>

      <section class="timeline" aria-label="Repository timeline">
        <div class="timeline-top">
          <div class="timeline-actions">
            <button class="play-button" id="play" type="button" aria-label="Play the year" aria-pressed="false">${icons.play}${icons.pause}</button>
            <button class="sound-button" id="sound" type="button" aria-label="Mute synth score" aria-pressed="true" title="Synth score on"><span>${icons.soundOn}</span><span>${icons.soundOff}</span></button>
            <div class="timeline-date"><strong id="timeline-date">${dateLong.format(new Date(meta.end))}</strong><span id="timeline-phase">tower complete / ${number.format(meta.commits)} commits high</span></div>
          </div>
          <div class="timeline-meta">
            <span><strong id="visible-commits">${number.format(meta.commits)}</strong> commits</span>
            <span><strong id="visible-branches">${number.format(meta.branches)}</strong> branches</span>
            <span><strong id="visible-issues">${number.format(meta.issues)}</strong> issues</span>
          </div>
        </div>
        <input class="timeline-scrubber" id="scrubber" type="range" min="0" max="${meta.commits}" value="${meta.commits}" aria-label="Scrub through the year of commits" />
        <div class="month-ticks" style="--month-count:${months.length}">${months.map((month) => `<span>${month.label.replace(' ', ' ’')}</span>`).join('')}</div>
      </section>

      <section class="city-navigator" id="city-navigator" aria-label="Repository skyline navigation" aria-hidden="true">
        <div class="city-navigator-copy">
          <small>Run402 skyline · <span id="city-count">${number.format(cityEntries.length)}</span> landmarks</small>
          <strong id="city-repository">${escapeHtml(cityEntries[0].repo)}</strong>
          <span id="city-period">through ${escapeHtml(dateShort.format(new Date(cityEntries[0].end || meta.end)))}</span>
        </div>
        <div class="city-navigator-metrics" aria-live="polite">
          <span><strong id="city-commits">${number.format(cityEntries[0].commits)}</strong> commits</span>
          <span><strong id="city-branches">${number.format(cityEntries[0].branches)}</strong> branches</span>
          <span><strong id="city-contributors">${number.format(cityEntries[0].contributors)}</strong> crews</span>
        </div>
        <div class="city-navigator-actions">
          <button class="city-step city-step-previous" id="city-previous" type="button" aria-label="Previous repository">${icons.arrow}</button>
          <button class="city-enter" id="city-enter" type="button"><span id="city-enter-label">Return to tower</span>${icons.arrow}</button>
          <button class="city-step" id="city-next" type="button" aria-label="Next repository">${icons.arrow}</button>
        </div>
        <p class="city-travel-hint">Tap a landmark · drag to orbit · arrows / WASD to roam</p>
      </section>
    </div>

    <section class="intro" aria-labelledby="intro-title">
      <div class="intro-inner">
        <div class="intro-brands">${icons.brain}<span>Kychee presents / run<span style="color:var(--mint)">402</span></span></div>
        <h1 class="intro-title" id="intro-title"><span>ONE YEAR</span><span>IN CODE</span></h1>
        <div class="intro-repository"><span>github.com/</span>${escapeHtml(meta.repo)}</div>
        <p class="intro-copy">Twelve completed calendar months, ending ${escapeHtml(periodEndLabel)}. Every module is a commit, every color its contributor, and every branch physically pulls the crystalline façade into a new bloom. Issues rupture the structure; closures return as luminous kintsugi seams.</p>
        <div class="intro-statline">
          <span><strong>${number.format(meta.commits)}</strong> commits</span>
          <span><strong>${number.format(meta.branches)}</strong> branch refs</span>
          <span><strong>${number.format(meta.issues)}</strong> issues</span>
          <span class="intro-contributor-stat">
            <span class="intro-avatar-stack" aria-hidden="true">
              ${contributors.slice(0, 4).map((person) => contributorAvatarMarkup(person, 'intro-avatar')).join('')}
            </span>
            <span><strong>${number.format(meta.contributors)}</strong> contributors</span>
          </span>
        </div>
        ${repositoryFormMarkup(meta.repo, 'intro-repository-form', `Monthly snapshot · ${meta.cacheStatus === 'hit' ? 'cache hit' : 'freshly built'}`)}
        <div class="intro-actions">
          <button class="enter-button" id="enter" type="button"><span>Watch it rise</span><span class="enter-button-icon">${icons.arrow}</span></button>
          <button class="skyline-button" id="explore-city" type="button"><span>${icons.city}</span><span>Explore city</span></button>
          <button
            class="share-button"
            id="share-tower"
            type="button"
            data-share-url="${escapeHtml(repositoryShareUrl.toString())}"
            data-share-label="Share tower"
            data-share-aria-label="Share the ${escapeHtml(meta.repo)} tower"
            aria-label="Share the ${escapeHtml(meta.repo)} tower"
          >
            <span class="share-button-icons" aria-hidden="true"><span>${icons.share}</span><span>${icons.check}</span></span>
            <span class="share-button-label" aria-live="polite">Share tower</span>
          </button>
        </div>
        ${repositoryDirectoryMarkup}
      </div>
      <div class="data-freshness">through ${dateShort.format(new Date(meta.end))} / cached until ${dateShort.format(new Date(meta.cacheUntil))}</div>
    </section>

    <div class="hover-card" id="hover-card"><strong></strong><span></span></div>
    <div class="system-event" id="system-event" data-kind="rupture" role="status" aria-live="polite" aria-atomic="true">
      <span class="system-event-sigil" aria-hidden="true"><i></i></span>
      <span class="system-event-copy"><small id="system-event-kicker">structural event</small><strong id="system-event-title">Impact registered</strong><span id="system-event-detail"></span></span>
    </div>
    <div class="loading-fallback" id="fallback"><div><strong>This tower needs WebGL 2.</strong><span>Open it in a recent version of Chrome, Safari, Firefox, or Edge.</span></div></div>
  </main>
  ${repositoryTransitionMarkup(meta.repo, {
    active: Boolean(repositoryTransfer),
    progress: BUILD_PROGRESS_HANDOFF,
    stage: 'Sculpting the new skyline',
  })}
`;

const experience = document.querySelector('.experience');
const canvas = document.querySelector('#scene');
const detailPanel = document.querySelector('#detail-panel');
const detailContent = document.querySelector('#detail-content');
const scrubber = document.querySelector('#scrubber');
const playButton = document.querySelector('#play');
const soundButton = document.querySelector('#sound');
const timelineDate = document.querySelector('#timeline-date');
const timelinePhase = document.querySelector('#timeline-phase');
const visibleCommits = document.querySelector('#visible-commits');
const visibleBranches = document.querySelector('#visible-branches');
const visibleIssues = document.querySelector('#visible-issues');
const hoverCard = document.querySelector('#hover-card');
const hoverTitle = hoverCard.querySelector('strong');
const hoverMeta = hoverCard.querySelector('span');
const systemEvent = document.querySelector('#system-event');
const systemEventKicker = document.querySelector('#system-event-kicker');
const systemEventTitle = document.querySelector('#system-event-title');
const systemEventDetail = document.querySelector('#system-event-detail');
const cityNavigator = document.querySelector('#city-navigator');
const cityRepository = document.querySelector('#city-repository');
const cityPeriod = document.querySelector('#city-period');
const cityCommits = document.querySelector('#city-commits');
const cityBranches = document.querySelector('#city-branches');
const cityContributors = document.querySelector('#city-contributors');
const cityEnterButton = document.querySelector('#city-enter');
const cityEnterLabel = document.querySelector('#city-enter-label');
const repositoryDirectoryPanel = document.querySelector('.repository-directory');
const repositoryDirectoryStatus = document.querySelector('.repository-directory-status');
const synthScore = createSynthScore({
  seed: meta.repo,
  audioContextFactory: isVideoCapture ? () => null : undefined,
});
let soundEnabled = true;

function updateSoundControl() {
  soundButton.setAttribute('aria-pressed', String(soundEnabled));
  soundButton.setAttribute('aria-label', soundEnabled ? 'Mute synth score' : 'Enable synth score');
  soundButton.title = soundEnabled ? 'Synth score on' : 'Synth score off';
  soundButton.classList.toggle('is-playing', soundEnabled && playing);
}

appRoot.addEventListener('error', (event) => {
  if (event.target instanceof HTMLImageElement && event.target.closest('.contributor-avatar')) {
    event.target.hidden = true;
  }
}, true);

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function hashNumber(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function colorForContributor(person) {
  const rank = contributorRank.get(contributorKey(person));
  if (rank != null && rank < contributorPalette.length) return contributorPalette[rank];
  const seed = hashNumber(contributorKey(person));
  const hue = Math.round((seed * 0.61803398875) % 360);
  return `hsl(${hue} 68% 58%)`;
}

function contributorAvatarMarkup(person, className = '') {
  const initials = String(person.name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || '?';
  const image = person.avatarUrl
    ? `<img src="${escapeHtml(person.avatarUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
    : '';
  return `
    <span class="contributor-avatar ${escapeHtml(className)}" style="--person-color:${colorForContributor(person)}">
      <span>${escapeHtml(initials)}</span>
      ${image}
    </span>
  `;
}

function metric(label, value) {
  return `<div class="metric-line"><dt>${escapeHtml(label)}</dt><dd title="${escapeHtml(value)}">${escapeHtml(value)}</dd></div>`;
}

function legend(label, value, color) {
  return `<div class="legend-row"><span class="legend-key"><i class="legend-swatch" style="--swatch:${color}"></i>${escapeHtml(label)}</span><span class="legend-value">${escapeHtml(value)}</span></div>`;
}

function contributorLegend(person) {
  return `<div class="legend-row"><span class="legend-key">${contributorAvatarMarkup(person, 'legend-avatar')}${escapeHtml(person.name)}</span><span class="legend-value">${number.format(person.commits)} commits</span></div>`;
}

function overviewContent(mode) {
  if (mode === 'city') {
    return `
      <div class="detail-kicker">Run402 repository city</div>
      <h2 class="detail-title">Every build<br>joins the skyline.</h2>
      <p class="detail-copy">Each landmark is a real public repository cached by a Run402 function in Postgres. Select a tower to fly across the city, then enter its complete commit history.</p>
      <dl class="metric-list">
        ${metric('landmarks', number.format(cityEntries.length))}
        ${metric('monthly cache', 'Run402 Postgres')}
        ${metric('navigation', 'tap / arrows / WASD')}
      </dl>
      <div class="legend">
        ${legend('Current tower', meta.repo, '#00ff9f')}
        ${legend('Cached landmarks', number.format(Math.max(0, cityEntries.length - 1)), '#ff9f43')}
      </div>
    `;
  }
  if (mode === 'branches') {
    const local = branches.filter((branch) => branch.scope === 'local').length;
    const remote = branches.length - local;
    return `
      <div class="detail-kicker">branch skyways</div>
      <h2 class="detail-title">The tower<br>grows ideas.</h2>
      <p class="detail-copy">Every live ref pulls the shell outward near its tip commit, grows a cantilever, then arcs into a skyway. Dense branch eras bloom into twisted, many-lobed floors.</p>
      <dl class="metric-list">
        ${metric('refs in snapshot', number.format(meta.branches))}
        ${metric('local / remote', `${local} / ${remote}`)}
        ${metric('base geometry', 'twisting heptagon')}
      </dl>
      <div class="legend">${legend('Local branch', number.format(local), '#18a190')}${legend('Origin branch', number.format(remote), '#00ff9f')}</div>
    `;
  }
  if (mode === 'issues') {
    return `
      <div class="detail-kicker">damage / repair system</div>
      <h2 class="detail-title">Rupture.<br>Rebuild in gold.</h2>
      <p class="detail-copy">An issue detonates at the height where it was opened. When it closes, fragments spiral home and the scar becomes a gold-to-mint kintsugi seam.</p>
      <dl class="metric-list">
        ${metric('issue impacts', number.format(structuralIssues.length))}
        ${metric('kintsugi repairs', number.format(repairedStructuralIssues.length))}
        ${metric('active breaches', number.format(openStructuralIssues.length))}
      </dl>
      <div class="legend">${legend('Repaired seam', number.format(repairedStructuralIssues.length), '#d3b15b')}${legend('Live breach', number.format(openStructuralIssues.length), '#ff7058')}</div>
    `;
  }
  if (mode === 'crews') {
    return `
      <div class="detail-kicker">construction crews</div>
      <h2 class="detail-title">Live crew<br>leaderboard.</h2>
      <p class="detail-copy">Rankings move with the build. Select a crew to isolate its footprint in the tower.</p>
      <div class="crew-board-status">
        <span><strong data-crew-active-count>${number.format(meta.contributors)}</strong> crews on site</span>
        <span><strong data-crew-commit-count>${number.format(meta.commits)}</strong> commits</span>
      </div>
      <div class="crew-board-heading"><span>rank / builder</span><span>commits</span></div>
      <div class="people-list" data-crew-leaderboard>
        ${contributors.slice(0, 24).map((person) => `
          <button class="person-row" type="button" data-contributor="${escapeHtml(person.id)}" aria-pressed="false" style="--person-color:${colorForContributor(person)}">
            <span class="person-rank">--</span>
            ${contributorAvatarMarkup(person, 'person-avatar')}
            <span class="person-name">${escapeHtml(person.name)}</span>
            <span class="person-volume">
              <span class="person-bar" aria-hidden="true"><i data-contributor-bar></i></span>
              <span class="person-count" data-contributor-count>${number.format(person.commits)}</span>
            </span>
          </button>
        `).join('')}
      </div>
    `;
  }
  return `
    <div class="detail-kicker">commit architecture</div>
    <h2 class="detail-title">Every commit<br>raises the skyline.</h2>
    <p class="detail-copy">Height is cumulative commit count. The core twists through seven facets; every branch tugs nearby modules outward into a data-shaped bloom. Color identifies who placed each piece.</p>
    <dl class="metric-list">
      ${metric('tower height', `${number.format(meta.commits)} commits`)}
      ${metric('contributors', number.format(meta.contributors))}
    </dl>
    <div class="legend contributor-legend">
      ${contributors.slice(0, 4).map(contributorLegend).join('')}
      ${contributors.length > 4 ? legend('Other contributors', number.format(contributors.length - 4), '#7f918c') : ''}
    </div>
  `;
}

let currentMode = 'build';
let selectedContributor = null;
let selectedObject = null;

function showOverview() {
  selectedObject = null;
  selectedContributor = null;
  detailPanel.classList.remove('is-inspecting');
  detailContent.innerHTML = overviewContent(currentMode);
  wireContributorRows();
}

function showCommit(commit, index) {
  selectedObject = { type: 'commit', index };
  detailPanel.classList.add('is-inspecting');
  detailContent.innerHTML = `
    <div class="detail-kicker">commit / ${escapeHtml(commit.shortHash)}</div>
    <h2 class="detail-title">${escapeHtml(commit.subject)}</h2>
    <p class="detail-copy">A structural module placed by ${escapeHtml(commit.author)} on ${escapeHtml(dateLong.format(new Date(commit.date)))}.</p>
    <dl class="metric-list">
      ${metric('author', commit.author)}
      ${metric('tower level', `commit ${number.format(index + 1)}`)}
      ${meta.statsAvailable === false ? '' : metric('changed', `${number.format(commit.files)} files`)}
      ${meta.statsAvailable === false ? '' : metric('delta', `+${number.format(commit.insertions)} / −${number.format(commit.deletions)}`)}
      ${metric('parents', number.format(commit.parents.length))}
    </dl>
    <a class="detail-link" href="${escapeHtml(repositoryUrl)}/commit/${encodeURIComponent(commit.hash)}" target="_blank" rel="noreferrer">Open commit ${icons.external}</a>
  `;
}

function showIssue(issue, index) {
  selectedObject = { type: 'issue', index };
  detailPanel.classList.add('is-inspecting');
  const status = issue.state === 'open' ? 'open signal' : 'repair complete';
  detailContent.innerHTML = `
    <div class="detail-kicker">issue #${issue.number} / ${status}</div>
    <h2 class="detail-title">${escapeHtml(issue.title)}</h2>
    <p class="detail-copy">Opened by ${escapeHtml(issue.author)} on ${escapeHtml(dateLong.format(new Date(issue.createdAt)))}${issue.closedAt ? ` and resolved ${escapeHtml(dateLong.format(new Date(issue.closedAt)))}` : ''}.</p>
    <dl class="metric-list">
      ${metric('state', issue.state)}
      ${metric('comments', number.format(issue.comments))}
      ${metric('labels', issue.labels.slice(0, 3).join(', ') || 'none')}
      ${metric('assignees', issue.assignees.join(', ') || 'unassigned')}
    </dl>
    <a class="detail-link" href="${escapeHtml(issue.url)}" target="_blank" rel="noreferrer">Open issue ${icons.external}</a>
  `;
}

function showBranch(branch, index) {
  selectedObject = { type: 'branch', index };
  detailPanel.classList.add('is-inspecting');
  const branchPath = branch.name.replace(/^origin\//, '');
  const branchCopy = branch.tipResolved === false
    ? `This branch tip sits outside the sampled default-branch history, so its skyway is anchored deterministically to the tower at ${escapeHtml(branch.shortHash)}.`
    : `This skyway terminates at ${escapeHtml(branch.shortHash)}, last moved by ${escapeHtml(branch.author)} on ${escapeHtml(dateLong.format(new Date(branch.date)))}.`;
  detailContent.innerHTML = `
    <div class="detail-kicker">${escapeHtml(branch.scope)} branch</div>
    <h2 class="detail-title">${escapeHtml(branchPath.replaceAll('-', ' '))}</h2>
    <p class="detail-copy">${branchCopy}</p>
    <dl class="metric-list">
      ${metric('ref', branch.name)}
      ${metric('tip', branch.shortHash)}
      ${metric('scope', branch.scope)}
    </dl>
    <a class="detail-link" href="${escapeHtml(repositoryUrl)}/tree/${encodeURIComponent(branchPath)}" target="_blank" rel="noreferrer">Open branch ${icons.external}</a>
  `;
}

function wireContributorRows() {
  detailContent.querySelectorAll('[data-contributor]').forEach((button) => {
    button.addEventListener('click', () => {
      const next = selectedContributor === button.dataset.contributor ? null : button.dataset.contributor;
      selectedContributor = next;
      detailContent.querySelectorAll('[data-contributor]').forEach((row) => {
        row.setAttribute('aria-pressed', String(row.dataset.contributor === next));
      });
      recolorCommits();
    });
  });
}

showOverview();

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x07090b, 0.0125);

const camera = new THREE.PerspectiveCamera(44, window.innerWidth / window.innerHeight, 0.1, 360);
camera.position.set(60, 42, 80);

let renderer;
try {
  const context = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    powerPreference: 'high-performance',
  });
  if (!context) throw new Error('WebGL 2 is unavailable');
  renderer = new THREE.WebGLRenderer({ canvas, context, alpha: true, antialias: false, powerPreference: 'high-performance' });
} catch (error) {
  console.error(error);
  document.querySelector('#fallback').style.display = 'grid';
  throw error;
}

renderer.setPixelRatio(mobileRenderer ? 1 : Math.min(window.devicePixelRatio, 1.8));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.28;
renderer.setClearColor(0x07090b, 0);

let composer = null;
let bloomPass = null;
if (bloomEnabled) {
  const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
    import('three/addons/postprocessing/EffectComposer.js'),
    import('three/addons/postprocessing/RenderPass.js'),
    import('three/addons/postprocessing/UnrealBloomPass.js'),
    import('three/addons/postprocessing/OutputPass.js'),
  ]);
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.72, 0.72, 0.18);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
}

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.045;
controls.enablePan = false;
controls.autoRotate = !reducedMotion && !mobileRenderer && !isVideoCapture;
controls.autoRotateSpeed = 0.28;
controls.minDistance = 22;
controls.maxDistance = 120;
controls.minPolarAngle = 0.32;
controls.maxPolarAngle = Math.PI * 0.72;
let controlsInteracting = false;
controls.addEventListener('start', () => {
  controlsInteracting = true;
});
controls.addEventListener('end', () => {
  controlsInteracting = false;
  if (currentMode === 'city') focusTarget.copy(controls.target);
});

const commitBaseY = 1.2;
const commitRise = THREE.MathUtils.clamp(62 / Math.max(commits.length, 1), 0.012, 0.034);
const yForCommitCount = (count) => commitBaseY + THREE.MathUtils.clamp(count, 0, commits.length) * commitRise;
const towerHeight = yForCommitCount(commits.length);
const defaultFocus = new THREE.Vector3(0, towerHeight * 0.44, 0);
const focusTarget = defaultFocus.clone();
controls.target.copy(defaultFocus);

scene.add(new THREE.HemisphereLight(0xb9fff0, 0x170f08, 2.55));
scene.add(new THREE.AmbientLight(0xffffff, 1.35));
const keyLight = new THREE.DirectionalLight(0xf5f0e1, 5.2);
keyLight.position.set(17, 60, 24);
scene.add(keyLight);
const mintLight = new THREE.PointLight(0x00ff9f, 68, 74, 1.7);
mintLight.position.set(-12, towerHeight * 0.56, 8);
scene.add(mintLight);
const goldLight = new THREE.PointLight(0xd3b15b, 48, 62, 1.8);
goldLight.position.set(13, towerHeight * 0.28, -9);
scene.add(goldLight);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(70, 96),
  new THREE.MeshStandardMaterial({ color: 0x080b0b, metalness: 0.5, roughness: 0.68 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.25;
scene.add(ground);

const grid = new THREE.GridHelper(120, 60, 0x0f7f74, 0x153330);
grid.position.y = -0.2;
grid.material.transparent = true;
grid.material.opacity = 0.18;
scene.add(grid);

const foundation = new THREE.Group();
const foundationMaterial = new THREE.MeshPhysicalMaterial({
  color: 0x0c1515,
  emissive: 0x05251d,
  emissiveIntensity: 0.65,
  metalness: 0.86,
  roughness: 0.26,
});
for (let level = 0; level < 4; level += 1) {
  const slab = new THREE.Mesh(new THREE.CylinderGeometry(10.8 - level * 0.7, 11.3 - level * 0.65, 0.34, 14), foundationMaterial);
  slab.position.y = level * 0.34 - 0.02;
  foundation.add(slab);
}
scene.add(foundation);

const core = new THREE.Mesh(
  new THREE.CylinderGeometry(5.55, 6.25, towerHeight + 2, 7, 1, true),
  new THREE.MeshPhysicalMaterial({
    color: 0x0f7f74,
    emissive: 0x063b35,
    emissiveIntensity: 0.68,
    metalness: 0.75,
    roughness: 0.42,
    transparent: true,
    opacity: 0.16,
    side: THREE.DoubleSide,
  }),
);
core.position.y = towerHeight * 0.5 + 0.65;
scene.add(core);

const coreCap = new THREE.Mesh(
  new THREE.CylinderGeometry(5.55, 5.55, 0.28, 7),
  new THREE.MeshPhysicalMaterial({ color: 0x0f7f74, emissive: 0x0f7f74, emissiveIntensity: 1.1, metalness: 0.7, roughness: 0.3 }),
);
coreCap.position.y = towerHeight + 1.7;
scene.add(coreCap);

function makeTextSprite(text, { accent = '#00ff9f', width = 5.2, height = 1.08 } = {}) {
  const labelCanvas = document.createElement('canvas');
  labelCanvas.width = 384;
  labelCanvas.height = 80;
  const context = labelCanvas.getContext('2d');
  context.clearRect(0, 0, labelCanvas.width, labelCanvas.height);
  context.font = '500 28px JetBrains Mono, monospace';
  context.fillStyle = 'rgba(245,240,225,0.96)';
  context.fillText(text.toUpperCase(), 10, 42);
  context.fillStyle = accent;
  context.fillRect(10, 57, 72, 2);
  const texture = new THREE.CanvasTexture(labelCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(width, height, 1);
  return sprite;
}

const cityGroup = new THREE.Group();
cityGroup.name = 'run402-repository-city';
cityGroup.visible = false;
const cityInfrastructureGroup = new THREE.Group();
cityInfrastructureGroup.name = 'run402-city-infrastructure';
cityGroup.add(cityInfrastructureGroup);
const cityTowerHitTargets = [];
const cityLandmarks = [];
const cityBeacons = [];
const cityBackdropByRepository = new Map(
  createNeighborBackdrop(cityEntries, mobileRenderer ? 3 : 7)
    .map((entry) => [entry.repo.toLowerCase(), entry]),
);

const cityRoadMaterial = new THREE.MeshBasicMaterial({ color: 0x0a1a18, transparent: true, opacity: 0.9 });
for (const avenue of [
  [0, 0, 146, 4.8], [0, 0, 4.8, 146],
  [0, -30, 146, 2.2], [0, 31, 146, 2.2],
  [-31, 0, 2.2, 146], [32, 0, 2.2, 146],
]) {
  const road = new THREE.Mesh(new THREE.BoxGeometry(avenue[2], 0.05, avenue[3]), cityRoadMaterial);
  road.position.set(avenue[0], -0.15, avenue[1]);
  cityInfrastructureGroup.add(road);
}

const cityLightPositions = [];
const cityLightColors = [];
const mintStreetLight = new THREE.Color('#00ff9f');
const orangeStreetLight = new THREE.Color('#ff9f43');
for (let distance = -68; distance <= 68; distance += 4) {
  for (const [x, z, color] of [
    [distance, -2.1, mintStreetLight], [distance, 2.1, orangeStreetLight],
    [-2.1, distance, orangeStreetLight], [2.1, distance, mintStreetLight],
  ]) {
    cityLightPositions.push(x, 0.08, z);
    cityLightColors.push(color.r, color.g, color.b);
  }
}
const cityLightGeometry = new THREE.BufferGeometry();
cityLightGeometry.setAttribute('position', new THREE.Float32BufferAttribute(cityLightPositions, 3));
cityLightGeometry.setAttribute('color', new THREE.Float32BufferAttribute(cityLightColors, 3));
cityInfrastructureGroup.add(new THREE.Points(cityLightGeometry, new THREE.PointsMaterial({
  size: mobileRenderer ? 0.24 : 0.32,
  vertexColors: true,
  transparent: true,
  opacity: 0.82,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  toneMapped: false,
})));

const ambientGeometry = new THREE.BoxGeometry(1, 1, 1);
const ambientMaterial = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  vertexColors: true,
  transparent: true,
  opacity: mobileRenderer ? 0.38 : 0.52,
  toneMapped: false,
});
const ambientBlocks = new THREE.InstancedMesh(ambientGeometry, ambientMaterial, 144);
const ambientMatrix = new THREE.Matrix4();
const ambientQuaternion = new THREE.Quaternion();
const ambientPosition = new THREE.Vector3();
const ambientScale = new THREE.Vector3();
let ambientCount = 0;
for (let x = -60; x <= 60; x += 10) {
  for (let z = -60; z <= 60; z += 10) {
    if (Math.abs(x) < 8 || Math.abs(z) < 8) continue;
    if (cityEntries.some((entry) => Math.hypot(entry.x - x, entry.z - z) < 8)) continue;
    const seed = hashNumber(`city-block-${x}-${z}`);
    const width = 2.2 + (seed % 24) / 10;
    const depth = 2.2 + ((seed >>> 6) % 24) / 10;
    const height = 1.4 + ((seed >>> 12) % 64) / 10;
    ambientPosition.set(x + ((seed >>> 18) % 9 - 4) * 0.32, height * 0.5, z + ((seed >>> 22) % 9 - 4) * 0.32);
    ambientScale.set(width, height, depth);
    ambientMatrix.compose(ambientPosition, ambientQuaternion, ambientScale);
    ambientBlocks.setMatrixAt(ambientCount, ambientMatrix);
    const lightness = 0.18 + ((seed >>> 24) % 13) / 100;
    ambientBlocks.setColorAt(ambientCount, new THREE.Color().setHSL(0.46 + (seed % 13) / 500, 0.42, lightness));
    ambientCount += 1;
  }
}
ambientBlocks.count = ambientCount;
ambientBlocks.instanceMatrix.needsUpdate = true;
if (ambientBlocks.instanceColor) ambientBlocks.instanceColor.needsUpdate = true;
cityInfrastructureGroup.add(ambientBlocks);

const cityPalette = ['#00ff9f', '#ff9f43', '#66b8ff', '#d98cff', '#ffd166', '#3ee6d0', '#ff6b57', '#8f9cff'];
cityEntries.forEach((entry, index) => {
  const height = entry.current ? towerHeight : entry.height;
  const position = new THREE.Vector3(entry.x, 0, entry.z);
  const seed = hashNumber(entry.repo);
  const accent = new THREE.Color(entry.current ? '#00ff9f' : cityPalette[index % cityPalette.length]);
  const landmark = new THREE.Group();
  landmark.position.copy(position);
  landmark.userData.cityIndex = index;
  let foundationSurfaceMaterial = null;
  let surfaceMaterial = null;
  let edgeMaterial = null;
  let windowMaterial = null;

  if (!entry.current) {
    foundationSurfaceMaterial = new THREE.MeshBasicMaterial({
      color: 0x102725,
      transparent: true,
      opacity: 1,
      toneMapped: false,
    });
    const foundationMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(entry.radius + 1.6, entry.radius + 2, 0.45, 10),
      foundationSurfaceMaterial,
    );
    foundationMesh.position.y = 0.05;
    landmark.add(foundationMesh);

    const sides = 4 + (Math.max(0, Number(entry.branches) || 0) % 5);
    surfaceMaterial = new THREE.MeshBasicMaterial({
      color: accent.clone().multiplyScalar(0.16),
      transparent: true,
      opacity: 0.94,
      toneMapped: false,
    });
    edgeMaterial = new THREE.LineBasicMaterial({
      color: accent,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      toneMapped: false,
    });
    let tierBase = 0.32;
    [0.44, 0.33, 0.23].forEach((share, tier) => {
      const tierHeight = height * share;
      const bottomRadius = entry.radius * (1 - tier * 0.13);
      const topRadius = bottomRadius * (0.76 + ((seed >>> (tier * 4)) % 17) / 100);
      const geometry = new THREE.CylinderGeometry(topRadius, bottomRadius, tierHeight, sides, 1, false);
      const segment = new THREE.Mesh(geometry, surfaceMaterial);
      segment.position.y = tierBase + tierHeight * 0.5;
      segment.rotation.y = tier * 0.22 + (seed % 17) * 0.012;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 18), edgeMaterial);
      edges.position.copy(segment.position);
      edges.rotation.copy(segment.rotation);
      landmark.add(segment, edges);
      tierBase += tierHeight;
    });

    const windowPositions = [];
    const windowColors = [];
    const warmWindow = new THREE.Color('#f5f0e1');
    for (let level = 1.8; level < height - 1; level += 2.25) {
      const levelRadius = entry.radius * (0.98 - level / height * 0.2) + 0.08;
      for (let face = 0; face < sides; face += 1) {
        if ((seed + face * 17 + Math.round(level * 10)) % 4 === 0) continue;
        const angle = face / sides * Math.PI * 2 + (seed % 17) * 0.012;
        windowPositions.push(Math.cos(angle) * levelRadius, level, Math.sin(angle) * levelRadius);
        const windowColor = (face + Math.round(level)) % 5 === 0 ? warmWindow : accent;
        windowColors.push(windowColor.r, windowColor.g, windowColor.b);
      }
    }
    const windowGeometry = new THREE.BufferGeometry();
    windowGeometry.setAttribute('position', new THREE.Float32BufferAttribute(windowPositions, 3));
    windowGeometry.setAttribute('color', new THREE.Float32BufferAttribute(windowColors, 3));
    windowMaterial = new THREE.PointsMaterial({
      size: mobileRenderer ? 0.16 : 0.2,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    landmark.add(new THREE.Points(windowGeometry, windowMaterial));
  }

  const beacon = new THREE.Mesh(
    new THREE.OctahedronGeometry(entry.current ? 0.5 : 0.38, 1),
    new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.96, toneMapped: false }),
  );
  beacon.position.set(0, height + 1.25, 0);
  landmark.add(beacon);
  cityBeacons.push(beacon);

  const label = makeTextSprite(entry.repo, {
    accent: `#${accent.getHexString()}`,
    width: Math.min(10.5, Math.max(6.8, entry.repo.length * 0.42)),
    height: 1.65,
  });
  label.position.set(0, height + 3.1, 0);
  landmark.add(label);

  const hitTarget = new THREE.Mesh(
    new THREE.CylinderGeometry(Math.max(5.8, entry.radius + 1.8), Math.max(5.8, entry.radius + 1.8), height + 6, 8),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
  );
  hitTarget.position.set(entry.x, (height + 6) * 0.5, entry.z);
  hitTarget.userData.cityIndex = index;
  cityTowerHitTargets.push(hitTarget);
  cityGroup.add(hitTarget);

  cityGroup.add(landmark);
  cityLandmarks.push({
    entry,
    position,
    height,
    beacon,
    label,
    landmark,
    hitTarget,
    foundationSurfaceMaterial,
    surfaceMaterial,
    edgeMaterial,
    windowMaterial,
  });
});

const citySelectionRing = new THREE.Mesh(
  new THREE.TorusGeometry(5.8, 0.12, 8, 64),
  new THREE.MeshBasicMaterial({ color: 0xff9f43, transparent: true, opacity: 0.86, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
);
citySelectionRing.rotation.x = Math.PI / 2;
citySelectionRing.position.y = 0.28;
cityGroup.add(citySelectionRing);
scene.add(cityGroup);

function setCityPresentation(isCity) {
  highlightedBackdropIndex = -1;
  cityGroup.visible = isCity || !isVideoCapture;
  cityInfrastructureGroup.visible = isCity;
  citySelectionRing.visible = isCity;

  cityLandmarks.forEach((item) => {
    const { entry, landmark, label, beacon, hitTarget } = item;
    const backdrop = cityBackdropByRepository.get(entry.repo.toLowerCase());
    const showBackdrop = !isCity && Boolean(backdrop) && !isVideoCapture;
    landmark.visible = isCity || showBackdrop;
    hitTarget.visible = landmark.visible;
    if (!landmark.visible) {
      label.visible = false;
      return;
    }

    if (isCity) {
      landmark.position.copy(item.position);
      landmark.scale.setScalar(1);
      hitTarget.position.set(item.position.x, (item.height + 6) * 0.5, item.position.z);
      hitTarget.scale.setScalar(1);
      label.visible = true;
      label.material.opacity = 1;
      beacon.material.opacity = 0.96;
      if (item.foundationSurfaceMaterial) item.foundationSurfaceMaterial.opacity = 1;
      if (item.surfaceMaterial) {
        item.surfaceMaterial.opacity = 0.94;
        item.surfaceMaterial.depthWrite = true;
        item.surfaceMaterial.needsUpdate = true;
      }
      if (item.edgeMaterial) item.edgeMaterial.opacity = 0.72;
      if (item.windowMaterial) item.windowMaterial.opacity = 0.9;
      return;
    }

    landmark.position.set(backdrop.x, -0.08, backdrop.z);
    landmark.scale.setScalar(backdrop.scale);
    hitTarget.position.set(backdrop.x, (item.height + 6) * 0.5 * backdrop.scale, backdrop.z);
    hitTarget.scale.setScalar(backdrop.scale);
    label.visible = true;
    label.material.opacity = 0.42;
    beacon.material.opacity = 0.58;
    if (item.foundationSurfaceMaterial) item.foundationSurfaceMaterial.opacity = 0.42;
    if (item.surfaceMaterial) {
      item.surfaceMaterial.opacity = 0.48;
      item.surfaceMaterial.depthWrite = false;
      item.surfaceMaterial.needsUpdate = true;
    }
    if (item.edgeMaterial) item.edgeMaterial.opacity = 0.48;
    if (item.windowMaterial) item.windowMaterial.opacity = 0.68;
  });
}

let highlightedBackdropIndex = -1;

function setBackdropHighlight(index) {
  if (currentMode === 'city') index = -1;
  if (highlightedBackdropIndex === index) return;
  highlightedBackdropIndex = index;
  cityLandmarks.forEach((item, itemIndex) => {
    if (!item.landmark.visible || item.entry.current) return;
    const active = itemIndex === highlightedBackdropIndex;
    item.label.material.opacity = active ? 1 : 0.42;
    item.beacon.material.opacity = active ? 0.96 : 0.58;
    if (item.surfaceMaterial) item.surfaceMaterial.opacity = active ? 0.66 : 0.48;
    if (item.edgeMaterial) item.edgeMaterial.opacity = active ? 0.9 : 0.48;
    if (item.windowMaterial) item.windowMaterial.opacity = active ? 1 : 0.68;
  });
}

const segmentsPerRing = 64;
const towerFacetCount = 7;
const branchRecords = [...branches].sort((a, b) => new Date(a.date) - new Date(b.date));

function facadeAngleForCommit(index) {
  const ring = Math.floor(index / segmentsPerRing);
  const slot = index % segmentsPerRing;
  const stagger = ring % 2 === 0 ? 0 : 0.5;
  return ((slot + stagger) / segmentsPerRing) * Math.PI * 2;
}

const branchShapeAnchors = branchRecords.map((branch) => {
  const commitIndex = THREE.MathUtils.clamp(
    branch.commitIndex ?? binaryCountByDate(commits, 'date', new Date(branch.date)) - 1,
    0,
    commits.length - 1,
  );
  return {
    commitIndex,
    angle: facadeAngleForCommit(commitIndex),
    strength: branch.scope === 'local' ? 0.82 : 1,
  };
});

function wrappedAngleDifference(first, second) {
  return Math.atan2(Math.sin(first - second), Math.cos(first - second));
}

function towerRadiusAtCommit(commitIndex, angle) {
  const resolvedIndex = THREE.MathUtils.clamp(commitIndex, 0, commits.length - 1);
  const ring = Math.floor(resolvedIndex / segmentsPerRing);
  const twist = ring * 0.045;
  const facetArc = (Math.PI * 2) / towerFacetCount;
  const facetAngle = THREE.MathUtils.euclideanModulo(angle + twist + facetArc * 0.5, facetArc) - facetArc * 0.5;
  const crystallineRadius = 7.72 * (Math.cos(Math.PI / towerFacetCount) / Math.cos(facetAngle));
  let branchPressure = 0;
  for (const anchor of branchShapeAnchors) {
    const branchAge = resolvedIndex - anchor.commitIndex;
    if (branchAge < 0 || branchAge > 180) continue;
    const verticalInfluence = (1 - branchAge / 180) ** 2;
    const directionalInfluence = Math.max(0, Math.cos(wrappedAngleDifference(angle, anchor.angle))) ** 8;
    branchPressure += verticalInfluence * directionalInfluence * anchor.strength;
  }
  const branchBloom = Math.min(3.2, Math.log1p(branchPressure) * 1.45);
  return crystallineRadius + branchBloom;
}

const commitPositions = [];
const commitMatrices = [];
const commitColors = [];
const commitGeometry = new THREE.BoxGeometry(0.64, 0.38, 0.54, 1, 1, 1);
commitGeometry.translate(0, 0.03, 0);
const commitMaterial = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  vertexColors: true,
  transparent: false,
  opacity: 1,
  toneMapped: false,
});
const commitMesh = new THREE.InstancedMesh(commitGeometry, commitMaterial, commits.length);
commitMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
commitMesh.name = 'commit-modules';
const matrix = new THREE.Matrix4();
const position = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const scale = new THREE.Vector3();
const upAxis = new THREE.Vector3(0, 1, 0);

for (let index = 0; index < commits.length; index += 1) {
  const commit = commits[index];
  const ring = Math.floor(index / segmentsPerRing);
  const slot = index % segmentsPerRing;
  const stagger = ring % 2 === 0 ? 0 : 0.5;
  const angle = ((slot + stagger) / segmentsPerRing) * Math.PI * 2;
  const jitter = ((hashNumber(commit.hash) % 13) - 6) * 0.018;
  const radius = towerRadiusAtCommit(index, angle) + jitter;
  const y = yForCommitCount(index + 1);
  position.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
  quaternion.setFromAxisAngle(upAxis, -angle);
  const churn = Math.log10(commit.insertions + commit.deletions + 1);
  scale.set(0.78 + Math.min(churn * 0.11, 0.38), 0.92, 0.86 + Math.min(churn * 0.04, 0.16));
  matrix.compose(position, quaternion, scale);
  commitMesh.setMatrixAt(index, matrix);
  const commitColor = new THREE.Color(colorForContributor(commit)).multiplyScalar(1.22);
  commitMesh.setColorAt(index, commitColor);
  commitColors.push(commitColor);
  commitMatrices.push(matrix.clone());
  commitPositions.push(position.clone());
}
commitMesh.instanceMatrix.needsUpdate = true;
commitMesh.instanceColor.needsUpdate = true;
scene.add(commitMesh);

const commitGlowPositions = new Float32Array(commits.length * 3);
const commitGlowColors = new Float32Array(commits.length * 3);
commitPositions.forEach((commitPosition, index) => {
  commitGlowPositions[index * 3] = commitPosition.x * 1.055;
  commitGlowPositions[index * 3 + 1] = commitPosition.y;
  commitGlowPositions[index * 3 + 2] = commitPosition.z * 1.055;
  commitColors[index].toArray(commitGlowColors, index * 3);
});
const commitGlowGeometry = new THREE.BufferGeometry();
commitGlowGeometry.setAttribute('position', new THREE.BufferAttribute(commitGlowPositions, 3));
commitGlowGeometry.setAttribute('color', new THREE.BufferAttribute(commitGlowColors, 3));
const commitGlowMaterial = new THREE.PointsMaterial({
  size: 0.23,
  vertexColors: true,
  transparent: true,
  opacity: 0.82,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  toneMapped: false,
});
const commitGlow = new THREE.Points(commitGlowGeometry, commitGlowMaterial);
commitGlow.name = 'contributor-color-beacons';
scene.add(commitGlow);

const strata = new THREE.Group();
const ringMaterial = new THREE.LineBasicMaterial({ color: 0xd3b15b, transparent: true, opacity: 0.34, depthWrite: false });
let cumulativeMonthlyCommits = 0;
months.forEach((month) => {
  cumulativeMonthlyCommits += month.commits;
  const commitIndex = Math.max(0, cumulativeMonthlyCommits - 1);
  const contourPoints = [];
  for (let step = 0; step < 96; step += 1) {
    const angle = (step / 96) * Math.PI * 2;
    const radius = towerRadiusAtCommit(commitIndex, angle) + 0.5;
    contourPoints.push(new THREE.Vector3(Math.cos(angle) * radius, yForCommitCount(cumulativeMonthlyCommits), Math.sin(angle) * radius));
  }
  strata.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(contourPoints), ringMaterial));
});
scene.add(strata);

function niceAxisStep(total, targetTicks = 7) {
  const rough = Math.max(1, total / targetTicks);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const multiple = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiple * magnitude;
}

const commitAxis = new THREE.Group();
commitAxis.name = 'commit-count-axis';
const axisX = 12.2;
const axisLineGeometry = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(axisX, commitBaseY, 0),
  new THREE.Vector3(axisX, towerHeight, 0),
]);
commitAxis.add(new THREE.Line(axisLineGeometry, new THREE.LineBasicMaterial({ color: 0xf5f0e1, transparent: true, opacity: 0.22 })));
const axisStep = niceAxisStep(commits.length);
const axisCounts = [];
for (let count = 0; count <= commits.length; count += axisStep) axisCounts.push(count);
if (axisCounts.at(-1) !== commits.length) axisCounts.push(commits.length);
axisCounts.forEach((count) => {
  const y = yForCommitCount(count);
  const tickGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(axisX - 0.32, y, 0),
    new THREE.Vector3(axisX + 0.18, y, 0),
  ]);
  commitAxis.add(new THREE.Line(tickGeometry, new THREE.LineBasicMaterial({ color: 0xd3b15b, transparent: true, opacity: 0.78 })));
  const label = makeTextSprite(`${number.format(count)} commits`, { accent: '#d3b15b', width: 5.8, height: 1.42 });
  label.position.set(axisX + 2.55, y + 0.08, 0);
  commitAxis.add(label);
});
const axisTitle = makeTextSprite('Y / cumulative commits', { accent: '#00ff9f', width: 6.4, height: 1.5 });
axisTitle.position.set(axisX + 2.75, towerHeight + 1.35, 0);
commitAxis.add(axisTitle);
scene.add(commitAxis);

const spineGeometry = new THREE.BufferGeometry();
const spinePositions = [];
for (let column = 0; column < towerFacetCount; column += 1) {
  const angle = (column / towerFacetCount) * Math.PI * 2;
  spinePositions.push(Math.cos(angle) * 6.4, 0.8, Math.sin(angle) * 6.4);
  spinePositions.push(Math.cos(angle) * 6.4, towerHeight + 1.4, Math.sin(angle) * 6.4);
}
spineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(spinePositions, 3));
const spines = new THREE.LineSegments(spineGeometry, new THREE.LineBasicMaterial({ color: 0x18a190, transparent: true, opacity: 0.2 }));
scene.add(spines);

function createStars(count) {
  const starPositions = new Float32Array(count * 3);
  const starSizes = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 28 + Math.random() * 110;
    starPositions[index * 3] = Math.cos(angle) * radius;
    starPositions[index * 3 + 1] = Math.random() * 115 - 12;
    starPositions[index * 3 + 2] = Math.sin(angle) * radius;
    starSizes[index] = 0.5 + Math.random();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(starSizes, 1));
  return new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0x7ccdb7, size: 0.055, transparent: true, opacity: 0.42, depthWrite: false }));
}
const stars = createStars(mobileRenderer ? 460 : 1250);
scene.add(stars);

const branchGroup = new THREE.Group();
branchGroup.name = 'branch-skyways';
const branchPathSegments = 18;
const branchPathPositions = [];
const branchPathColors = [];
const branchShoulderMaterial = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  vertexColors: true,
  transparent: true,
  opacity: 0.48,
  depthWrite: false,
  toneMapped: false,
});
const branchShoulders = new THREE.InstancedMesh(
  new THREE.BoxGeometry(1, 0.11, 0.5),
  branchShoulderMaterial,
  branchRecords.length,
);
branchShoulders.name = 'branch-cantilevers';
branchShoulders.instanceMatrix.setUsage(THREE.StaticDrawUsage);
const branchTips = new THREE.InstancedMesh(
  new THREE.IcosahedronGeometry(0.12, 1),
  new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.94 }),
  branchRecords.length,
);
const branchPositions = [];
branchRecords.forEach((branch, index) => {
  const seed = hashNumber(branch.name);
  const start = branch.commitIndex != null
    ? commitPositions[branch.commitIndex].clone()
    : new THREE.Vector3(7.7, yForCommitCount(binaryCountByDate(commits, 'date', new Date(branch.date))), 0);
  const startAngle = Math.atan2(start.z, start.x);
  const fanOffset = ((((seed >>> 3) % 2000) / 2000) - 0.5) * 1.35;
  const angle = startAngle + fanOffset;
  const reach = Math.hypot(start.x, start.z) + 3.2 + ((seed >>> 5) % 38) / 10;
  const end = new THREE.Vector3(
    Math.cos(angle) * reach,
    Math.max(1.5, start.y + (((seed >>> 11) % 31) - 15) * 0.07),
    Math.sin(angle) * reach,
  );
  const control = start.clone().lerp(end, 0.52);
  control.y += 1.2 + ((seed >>> 17) % 24) * 0.08;
  control.multiply(new THREE.Vector3(1.08, 1, 1.08));
  const curve = new THREE.QuadraticBezierCurve3(start, control, end);
  const curvePoints = curve.getPoints(branchPathSegments);
  const pathColor = new THREE.Color(branch.scope === 'local' ? '#18a190' : '#00ff9f');
  for (let segment = 0; segment < branchPathSegments; segment += 1) {
    branchPathPositions.push(...curvePoints[segment].toArray(), ...curvePoints[segment + 1].toArray());
    branchPathColors.push(pathColor.r, pathColor.g, pathColor.b, pathColor.r, pathColor.g, pathColor.b);
  }
  matrix.compose(end, new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
  branchTips.setMatrixAt(index, matrix);
  branchTips.setColorAt(index, new THREE.Color(branch.scope === 'local' ? '#18a190' : '#00ff9f'));
  const shoulderDirection = end.clone().sub(start).setY(0).normalize();
  const shoulderLength = 0.95 + ((seed >>> 13) % 15) / 10;
  const shoulderPosition = start.clone().addScaledVector(shoulderDirection, shoulderLength * 0.5);
  const shoulderAngle = Math.atan2(shoulderDirection.z, shoulderDirection.x);
  matrix.compose(
    shoulderPosition,
    new THREE.Quaternion().setFromAxisAngle(upAxis, -shoulderAngle),
    new THREE.Vector3(shoulderLength, branch.scope === 'local' ? 0.82 : 1, 1),
  );
  branchShoulders.setMatrixAt(index, matrix);
  branchShoulders.setColorAt(index, pathColor);
  branchPositions.push(end);
});
const branchPathGeometry = new THREE.BufferGeometry();
branchPathGeometry.setAttribute('position', new THREE.Float32BufferAttribute(branchPathPositions, 3));
branchPathGeometry.setAttribute('color', new THREE.Float32BufferAttribute(branchPathColors, 3));
const branchPaths = new THREE.LineSegments(
  branchPathGeometry,
  new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: mobileRenderer ? 0.74 : 0.5, depthWrite: false, toneMapped: false }),
);
branchPaths.name = 'branch-paths';
branchTips.instanceMatrix.needsUpdate = true;
if (branchTips.instanceColor) branchTips.instanceColor.needsUpdate = true;
branchShoulders.instanceMatrix.needsUpdate = true;
if (branchShoulders.instanceColor) branchShoulders.instanceColor.needsUpdate = true;
branchTips.name = 'branch-beacons';
branchGroup.add(branchPaths, branchTips);
branchGroup.visible = false;
scene.add(branchGroup);
scene.add(branchShoulders);

const issueGroup = new THREE.Group();
issueGroup.name = 'repair-orbit';
const issueMesh = new THREE.InstancedMesh(
  new THREE.OctahedronGeometry(0.2, 1),
  mobileRenderer
    ? new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.96, toneMapped: false })
    : new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      emissive: 0x241405,
      emissiveIntensity: 1.25,
      metalness: 0.46,
      roughness: 0.28,
      vertexColors: true,
    }),
  issues.length,
);
const issuePositions = [];
const issueBeamPositions = new Float32Array(issues.length * 6);
const issueBeamColors = new Float32Array(issues.length * 6);
issues.forEach((issue, index) => {
  const seed = hashNumber(`${issue.number}-${issue.title}`);
  const angle = index * 2.399963229728653 + (seed % 100) * 0.003;
  const radius = 11.4 + ((seed >>> 4) % 48) * 0.09;
  const issueCommitCount = binaryCountByDate(commits, 'date', new Date(issue.createdAt));
  const y = yForCommitCount(issueCommitCount);
  const point = new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
  const targetRadius = towerRadiusAtCommit(Math.max(0, issueCommitCount - 1), angle) + 0.32;
  const target = new THREE.Vector3(Math.cos(angle) * targetRadius, y, Math.sin(angle) * targetRadius);
  const size = issue.state === 'open' ? 1.3 : 0.8 + Math.min(issue.comments, 8) * 0.04;
  matrix.compose(point, new THREE.Quaternion().setFromAxisAngle(upAxis, angle), new THREE.Vector3(size, size, size));
  issueMesh.setMatrixAt(index, matrix);
  const issueColor = new THREE.Color(issue.state === 'open' ? '#ff7058' : '#d3b15b');
  issueMesh.setColorAt(index, issueColor);
  issuePositions.push(point);
  issueBeamPositions.set([point.x, point.y, point.z, target.x, target.y, target.z], index * 6);
  issueBeamColors.set([issueColor.r, issueColor.g, issueColor.b, issueColor.r, issueColor.g, issueColor.b], index * 6);
});
issueMesh.instanceMatrix.needsUpdate = true;
if (issueMesh.instanceColor) issueMesh.instanceColor.needsUpdate = true;
issueMesh.name = 'issue-signals';
issueGroup.add(issueMesh);
const issueBeamGeometry = new THREE.BufferGeometry();
issueBeamGeometry.setAttribute('position', new THREE.BufferAttribute(issueBeamPositions, 3));
issueBeamGeometry.setAttribute('color', new THREE.BufferAttribute(issueBeamColors, 3));
const issueBeams = new THREE.LineSegments(issueBeamGeometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.16, depthWrite: false }));
issueGroup.add(issueBeams);
issueGroup.visible = false;
scene.add(issueGroup);

const bugDamageGroup = new THREE.Group();
bugDamageGroup.name = 'bug-damage-and-kintsugi';
const periodStartTimestamp = new Date(meta.start).valueOf();
const periodEndTimestamp = new Date(meta.end).valueOf();
const structuralRecords = structuralIssues.map((issue) => {
  const seed = hashNumber(`bug-${issue.number}-${issue.title}`);
  const angle = ((seed % 10000) / 10000) * Math.PI * 2;
  const openTimestamp = new Date(issue.createdAt).valueOf();
  const fixedTimestamp = issue.closedAt ? new Date(issue.closedAt).valueOf() : null;
  const openCommitCount = Math.max(1, binaryCountByDate(commits, 'date', new Date(issue.createdAt)));
  const fixedCommitCount = issue.closedAt
    ? Math.max(openCommitCount, binaryCountByDate(commits, 'date', new Date(issue.closedAt)))
    : null;
  const normal = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
  const tangent = new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle));
  const impactRadius = towerRadiusAtCommit(Math.max(0, openCommitCount - 1), angle) + 0.3;
  const impact = normal.clone().multiplyScalar(impactRadius);
  impact.y = yForCommitCount(openCommitCount);
  const orientation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
  const seamOrigin = impact.clone().addScaledVector(normal, 0.1);
  const bend = ((seed >>> 9) % 100) / 100 - 0.5;
  const point = (across, rise) => seamOrigin.clone()
    .addScaledVector(tangent, across + bend * rise * 0.18)
    .addScaledVector(upAxis, rise);
  const seamSegments = [
    [point(-0.03, -0.08), point(0.13, 0.16)],
    [point(0.13, 0.16), point(-0.09, 0.38)],
    [point(-0.09, 0.38), point(0.18, 0.64)],
    [point(0.13, 0.16), point(0.38, 0.29)],
    [point(-0.09, 0.38), point(-0.34, 0.52)],
  ];
  return {
    issue,
    seed,
    impact,
    orientation,
    openTimestamp,
    fixedTimestamp,
    openCommitCount,
    fixedCommitCount,
    seamSegments,
    state: 'hidden',
  };
});

const damageRingMaterial = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  vertexColors: true,
  transparent: true,
  opacity: 0.58,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  toneMapped: false,
});
const damageRings = new THREE.InstancedMesh(
  new THREE.TorusGeometry(0.24, 0.045, 7, 24),
  damageRingMaterial,
  structuralRecords.length,
);
damageRings.name = 'bug-impact-rings';
damageRings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

const seamVerticesPerBug = 10;
const repairSeamPositions = new Float32Array(structuralRecords.length * seamVerticesPerBug * 3);
const repairSeamColors = new Float32Array(structuralRecords.length * seamVerticesPerBug * 3);
const goldSeamColor = new THREE.Color('#ffd166');
const mintSeamColor = new THREE.Color('#00ff9f');
for (let index = 0; index < structuralRecords.length; index += 1) {
  for (let vertex = 0; vertex < seamVerticesPerBug; vertex += 1) {
    (vertex % 3 === 0 ? mintSeamColor : goldSeamColor).toArray(repairSeamColors, (index * seamVerticesPerBug + vertex) * 3);
  }
}
const repairSeamGeometry = new THREE.BufferGeometry();
repairSeamGeometry.setAttribute('position', new THREE.BufferAttribute(repairSeamPositions, 3));
repairSeamGeometry.setAttribute('color', new THREE.BufferAttribute(repairSeamColors, 3));
const repairSeamMaterial = new THREE.LineBasicMaterial({
  vertexColors: true,
  transparent: true,
  opacity: 0.72,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  toneMapped: false,
});
const repairSeams = new THREE.LineSegments(repairSeamGeometry, repairSeamMaterial);
repairSeams.name = 'kintsugi-repair-seams';
bugDamageGroup.add(damageRings, repairSeams);
scene.add(bugDamageGroup);

const hiddenScale = new THREE.Vector3(0, 0, 0);
const ringScale = new THREE.Vector3();
const breachColor = new THREE.Color('#ff4f3d');
const repairedColor = new THREE.Color('#ffd166');

function updateBugDamageState(timelineTimestamp) {
  let ringStateChanged = false;
  let seamStateChanged = false;
  structuralRecords.forEach((record, index) => {
    const isPresent = timelineTimestamp >= record.openTimestamp;
    const isRepaired = isPresent && record.fixedTimestamp != null && timelineTimestamp >= record.fixedTimestamp;
    const nextState = !isPresent ? 'hidden' : isRepaired ? 'repaired' : 'open';
    if (nextState === record.state) return;
    record.state = nextState;
    ringStateChanged = true;
    seamStateChanged = true;
    const size = record.state === 'hidden' ? 0 : record.state === 'repaired' ? 0.72 : 1;
    ringScale.setScalar(size);
    matrix.compose(record.impact, record.orientation, size === 0 ? hiddenScale : ringScale);
    damageRings.setMatrixAt(index, matrix);
    damageRings.setColorAt(index, record.state === 'open' ? breachColor : repairedColor);
    const offset = index * seamVerticesPerBug * 3;
    if (record.state === 'repaired') {
      record.seamSegments.forEach(([start, end], segment) => {
        start.toArray(repairSeamPositions, offset + segment * 6);
        end.toArray(repairSeamPositions, offset + segment * 6 + 3);
      });
    } else {
      for (let vertex = 0; vertex < seamVerticesPerBug; vertex += 1) record.impact.toArray(repairSeamPositions, offset + vertex * 3);
    }
  });
  if (ringStateChanged) {
    damageRings.instanceMatrix.needsUpdate = true;
    if (damageRings.instanceColor) damageRings.instanceColor.needsUpdate = true;
  }
  if (seamStateChanged) repairSeamGeometry.attributes.position.needsUpdate = true;
}

const structuralEffects = new THREE.Group();
structuralEffects.name = 'structural-events';
scene.add(structuralEffects);
const activeStructuralEffects = [];
const structuralEvents = structuralRecords.flatMap((record) => [
  ...(record.openTimestamp >= periodStartTimestamp && record.openTimestamp <= periodEndTimestamp
    ? [{ kind: 'rupture', timestamp: record.openTimestamp, record }]
    : []),
  ...(record.fixedTimestamp != null && record.fixedTimestamp >= periodStartTimestamp && record.fixedTimestamp <= periodEndTimestamp
    ? [{ kind: 'repair', timestamp: record.fixedTimestamp, record }]
    : []),
]).sort((first, second) => first.timestamp - second.timestamp || (first.kind === 'rupture' ? -1 : 1));
const playbackActionStartDate = playbackActivityStart(meta.start, meta.end, [
  commits[0]?.date,
  structuralEvents[0]?.timestamp,
]);
const playbackActionStartProgress = playbackProgressForDate(meta.start, meta.end, playbackActionStartDate);
let cameraShake = 0;
let systemEventHideAt = -1;
let lastSystemEventAt = -10;
let lastStructuralSpawnAt = -10;

function showSystemEvent(event) {
  if (elapsed - lastSystemEventAt < 0.22 && event.kind === 'rupture') return;
  const isRepair = event.kind === 'repair';
  systemEvent.dataset.kind = event.kind;
  systemEventKicker.textContent = `${isRepair ? 'fix' : 'issue'} #${event.record.issue.number} / ${isRepair ? 'repair protocol' : 'structural breach'}`;
  systemEventTitle.textContent = isRepair ? 'Kintsugi seal complete' : 'Impact registered';
  systemEventDetail.textContent = event.record.issue.title;
  systemEvent.classList.add('is-visible');
  systemEventHideAt = elapsed + (isRepair ? 2.8 : 2.2);
  lastSystemEventAt = elapsed;
}

function disposeStructuralEffect(effect) {
  structuralEffects.remove(effect.group);
  effect.points.geometry.dispose();
  effect.points.material.dispose();
  effect.ring.geometry.dispose();
  effect.ring.material.dispose();
  effect.flash.geometry.dispose();
  effect.flash.material.dispose();
}

function clearStructuralEffects() {
  while (activeStructuralEffects.length) disposeStructuralEffect(activeStructuralEffects.pop());
  systemEvent.classList.remove('is-visible');
  cameraShake = 0;
}

function spawnStructuralEffect(event) {
  synthScore.triggerStructuralEvent(event.kind);
  if (reducedMotion) {
    showSystemEvent(event);
    return;
  }
  if (mobileRenderer && elapsed - lastStructuralSpawnAt < 0.2) {
    showSystemEvent(event);
    return;
  }
  lastStructuralSpawnAt = elapsed;
  const effectLimit = mobileRenderer ? 4 : 14;
  while (activeStructuralEffects.length >= effectLimit) disposeStructuralEffect(activeStructuralEffects.shift());
  const isRepair = event.kind === 'repair';
  const particleCount = mobileRenderer ? (isRepair ? 24 : 20) : (isRepair ? 54 : 42);
  const particlePositions = new Float32Array(particleCount * 3);
  const particleColors = new Float32Array(particleCount * 3);
  const particleMotion = new Float32Array(particleCount * 3);
  const palette = isRepair
    ? [new THREE.Color('#ffd166'), new THREE.Color('#00ff9f'), new THREE.Color('#f5f0e1')]
    : [new THREE.Color('#ff4f3d'), new THREE.Color('#ff9f43'), new THREE.Color('#f5f0e1')];
  let captureRandomState = (event.record.seed ^ (isRepair ? 0x9e3779b9 : 0x85ebca6b)) >>> 0;
  const effectRandom = () => {
    if (!isVideoCapture) return Math.random();
    captureRandomState += 0x6d2b79f5;
    let value = captureRandomState;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  for (let index = 0; index < particleCount; index += 1) {
    const angle = effectRandom() * Math.PI * 2;
    const radius = isRepair ? 0.8 + effectRandom() * 2 : 0.4 + effectRandom() * 2.2;
    particleMotion[index * 3] = angle;
    particleMotion[index * 3 + 1] = radius;
    particleMotion[index * 3 + 2] = 0.35 + effectRandom() * 1.15;
    if (isRepair) {
      particlePositions[index * 3] = Math.cos(angle) * radius;
      particlePositions[index * 3 + 1] = Math.sin(angle) * radius * 0.72;
      particlePositions[index * 3 + 2] = 0.2 + effectRandom() * 0.5;
    }
    palette[index % palette.length].toArray(particleColors, index * 3);
  }
  const particleGeometry = new THREE.BufferGeometry();
  particleGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
  particleGeometry.setAttribute('color', new THREE.BufferAttribute(particleColors, 3));
  const points = new THREE.Points(particleGeometry, new THREE.PointsMaterial({
    size: isRepair ? 0.14 : 0.19,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  }));
  const effectColor = isRepair ? 0xffd166 : 0xff4f3d;
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.42, isRepair ? 0.035 : 0.065, mobileRenderer ? 5 : 7, mobileRenderer ? 20 : 40),
    new THREE.MeshBasicMaterial({ color: effectColor, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  );
  const flash = new THREE.Mesh(
    new THREE.SphereGeometry(isRepair ? 0.25 : 0.34, mobileRenderer ? 8 : 12, mobileRenderer ? 5 : 8),
    new THREE.MeshBasicMaterial({ color: isRepair ? 0x00ff9f : 0xffd0a1, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  );
  const light = mobileRenderer ? null : new THREE.PointLight(effectColor, isRepair ? 42 : 88, 13, 2);
  if (light) light.position.z = 0.65;
  const group = new THREE.Group();
  group.position.copy(event.record.impact);
  group.quaternion.copy(event.record.orientation);
  group.add(points, ring, flash);
  if (light) group.add(light);
  structuralEffects.add(group);
  activeStructuralEffects.push({
    kind: event.kind,
    age: 0,
    duration: mobileRenderer ? (isRepair ? 1.25 : 0.95) : (isRepair ? 1.75 : 1.25),
    group,
    points,
    ring,
    flash,
    light,
    particleMotion,
  });
  cameraShake = Math.max(cameraShake, isRepair ? 0.045 : 0.3);
  showSystemEvent(event);
}

function triggerStructuralEvents(previousTimestamp, nextTimestamp) {
  structuralEvents.forEach((event) => {
    if (event.timestamp > previousTimestamp && event.timestamp <= nextTimestamp) spawnStructuralEffect(event);
  });
}

function updateStructuralEffects(delta) {
  for (let effectIndex = activeStructuralEffects.length - 1; effectIndex >= 0; effectIndex -= 1) {
    const effect = activeStructuralEffects[effectIndex];
    effect.age += delta;
    const progress = THREE.MathUtils.clamp(effect.age / effect.duration, 0, 1);
    const positions = effect.points.geometry.attributes.position.array;
    const repair = effect.kind === 'repair';
    for (let index = 0; index < positions.length / 3; index += 1) {
      const angle = effect.particleMotion[index * 3];
      const radius = effect.particleMotion[index * 3 + 1];
      const lift = effect.particleMotion[index * 3 + 2];
      if (repair) {
        const remaining = (1 - progress) ** 1.45;
        const spiralAngle = angle + progress * Math.PI * (2.4 + lift);
        positions[index * 3] = Math.cos(spiralAngle) * radius * remaining;
        positions[index * 3 + 1] = Math.sin(spiralAngle) * radius * remaining * 0.72;
        positions[index * 3 + 2] = 0.12 + radius * remaining * 0.22;
      } else {
        positions[index * 3] = Math.cos(angle) * radius * effect.age;
        positions[index * 3 + 1] = Math.sin(angle) * radius * effect.age + lift * effect.age - 1.7 * effect.age * effect.age;
        positions[index * 3 + 2] = (1.2 + lift * 1.8) * effect.age;
      }
    }
    effect.points.geometry.attributes.position.needsUpdate = true;
    effect.points.material.opacity = repair ? Math.sin(progress * Math.PI) * 0.95 : (1 - progress) ** 1.7;
    const ringSize = repair ? 2.8 - progress * 2.35 : 0.35 + progress * 5.2;
    effect.ring.scale.setScalar(ringSize);
    effect.ring.material.opacity = repair ? Math.sin(progress * Math.PI) * 0.72 : (1 - progress) ** 1.3;
    const flashPulse = repair ? Math.sin(progress * Math.PI) : 1 - progress;
    effect.flash.scale.setScalar(repair ? 0.35 + progress * 1.8 : 0.6 + progress * 4.5);
    effect.flash.material.opacity = flashPulse * (repair ? 0.72 : 0.9);
    if (effect.light) effect.light.intensity = flashPulse * (repair ? 44 : 92);
    if (progress >= 1) {
      disposeStructuralEffect(effect);
      activeStructuralEffects.splice(effectIndex, 1);
    }
  }
  cameraShake *= Math.exp(-delta * 8.5);
  if (systemEvent.classList.contains('is-visible') && elapsed >= systemEventHideAt) systemEvent.classList.remove('is-visible');
}

function animateBugDamage() {
  if (!playing || reducedMotion || mobileRenderer) return;
  structuralRecords.forEach((record, index) => {
    if (record.state !== 'open') return;
    const pulse = 1 + Math.sin(elapsed * 5.2 + record.seed) * 0.16;
    ringScale.setScalar(pulse);
    matrix.compose(record.impact, record.orientation, ringScale);
    damageRings.setMatrixAt(index, matrix);
  });
  damageRings.instanceMatrix.needsUpdate = true;
}

const crewGroup = new THREE.Group();
crewGroup.name = 'crew-platforms';
contributors.slice(0, 18).forEach((person, index) => {
  const angle = (index / 18) * Math.PI * 2;
  const height = 0.4 + Math.min(Math.log10(person.commits + 1) * 1.55, 5.1);
  const material = new THREE.MeshPhysicalMaterial({
    color: colorForContributor(person),
    emissive: colorForContributor(person),
    emissiveIntensity: 0.35,
    metalness: 0.68,
    roughness: 0.3,
  });
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.34, height, 6), material);
  pillar.position.set(Math.cos(angle) * 13.1, height * 0.5, Math.sin(angle) * 13.1);
  crewGroup.add(pillar);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 8), new THREE.MeshBasicMaterial({ color: material.color }));
  beacon.position.set(Math.cos(angle) * 13.1, height + 0.18, Math.sin(angle) * 13.1);
  crewGroup.add(beacon);
});
crewGroup.visible = false;
scene.add(crewGroup);

const crane = new THREE.Group();
const craneY = towerHeight + 1.55;
const craneMaterial = new THREE.MeshPhysicalMaterial({ color: 0xd3b15b, emissive: 0x6d531c, emissiveIntensity: 0.38, metalness: 0.82, roughness: 0.34 });
const mast = new THREE.Mesh(new THREE.BoxGeometry(0.28, 7.4, 0.28), craneMaterial);
mast.position.set(-4.4, 3.7, 0);
crane.add(mast);
const jib = new THREE.Mesh(new THREE.BoxGeometry(14.5, 0.22, 0.22), craneMaterial);
jib.position.set(1.9, 7.1, 0);
crane.add(jib);
const counterweight = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.8, 0.9), craneMaterial);
counterweight.position.set(-4.4, 6.55, 0);
crane.add(counterweight);
const hookGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(4.2, 7, 0), new THREE.Vector3(4.2, 2.1, 0)]);
const hookLine = new THREE.Line(hookGeometry, new THREE.LineBasicMaterial({ color: 0xf5f0e1, transparent: true, opacity: 0.48 }));
crane.add(hookLine);
const hookBlock = new THREE.Mesh(
  new THREE.BoxGeometry(0.56, 0.38, 0.48),
  new THREE.MeshPhysicalMaterial({ color: 0x00ff9f, emissive: 0x00ff9f, emissiveIntensity: 1.1, metalness: 0.65, roughness: 0.25 }),
);
hookBlock.position.set(4.2, 1.88, 0);
crane.add(hookBlock);
crane.position.y = craneY;
scene.add(crane);

const dustCount = mobileRenderer ? 150 : 520;
const dustPositions = new Float32Array(dustCount * 3);
for (let index = 0; index < dustCount; index += 1) {
  const angle = Math.random() * Math.PI * 2;
  const radius = 6.5 + Math.random() * 8;
  dustPositions[index * 3] = Math.cos(angle) * radius;
  dustPositions[index * 3 + 1] = Math.random() * towerHeight;
  dustPositions[index * 3 + 2] = Math.sin(angle) * radius;
}
const dustGeometry = new THREE.BufferGeometry();
dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
const dust = new THREE.Points(dustGeometry, new THREE.PointsMaterial({ color: 0x00ff9f, size: 0.055, transparent: true, opacity: 0.36, blending: THREE.AdditiveBlending, depthWrite: false }));
scene.add(dust);

let visibleCommitCount = commits.length;
let visibleBranchCount = branchRecords.length;
let visibleIssueCount = issues.length;
let playing = false;
let playbackStartedAt = Date.now();
let playbackStartProgress = 1;
let currentTimelineTimestamp = periodEndTimestamp;
let currentBuildTopY = towerHeight;
let lastAnimationTimestamp = null;
const crewCommitCounts = createCrewCommitCounts(contributors, commits);
const captureCrewRankMotion = new Map();

function updateCrewLeaderboard({ animate = true, resetCaptureMotion = false } = {}) {
  const list = detailContent.querySelector('[data-crew-leaderboard]');
  if (!list) return;
  const ranked = rankCrewContributors(contributors, crewCommitCounts);
  const rows = new Map(
    [...list.querySelectorAll('[data-contributor]')].map((row) => [row.dataset.contributor, row]),
  );
  const previousOrder = [...rows.keys()];
  const nextOrder = ranked.map((person) => person.id);
  const leadingCount = ranked.length ? crewCommitCounts.get(ranked[0].id) || 0 : 0;
  const orderChanged = previousOrder.some((id, index) => id !== nextOrder[index]);
  const previousPositions = orderChanged && animate && !reducedMotion
    ? new Map([...rows.values()].map((row) => [row.dataset.contributor, row.getBoundingClientRect().top]))
    : null;

  ranked.forEach((person, index) => {
    const row = rows.get(person.id);
    if (!row) return;
    const count = crewCommitCounts.get(person.id) || 0;
    row.querySelector('.person-rank').textContent = String(index + 1).padStart(2, '0');
    row.querySelector('[data-contributor-count]').textContent = number.format(count);
    row.style.setProperty('--commit-share', crewCommitShare(count, leadingCount));
    row.classList.toggle('is-inactive', count === 0);
    if (orderChanged) list.append(row);
  });

  const activeCount = ranked.filter((person) => (crewCommitCounts.get(person.id) || 0) > 0).length;
  detailContent.querySelector('[data-crew-active-count]').textContent = number.format(activeCount);
  detailContent.querySelector('[data-crew-commit-count]').textContent = number.format(visibleCommitCount);

  if (isVideoCapture) {
    stepCrewRankMotion(captureCrewRankMotion, nextOrder, { reset: resetCaptureMotion });
    const rowPitch = rows.values().next().value?.offsetHeight || 44;
    ranked.forEach((person, index) => {
      const row = rows.get(person.id);
      const position = captureCrewRankMotion.get(person.id)?.position ?? index;
      const offset = (position - index) * rowPitch;
      if (Math.abs(offset) < 0.01) row.style.removeProperty('transform');
      else row.style.transform = `translateY(${offset}px)`;
    });
    return;
  }

  if (!previousPositions) return;
  const movingRows = [];
  ranked.forEach((person) => {
    const row = rows.get(person.id);
    const offset = previousPositions.get(person.id) - row.getBoundingClientRect().top;
    if (Math.abs(offset) < 1) return;
    row.classList.add('is-reordering');
    row.style.translate = `0 ${offset}px`;
    movingRows.push(row);
  });
  if (!movingRows.length) return;
  window.requestAnimationFrame(() => {
    movingRows.forEach((row) => {
      row.classList.remove('is-reordering');
      row.style.translate = '0 0';
      const finishReorder = (event) => {
        if (event.propertyName !== 'translate') return;
        row.removeEventListener('transitionend', finishReorder);
        row.style.removeProperty('translate');
      };
      row.addEventListener('transitionend', finishReorder);
    });
  });
}

function setTimeline(nextCount, timelineDateOverride = null) {
  const previousCommitCount = visibleCommitCount;
  const previousTimelineTimestamp = currentTimelineTimestamp;
  const resolvedCommitCount = THREE.MathUtils.clamp(Math.round(nextCount), 0, commits.length);
  if (!playing && resolvedCommitCount !== previousCommitCount) clearStructuralEffects();
  moveCrewCommitCounts(crewCommitCounts, commits, previousCommitCount, resolvedCommitCount);
  visibleCommitCount = resolvedCommitCount;
  synthScore.setProgress(commits.length ? visibleCommitCount / commits.length : 0);
  commitMesh.count = visibleCommitCount;
  commitGlowGeometry.setDrawRange(0, visibleCommitCount);
  scrubber.value = String(visibleCommitCount);
  scrubber.style.setProperty('--progress', `${(visibleCommitCount / commits.length) * 100}%`);
  const currentDate = timelineDateOverride == null
    ? visibleCommitCount >= commits.length
      ? new Date(meta.end)
      : visibleCommitCount > 0
        ? new Date(commits[visibleCommitCount - 1].date)
        : new Date(meta.start)
    : new Date(timelineDateOverride);
  currentTimelineTimestamp = THREE.MathUtils.clamp(
    currentDate.valueOf(),
    periodStartTimestamp,
    periodEndTimestamp,
  );
  visibleBranchCount = binaryCountByDate(branchRecords, 'date', currentDate);
  visibleIssueCount = binaryCountByDate(issues, 'createdAt', currentDate);
  branchTips.count = visibleBranchCount;
  branchShoulders.count = visibleBranchCount;
  branchPathGeometry.setDrawRange(0, visibleBranchCount * branchPathSegments * 2);
  issueMesh.count = visibleIssueCount;
  issueBeams.geometry.setDrawRange(0, visibleIssueCount * 2);
  updateBugDamageState(currentTimelineTimestamp);
  if (playing && currentTimelineTimestamp > previousTimelineTimestamp) {
    triggerStructuralEvents(previousTimelineTimestamp, currentTimelineTimestamp);
  }
  timelineDate.textContent = dateLong.format(currentDate);
  timelinePhase.textContent = visibleCommitCount >= commits.length
    ? `tower complete / ${number.format(meta.commits)} commits high`
    : visibleCommitCount === 0
      ? 'foundation / 0 commits'
      : `${number.format(visibleCommitCount)} commits high`;
  visibleCommits.textContent = number.format(visibleCommitCount);
  visibleBranches.textContent = number.format(visibleBranchCount);
  visibleIssues.textContent = number.format(visibleIssueCount);
  if (resolvedCommitCount !== previousCommitCount && currentMode === 'crews' && !selectedObject) {
    updateCrewLeaderboard({
      animate: !isVideoCapture,
      resetCaptureMotion: isVideoCapture && resolvedCommitCount < previousCommitCount,
    });
  }
  const topPosition = visibleCommitCount > 0 ? commitPositions[visibleCommitCount - 1] : new THREE.Vector3(0, 1, 0);
  currentBuildTopY = topPosition.y;
  crane.position.y = Math.max(2.8, topPosition.y - 5.5);
  coreCap.position.y = Math.max(1.5, topPosition.y + 0.58);
  if (isVideoCapture && resolvedCommitCount !== previousCommitCount) {
    const desiredDistance = 43 + currentBuildTopY * 0.88;
    if (visibleCommitCount === 0) {
      const viewDirection = camera.position.clone().sub(controls.target).normalize();
      focusTarget.set(0, 4.5, 0);
      controls.target.copy(focusTarget);
      camera.position.copy(controls.target).addScaledVector(viewDirection, desiredDistance);
    } else {
      if (visibleCommitCount < commits.length) focusTarget.set(0, Math.max(4.5, topPosition.y * 0.7), 0);
      else if (!selectedObject) focusTarget.copy(defaultFocus);
      const captureDelta = 1 / 40;
      controls.target.lerp(focusTarget, 1 - Math.exp(-captureDelta * 3.7));
      const cameraOffset = camera.position.clone().sub(controls.target);
      cameraOffset.setLength(THREE.MathUtils.lerp(cameraOffset.length(), desiredDistance, 1 - Math.exp(-captureDelta * 1.9)));
      camera.position.copy(controls.target).add(cameraOffset);
    }
    controls.update();
  } else {
    if (playing && visibleCommitCount < commits.length) focusTarget.set(0, Math.max(4.5, topPosition.y * 0.7), 0);
    if (visibleCommitCount >= commits.length && !selectedObject) focusTarget.copy(defaultFocus);
  }
}

function recolorCommits() {
  for (let index = 0; index < commits.length; index += 1) {
    const key = contributorKey(commits[index]);
    let color = commitColors[index];
    if (selectedContributor) {
      color = key === selectedContributor
        ? commitColors[index].clone().multiplyScalar(1.28)
        : new THREE.Color('#10211e');
    }
    commitMesh.setColorAt(index, color);
    color.toArray(commitGlowGeometry.attributes.color.array, index * 3);
  }
  commitMesh.instanceColor.needsUpdate = true;
  commitGlowGeometry.attributes.color.needsUpdate = true;
}

let selectedCityIndex = 0;
let desiredCityDistance = 78;
const cityTravelKeys = new Set();

function updateCityNavigator(index) {
  const landmark = cityLandmarks[index];
  if (!landmark) return;
  const { entry } = landmark;
  cityRepository.textContent = entry.repo;
  cityPeriod.textContent = `through ${dateShort.format(new Date(entry.end || meta.end))}`;
  cityCommits.textContent = number.format(entry.commits);
  cityBranches.textContent = number.format(entry.branches);
  cityContributors.textContent = number.format(entry.contributors);
  cityEnterLabel.textContent = entry.current ? 'Return to tower' : 'Enter tower';
  cityEnterButton.setAttribute('aria-label', `${entry.current ? 'Return to' : 'Enter'} ${entry.repo} tower`);
}

function focusCityLandmark(nextIndex, { immediate = false } = {}) {
  const index = THREE.MathUtils.euclideanModulo(nextIndex, cityLandmarks.length);
  const landmark = cityLandmarks[index];
  selectedCityIndex = index;
  citySelectionRing.visible = true;
  citySelectionRing.position.set(landmark.position.x, 0.3, landmark.position.z);
  citySelectionRing.scale.setScalar(Math.max(1, (landmark.entry.radius + 1.4) / 5.8));
  citySelectionRing.material.color.set(landmark.entry.current ? '#00ff9f' : '#ff9f43');
  focusTarget.set(landmark.position.x, Math.max(4.5, landmark.height * 0.42), landmark.position.z);
  desiredCityDistance = THREE.MathUtils.clamp(42 + landmark.height * 0.72, 56, 92);
  updateCityNavigator(index);
  if (immediate) {
    const viewDirection = camera.position.clone().sub(controls.target).normalize();
    controls.target.copy(focusTarget);
    camera.position.copy(focusTarget).addScaledVector(viewDirection, desiredCityDistance);
    controls.update();
  }
}

async function enterCityLandmark(index) {
  const entry = cityLandmarks[index]?.entry;
  if (!entry) return;
  if (entry.current) {
    setMode('crews');
    return;
  }
  try {
    await transitionToRepository(entry.repo);
  } catch (error) {
    dismissRepositoryTransition();
    hoverTitle.textContent = `Could not enter ${entry.repo}`;
    hoverMeta.textContent = error.message || 'Repository unavailable';
    hoverCard.classList.add('is-visible');
  }
}

function enterSelectedCityLandmark() {
  return enterCityLandmark(selectedCityIndex);
}

function setMode(mode) {
  const wasCity = currentMode === 'city';
  const isCity = mode === 'city';
  currentMode = mode;
  detailPanel.dataset.mode = mode;
  selectedContributor = null;
  selectedObject = null;
  branchGroup.visible = mode === 'branches';
  issueGroup.visible = mode === 'issues';
  crewGroup.visible = mode === 'crews';
  setCityPresentation(isCity);
  scene.fog.density = isCity ? 0.0052 : 0.0125;
  cityNavigator.setAttribute('aria-hidden', String(!isCity));
  experience.classList.toggle('is-city-mode', isCity);
  controls.enablePan = isCity;
  controls.autoRotate = !isCity && !reducedMotion && !mobileRenderer && !isVideoCapture;
  controls.minDistance = isCity ? 18 : 22;
  controls.maxDistance = isCity ? 180 : 120;
  commitAxis.visible = !isCity;
  branchShoulders.visible = !isCity;
  bugDamageGroup.visible = !isCity;
  structuralEffects.visible = !isCity;
  crane.visible = !isCity;
  dust.visible = !isCity;
  branchShoulderMaterial.opacity = mode === 'branches' ? 0.92 : 0.48;
  damageRingMaterial.opacity = mode === 'issues' ? 0.88 : 0.5;
  repairSeamMaterial.opacity = mode === 'issues' ? 0.96 : 0.58;
  const fadeTower = mode === 'branches' || mode === 'issues';
  commitMaterial.transparent = fadeTower;
  commitMaterial.opacity = fadeTower ? 0.34 : 1;
  commitMaterial.depthWrite = !fadeTower;
  commitMaterial.needsUpdate = true;
  commitGlowMaterial.opacity = fadeTower ? 0.22 : 0.82;
  document.querySelectorAll('[data-mode]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  });
  recolorCommits();
  showOverview();
  if (mode === 'crews') updateCrewLeaderboard({ animate: false });
  if (isCity) {
    setPlaying(false);
    setTimeline(commits.length);
    focusCityLandmark(selectedCityIndex);
    if (!wasCity) {
      focusTarget.set(0, Math.max(13, towerHeight * 0.3), 0);
      desiredCityDistance = 174;
      controls.target.copy(focusTarget);
      camera.position.copy(focusTarget).addScaledVector(new THREE.Vector3(0.58, 0.88, 0.68).normalize(), desiredCityDistance);
      controls.update();
    }
  } else if (wasCity) {
    cityTravelKeys.clear();
    focusTarget.copy(defaultFocus);
  }
}

document.querySelectorAll('[data-mode]').forEach((button) => {
  button.addEventListener('click', () => setMode(button.dataset.mode));
});

document.querySelector('#city-previous').addEventListener('click', () => focusCityLandmark(selectedCityIndex - 1));
document.querySelector('#city-next').addEventListener('click', () => focusCityLandmark(selectedCityIndex + 1));
cityEnterButton.addEventListener('click', enterSelectedCityLandmark);

function setPlaying(nextPlaying) {
  const wasPlaying = playing;
  playing = nextPlaying;
  if (playing && !wasPlaying) {
    playbackStartedAt = Date.now();
    playbackStartProgress = playbackProgressForDate(meta.start, meta.end, currentTimelineTimestamp);
    lastAnimationTimestamp = null;
    if (!isFrameCapture) startPlaybackWorker();
  } else if (!playing && wasPlaying) {
    stopPlaybackWorker();
  }
  playButton.setAttribute('aria-pressed', String(playing));
  playButton.setAttribute('aria-label', playing ? 'Pause the year' : 'Play the year');
  synthScore.setProgress(playbackProgressForDate(meta.start, meta.end, currentTimelineTimestamp));
  synthScore.setPlaying(soundEnabled && playing);
  updateSoundControl();
}

function resetTimelineForPlayback() {
  setTimeline(0, playbackActionStartDate);
}

playButton.addEventListener('click', () => {
  if (!playing && visibleCommitCount >= commits.length) resetTimelineForPlayback();
  setPlaying(!playing);
});

soundButton.addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  synthScore.setEnabled(soundEnabled);
  synthScore.setPlaying(soundEnabled && playing);
  updateSoundControl();
});

scrubber.addEventListener('input', () => {
  setPlaying(false);
  setTimeline(Number(scrubber.value));
});

const enterButton = document.querySelector('#enter');
const introRepositoryForm = document.querySelector('#intro-repository-form');
const introRepositoryInput = introRepositoryForm.querySelector('[data-repository-field]');
wireRepositoryForm(introRepositoryForm, {
  currentRepository: meta.repo,
  watchButton: enterButton,
});

enterButton.addEventListener('click', () => {
  experience.classList.add('is-entered');
  resetTimelineForPlayback();
  setPlaying(true);
});

repositoryDirectoryPanel.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-directory-repository]');
  if (!button || !repositoryDirectoryPanel.contains(button)) return;
  const repo = button.dataset.directoryRepository;
  if (repo.toLowerCase() === meta.repo.toLowerCase()) {
    enterButton.click();
    return;
  }

  const directoryButtons = [...repositoryDirectoryPanel.querySelectorAll('[data-directory-repository]')];
  directoryButtons.forEach((entry) => { entry.disabled = true; });
  button.setAttribute('aria-busy', 'true');
  repositoryDirectoryStatus.textContent = `Opening ${repo}…`;
  try {
    await transitionToRepository(repo);
  } catch (error) {
    dismissRepositoryTransition();
    directoryButtons.forEach((entry) => { entry.disabled = false; });
    button.removeAttribute('aria-busy');
    repositoryDirectoryStatus.textContent = error.message || `${repo} could not be opened.`;
  }
});

document.querySelector('#explore-city').addEventListener('click', () => {
  experience.classList.add('is-entered');
  setMode('city');
});

document.querySelector('#change-repository').addEventListener('click', () => {
  setPlaying(false);
  showOverview();
  experience.classList.remove('is-entered');
  window.setTimeout(() => {
    introRepositoryInput.focus({ preventScroll: true });
    introRepositoryInput.select();
  }, reducedMotion ? 0 : 140);
});

const shareResetTimers = new WeakMap();

function setShareButtonState(button, label, copied = false) {
  window.clearTimeout(shareResetTimers.get(button));
  button.classList.toggle('is-copied', copied);
  button.querySelector('.share-button-label').textContent = label;
  button.setAttribute('aria-label', `${label}: ${meta.repo}`);
  if (!copied) return;
  const resetTimer = window.setTimeout(() => {
    button.classList.remove('is-copied');
    button.querySelector('.share-button-label').textContent = button.dataset.shareLabel;
    button.setAttribute('aria-label', button.dataset.shareAriaLabel);
    shareResetTimers.delete(button);
  }, 2200);
  shareResetTimers.set(button, resetTimer);
}

async function copyShareUrl(url) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(url);
    return;
  }
  const temporary = document.createElement('textarea');
  temporary.value = url;
  temporary.setAttribute('readonly', '');
  temporary.style.position = 'fixed';
  temporary.style.opacity = '0';
  document.body.append(temporary);
  temporary.select();
  const copied = document.execCommand('copy');
  temporary.remove();
  if (!copied) throw new Error('Copy was unavailable.');
}

document.querySelectorAll('[data-share-url]').forEach((button) => {
  button.addEventListener('click', async () => {
    const url = button.dataset.shareUrl;
    button.setAttribute('aria-busy', 'true');
    try {
      if (coarseMobilePointer && navigator.share) {
        await navigator.share({
          title: `${repositoryName} — One Year in Code`,
          text: `Explore ${meta.repo} as a 3D tower of commits, branches, issues, and contributors.`,
          url,
        });
        setShareButtonState(button, 'Shared', true);
      } else {
        await copyShareUrl(url);
        setShareButtonState(button, 'Link copied', true);
      }
    } catch (error) {
      if (error?.name !== 'AbortError') {
        try {
          await copyShareUrl(url);
          setShareButtonState(button, 'Link copied', true);
        } catch {
          setShareButtonState(button, 'Share unavailable');
        }
      }
    } finally {
      button.removeAttribute('aria-busy');
    }
  });
});

document.querySelector('#close-detail').addEventListener('click', showOverview);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2(2, 2);
let pointerX = 0;
let pointerY = 0;
let pointerDirty = false;
let hovered = null;

function updatePointer(event) {
  const bounds = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
  pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
  pointerX = event.clientX;
  pointerY = event.clientY;
  pointerDirty = true;
}

if (hoverCapable) {
  canvas.addEventListener('pointermove', (event) => {
    updatePointer(event);
    updateHover();
  });
  canvas.addEventListener('pointerleave', () => {
    pointer.set(2, 2);
    hovered = null;
    setBackdropHighlight(-1);
    hoverCard.classList.remove('is-visible');
    canvas.style.cursor = 'grab';
  });
}

function findIntersection() {
  raycaster.setFromCamera(pointer, camera);
  if (currentMode === 'city') {
    const hit = raycaster.intersectObjects(cityTowerHitTargets, false)[0];
    if (hit) return { type: 'city', index: hit.object.userData.cityIndex };
    return null;
  }
  if (currentMode === 'issues') {
    const hit = raycaster.intersectObject(issueMesh, false)[0];
    if (hit && hit.instanceId < visibleIssueCount) return { type: 'issue', index: hit.instanceId };
  }
  if (currentMode === 'branches') {
    const hit = raycaster.intersectObject(branchTips, false)[0];
    if (hit && hit.instanceId < visibleBranchCount) return { type: 'branch', index: hit.instanceId };
  }
  const hit = raycaster.intersectObject(commitMesh, false)[0];
  if (hit && hit.instanceId < visibleCommitCount) return { type: 'commit', index: hit.instanceId };
  const backdropHit = raycaster.intersectObjects(cityTowerHitTargets.filter((target) => target.visible), false)[0];
  if (backdropHit) return { type: 'city-link', index: backdropHit.object.userData.cityIndex };
  return null;
}

function updateHover() {
  if (!pointerDirty) return;
  pointerDirty = false;
  const next = findIntersection();
  hovered = next;
  setBackdropHighlight(next?.type === 'city-link' ? next.index : -1);
  if (!next) {
    hoverCard.classList.remove('is-visible');
    canvas.style.cursor = 'grab';
    return;
  }
  if (next.type === 'commit') {
    const commit = commits[next.index];
    hoverTitle.textContent = commit.subject;
    hoverMeta.textContent = `commit ${number.format(next.index + 1)} · ${commit.author} · ${commit.shortHash}`;
  } else if (next.type === 'issue') {
    const issue = issues[next.index];
    hoverTitle.textContent = issue.title;
    hoverMeta.textContent = `issue #${issue.number} · ${issue.state}`;
  } else if (next.type === 'branch') {
    const branch = branchRecords[next.index];
    hoverTitle.textContent = branch.name;
    hoverMeta.textContent = `${branch.scope} branch · ${branch.shortHash}`;
  } else {
    const entry = cityLandmarks[next.index].entry;
    hoverTitle.textContent = entry.repo;
    hoverMeta.textContent = `${number.format(entry.commits)} commits · ${number.format(entry.contributors)} crews · tap to visit`;
  }
  hoverCard.style.left = `${Math.min(pointerX, window.innerWidth - 320)}px`;
  hoverCard.style.top = `${Math.min(pointerY, window.innerHeight - 90)}px`;
  hoverCard.classList.add('is-visible');
  canvas.style.cursor = 'pointer';
}

canvas.addEventListener('click', (event) => {
  updatePointer(event);
  const hit = findIntersection();
  if (!hit) return;
  setPlaying(false);
  if (hit.type === 'city') {
    focusCityLandmark(hit.index);
  } else if (hit.type === 'city-link') {
    enterCityLandmark(hit.index);
  } else if (hit.type === 'commit') {
    showCommit(commits[hit.index], hit.index);
    focusTarget.copy(commitPositions[hit.index]);
  } else if (hit.type === 'issue') {
    showIssue(issues[hit.index], hit.index);
    focusTarget.copy(issuePositions[hit.index]).multiply(new THREE.Vector3(0.65, 1, 0.65));
  } else {
    showBranch(branchRecords[hit.index], hit.index);
    focusTarget.copy(branchPositions[hit.index]).multiply(new THREE.Vector3(0.62, 1, 0.62));
  }
});

canvas.addEventListener('dblclick', () => {
  if (currentMode === 'city') {
    enterSelectedCityLandmark();
    return;
  }
  focusTarget.copy(defaultFocus);
  showOverview();
});

window.addEventListener('keydown', (event) => {
  const target = event.target;
  const isTyping = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
  const key = event.key.toLowerCase();
  if (!isTyping && currentMode === 'city' && ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'].includes(key)) {
    event.preventDefault();
    cityTravelKeys.add(key);
    citySelectionRing.visible = false;
  }
  if (!isTyping && event.code === 'Space' && experience.classList.contains('is-entered') && currentMode !== 'city') {
    event.preventDefault();
    if (!playing && visibleCommitCount >= commits.length) resetTimelineForPlayback();
    setPlaying(!playing);
  }
  if (event.code === 'Escape') {
    if (currentMode === 'city') focusCityLandmark(0);
    else {
      focusTarget.copy(defaultFocus);
      showOverview();
    }
  }
  if (!isTyping && event.key >= '1' && event.key <= '5') {
    const modes = ['build', 'branches', 'issues', 'crews', 'city'];
    setMode(modes[Number(event.key) - 1]);
  }
});

window.addEventListener('keyup', (event) => {
  cityTravelKeys.delete(event.key.toLowerCase());
});

let elapsed = 0;
const cameraJolt = new THREE.Vector3();
const cityForward = new THREE.Vector3();
const cityRight = new THREE.Vector3();
const cityMovement = new THREE.Vector3();
let lastRenderedTimestamp = -Infinity;
let lastAnimationFrameHeartbeat = Date.now();
let playbackWorker = null;

function stopPlaybackWorker() {
  if (!playbackWorker) return;
  playbackWorker.terminate();
  playbackWorker = null;
}

function startPlaybackWorker() {
  if (playbackWorker || typeof Worker === 'undefined') return;
  const workerSource = `setInterval(() => postMessage(0), ${1000 / 30});`;
  const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
  playbackWorker = new Worker(workerUrl);
  URL.revokeObjectURL(workerUrl);
  playbackWorker.addEventListener('message', () => {
    if (!playing || Date.now() - lastAnimationFrameHeartbeat < 120) return;
    renderAnimationStep();
  });
}

function updateCityTravel(delta) {
  if (currentMode !== 'city' || cityTravelKeys.size === 0) return;
  camera.getWorldDirection(cityForward);
  cityForward.y = 0;
  if (cityForward.lengthSq() < 0.001) cityForward.set(0, 0, -1);
  cityForward.normalize();
  cityRight.crossVectors(cityForward, upAxis).normalize();
  cityMovement.set(0, 0, 0);
  if (cityTravelKeys.has('w') || cityTravelKeys.has('arrowup')) cityMovement.add(cityForward);
  if (cityTravelKeys.has('s') || cityTravelKeys.has('arrowdown')) cityMovement.sub(cityForward);
  if (cityTravelKeys.has('d') || cityTravelKeys.has('arrowright')) cityMovement.add(cityRight);
  if (cityTravelKeys.has('a') || cityTravelKeys.has('arrowleft')) cityMovement.sub(cityRight);
  if (cityMovement.lengthSq() === 0) return;
  cityMovement.normalize().multiplyScalar(delta * 24);
  focusTarget.add(cityMovement);
  const horizontalDistance = Math.hypot(focusTarget.x, focusTarget.z);
  if (horizontalDistance > 72) {
    const boundaryScale = 72 / horizontalDistance;
    focusTarget.x *= boundaryScale;
    focusTarget.z *= boundaryScale;
  }
}

function renderSceneFrame(delta) {
  updateCityTravel(delta);
  if (!isVideoCapture || playing || currentMode === 'city') {
    if (!controlsInteracting) controls.target.lerp(focusTarget, 1 - Math.exp(-delta * 3.7));
    if (playing) {
      const cameraOffset = camera.position.clone().sub(controls.target);
      const desiredDistance = 43 + currentBuildTopY * 0.88;
      cameraOffset.setLength(THREE.MathUtils.lerp(cameraOffset.length(), desiredDistance, 1 - Math.exp(-delta * 1.9)));
      camera.position.copy(controls.target).add(cameraOffset);
    } else if (currentMode === 'city' && !controlsInteracting) {
      const cameraOffset = camera.position.clone().sub(controls.target);
      cameraOffset.setLength(THREE.MathUtils.lerp(cameraOffset.length(), desiredCityDistance, 1 - Math.exp(-delta * 1.75)));
      camera.position.copy(controls.target).add(cameraOffset);
    }
    controls.update();
  }
  animateBugDamage();
  updateStructuralEffects(delta);
  commitAxis.rotation.y = -Math.atan2(camera.position.z, camera.position.x);
  crane.rotation.y += delta * (playing ? 0.2 : 0.055);
  hookBlock.position.y = 1.88 + Math.sin(elapsed * 1.5) * 0.1;
  issueMesh.rotation.y = Math.sin(elapsed * 0.05) * 0.08;
  issueBeams.rotation.y = issueMesh.rotation.y;
  if (currentMode === 'city') {
    cityBeacons.forEach((beacon, index) => {
      beacon.rotation.y += delta * (index === selectedCityIndex ? 1.15 : 0.34);
      const pulse = index === selectedCityIndex ? 1 + Math.sin(elapsed * 2.4) * 0.13 : 1;
      beacon.scale.setScalar(pulse);
    });
    citySelectionRing.rotation.z += delta * 0.18;
    citySelectionRing.material.opacity = 0.68 + Math.sin(elapsed * 2.1) * 0.18;
  }
  stars.rotation.y -= delta * 0.003;
  dust.rotation.y += delta * 0.014;
  if (!mobileRenderer) {
    const positions = dustGeometry.attributes.position.array;
    for (let index = 1; index < positions.length; index += 3) {
      positions[index] += delta * 0.17;
      if (positions[index] > towerHeight + 5) positions[index] = 0;
    }
    dustGeometry.attributes.position.needsUpdate = true;
  }
  updateHover();
  cameraJolt.set(
    reducedMotion ? 0 : Math.sin(elapsed * 91) * cameraShake,
    reducedMotion ? 0 : Math.cos(elapsed * 73) * cameraShake * 0.42,
    reducedMotion ? 0 : Math.sin(elapsed * 61) * cameraShake * 0.58,
  );
  camera.position.add(cameraJolt);
  if (composer) composer.render();
  else renderer.render(scene, camera);
  camera.position.sub(cameraJolt);
}

function renderAnimationStep() {
  const timestamp = Date.now();
  if (mobileRenderer && timestamp - lastRenderedTimestamp < 14) return;
  lastRenderedTimestamp = timestamp;
  const delta = lastAnimationTimestamp === null
    ? 0
    : Math.min(Math.max((timestamp - lastAnimationTimestamp) / 1000, 0), 0.05);
  lastAnimationTimestamp = timestamp;
  elapsed += delta;
  if (playing) {
    const playbackElapsed = Math.max(0, timestamp - playbackStartedAt) / 1000;
    const playbackProgress = playbackProgressAtElapsed(
      playbackStartProgress,
      playbackActionStartProgress,
      playbackElapsed,
      BUILD_DURATION_SECONDS,
    );
    if (playbackProgress >= 1) {
      setTimeline(commits.length, new Date(meta.end));
      setPlaying(false);
    } else {
      const playbackDate = playbackDateAtProgress(meta.start, meta.end, playbackProgress);
      setTimeline(commitCountAtPlaybackProgress(commits, meta.start, meta.end, playbackProgress), playbackDate);
    }
  }
  renderSceneFrame(delta);
}

function animate() {
  lastAnimationFrameHeartbeat = Date.now();
  renderAnimationStep();
  requestAnimationFrame(animate);
}

const animationWatchdog = window.setInterval(() => {
  const timestamp = Date.now();
  if (timestamp - lastAnimationFrameHeartbeat < 120) return;
  renderAnimationStep();
}, 1000 / 30);

document.addEventListener('visibilitychange', () => {
  lastAnimationTimestamp = null;
  lastAnimationFrameHeartbeat = Date.now();
  synthScore.setPlaying(soundEnabled && playing && !document.hidden);
  updateSoundControl();
});

window.addEventListener('pagehide', () => {
  window.clearInterval(animationWatchdog);
  stopPlaybackWorker();
  synthScore.destroy();
}, { once: true });

const captureFrameRate = 40;
const captureFrameCount = 1160;
const captureBuildStartFrame = 20;
const captureBuildEndFrame = 1139;
let lastManualCaptureFrame = -1;

function progressForCaptureFrame(frameIndex) {
  return playbackProgressForFrame(
    frameIndex,
    captureBuildStartFrame,
    captureBuildEndFrame,
    playbackActionStartProgress,
  );
}

function renderManualCaptureFrame(frameIndex) {
  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= captureFrameCount) {
    throw new RangeError(`Capture frame must be an integer from 0 to ${captureFrameCount - 1}.`);
  }
  if (frameIndex !== lastManualCaptureFrame + 1) {
    throw new RangeError(`Capture frames must be rendered sequentially; expected ${lastManualCaptureFrame + 1}.`);
  }
  elapsed = frameIndex / captureFrameRate;
  const buildIsActive = frameIndex >= captureBuildStartFrame && frameIndex <= captureBuildEndFrame;
  const playbackProgress = progressForCaptureFrame(frameIndex);
  const playbackDate = playbackDateAtProgress(meta.start, meta.end, playbackProgress);
  setPlaying(buildIsActive);
  setTimeline(
    commitCountAtPlaybackProgress(commits, meta.start, meta.end, playbackProgress),
    playbackDate,
  );
  renderSceneFrame(1 / captureFrameRate);
  lastManualCaptureFrame = frameIndex;
  return {
    frameIndex,
    visibleCommitCount,
    activeStructuralEffects: activeStructuralEffects.length,
    cameraShake,
  };
}

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(mobileRenderer ? 1 : Math.min(window.devicePixelRatio, 1.8));
  renderer.setSize(width, height, false);
  if (composer) composer.setSize(width, height);
  if (bloomPass) bloomPass.setSize(width, height);
}

window.addEventListener('resize', resize, { passive: true });
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize, { passive: true });

setTimeline(commits.length);
setMode('crews');
if (isFrameCapture) {
  experience.classList.add('is-entered');
  setPlaying(false);
  resetTimelineForPlayback();
  renderSceneFrame(0);
  window.__gitTowerCapture = {
    frameRate: captureFrameRate,
    frameCount: captureFrameCount,
    width: 1920,
    height: 1200,
    renderFrame: renderManualCaptureFrame,
  };
} else {
  animate();
}
if (repositoryTransfer) {
  window.requestAnimationFrame(() => completeRepositoryTransition(meta.repo));
}
