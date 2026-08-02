const CITY_POSITIONS = [
  [0, 0],
  [-22, -18], [22, -17], [-21, 21], [23, 22],
  [1, -38], [-40, 1], [41, 2], [0, 42],
  [-42, -34], [43, -35], [-43, 38], [44, 39],
  [-20, -53], [22, -54], [-58, -13], [59, -12],
  [-59, 17], [60, 19], [-22, 58], [24, 59],
  [0, -68], [-69, 0], [70, 1],
];

const BACKDROP_CENTER_ANGLE = Math.PI * 1.25;
const BACKDROP_ANGLE_STEP = 0.22;

function repositoryKey(value) {
  return String(value || '').trim().toLowerCase();
}

export function cityTowerHeight(commitCount) {
  const commits = Math.max(0, Number(commitCount) || 0);
  return Math.min(55, 10 + Math.sqrt(commits / 3_000) * 45);
}

export function cityTowerRadius(entry) {
  const contributors = Math.max(0, Number(entry?.contributors) || 0);
  const branches = Math.max(0, Number(entry?.branches) || 0);
  return Math.min(5.4, 2.6 + Math.log2(contributors + 1) * 0.28 + Math.min(branches, 300) / 300 * 1.35);
}

export function createRepositoryDirectory(repositories, currentMeta) {
  const unique = new Map();
  for (const entry of [currentMeta, ...(repositories || [])]) {
    const key = repositoryKey(entry?.repo);
    if (!key || unique.has(key)) continue;
    unique.set(key, { ...entry, repo: entry.repo });
  }
  return [...unique.values()].sort((left, right) => (
    (Number(right.commits) || 0) - (Number(left.commits) || 0)
    || left.repo.localeCompare(right.repo)
  ));
}

export function createCityLayout(repositories, currentMeta, limit = CITY_POSITIONS.length) {
  const currentKey = repositoryKey(currentMeta?.repo);
  const unique = new Map();
  for (const entry of [currentMeta, ...(repositories || [])]) {
    const key = repositoryKey(entry?.repo);
    if (!key || unique.has(key)) continue;
    unique.set(key, { ...entry, repo: entry.repo });
  }

  const ordered = [...unique.values()]
    .sort((left, right) => {
      if (repositoryKey(left.repo) === currentKey) return -1;
      if (repositoryKey(right.repo) === currentKey) return 1;
      return (Number(right.commits) || 0) - (Number(left.commits) || 0) || left.repo.localeCompare(right.repo);
    })
    .slice(0, Math.max(1, Math.min(limit, CITY_POSITIONS.length)));

  return ordered.map((entry, index) => ({
    ...entry,
    index,
    current: repositoryKey(entry.repo) === currentKey,
    x: CITY_POSITIONS[index][0],
    z: CITY_POSITIONS[index][1],
    height: cityTowerHeight(entry.commits),
    radius: cityTowerRadius(entry),
  }));
}

export function createNeighborBackdrop(cityEntries, limit = 7) {
  const neighbors = (cityEntries || [])
    .filter((entry) => entry && !entry.current)
    .slice(0, Math.max(0, limit));
  const middle = (neighbors.length - 1) / 2;

  return neighbors.map((entry, index) => {
    const angle = BACKDROP_CENTER_ANGLE + (index - middle) * BACKDROP_ANGLE_STEP;
    const radius = 31 + (index % 2) * 6 + Math.floor(index / 4) * 2;
    return {
      repo: entry.repo,
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius,
      scale: 0.74 + (index % 3) * 0.055,
    };
  });
}
