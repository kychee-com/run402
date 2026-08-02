const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;

export function normalizeRepositoryInput(value) {
  const raw = String(value || '').trim();
  if (/^https?:\/\//i.test(raw)) {
    const parsed = new URL(raw);
    if (parsed.hostname.toLowerCase() !== 'github.com') throw new Error('Use a github.com repository URL.');
    return parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  }
  return raw.replace(/^github\.com\//i, '').replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
}

export function getRepositoryActionState(value, { currentRepository = null, loading = false } = {}) {
  let repo = '';
  let inputError = null;
  try {
    repo = normalizeRepositoryInput(value);
  } catch (error) {
    inputError = error;
  }
  const valid = inputError == null && REPOSITORY_PATTERN.test(repo);
  const matchesCurrent = valid
    && currentRepository != null
    && repo.toLowerCase() === currentRepository.toLowerCase();
  return {
    repo,
    valid,
    matchesCurrent,
    inputError,
    buildEnabled: !loading && valid && !matchesCurrent,
    watchEnabled: !loading && valid && matchesCurrent,
  };
}
