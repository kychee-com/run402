export function createCrewCommitCounts(contributors, commits, visibleCommitCount = commits.length) {
  const counts = new Map(contributors.map((person) => [person.id, 0]));
  for (let index = 0; index < Math.min(visibleCommitCount, commits.length); index += 1) {
    const contributorId = commits[index].authorId;
    counts.set(contributorId, (counts.get(contributorId) || 0) + 1);
  }
  return counts;
}

export function moveCrewCommitCounts(counts, commits, previousCommitCount, nextCommitCount) {
  if (nextCommitCount > previousCommitCount) {
    for (let index = previousCommitCount; index < nextCommitCount; index += 1) {
      const contributorId = commits[index].authorId;
      counts.set(contributorId, (counts.get(contributorId) || 0) + 1);
    }
  } else if (nextCommitCount < previousCommitCount) {
    for (let index = previousCommitCount - 1; index >= nextCommitCount; index -= 1) {
      const contributorId = commits[index].authorId;
      counts.set(contributorId, Math.max(0, (counts.get(contributorId) || 0) - 1));
    }
  }
  return counts;
}

export function rankCrewContributors(contributors, counts, limit = 24) {
  const stableRank = new Map(contributors.map((person, index) => [person.id, index]));
  return contributors
    .slice(0, limit)
    .sort((left, right) => {
      const countDifference = (counts.get(right.id) || 0) - (counts.get(left.id) || 0);
      return countDifference || stableRank.get(left.id) - stableRank.get(right.id);
    });
}

export function crewCommitShare(count, leadingCount) {
  if (!Number.isFinite(count) || !Number.isFinite(leadingCount) || leadingCount <= 0) return 0;
  return Math.max(0, Math.min(1, count / leadingCount));
}

function cubicBezierCoordinate(time, firstControl, secondControl) {
  const inverse = 1 - time;
  return (3 * inverse * inverse * time * firstControl)
    + (3 * inverse * time * time * secondControl)
    + (time * time * time);
}

function crewReorderEase(progress) {
  if (progress <= 0 || progress >= 1) return progress;
  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const candidate = (lower + upper) / 2;
    const candidateProgress = cubicBezierCoordinate(candidate, 0.2, 0);
    if (candidateProgress < progress) lower = candidate;
    else upper = candidate;
  }
  return cubicBezierCoordinate((lower + upper) / 2, 0, 1);
}

export function stepCrewRankMotion(
  motion,
  contributorIds,
  { deltaSeconds = 1 / 40, durationSeconds = 0.42, reset = false } = {},
) {
  contributorIds.forEach((contributorId, targetPosition) => {
    let state = motion.get(contributorId);
    if (!state || reset) {
      state = {
        position: targetPosition,
        startPosition: targetPosition,
        targetPosition,
        elapsedSeconds: durationSeconds,
      };
      motion.set(contributorId, state);
      return;
    }

    if (state.targetPosition !== targetPosition) {
      state.startPosition = state.position;
      state.targetPosition = targetPosition;
      state.elapsedSeconds = 0;
    }

    state.elapsedSeconds = Math.min(durationSeconds, state.elapsedSeconds + deltaSeconds);
    const progress = durationSeconds > 0 ? state.elapsedSeconds / durationSeconds : 1;
    const easedProgress = crewReorderEase(progress);
    state.position = state.startPosition
      + ((state.targetPosition - state.startPosition) * easedProgress);
    if (state.elapsedSeconds >= durationSeconds) state.position = state.targetPosition;
  });
  return motion;
}
