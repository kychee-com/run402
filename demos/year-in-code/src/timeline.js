function timestamp(value) {
  const resolved = new Date(value).valueOf();
  if (!Number.isFinite(resolved)) throw new TypeError('timeline values must be valid dates');
  return resolved;
}

export function binaryCountByDate(items, field, targetDate) {
  const target = timestamp(targetDate);
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (timestamp(items[middle][field]) <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function playbackDateAtProgress(start, end, progress) {
  const startTimestamp = timestamp(start);
  const endTimestamp = timestamp(end);
  const resolvedProgress = Math.max(0, Math.min(1, Number(progress) || 0));
  return new Date(startTimestamp + (endTimestamp - startTimestamp) * resolvedProgress);
}

export function playbackProgressForDate(start, end, date) {
  const startTimestamp = timestamp(start);
  const endTimestamp = timestamp(end);
  if (endTimestamp <= startTimestamp) return 0;
  return Math.max(0, Math.min(1, (timestamp(date) - startTimestamp) / (endTimestamp - startTimestamp)));
}

export function playbackActivityStart(start, end, activityDates) {
  const startTimestamp = timestamp(start);
  const endTimestamp = timestamp(end);
  const firstActivityTimestamp = activityDates
    .filter((value) => value != null)
    .map(timestamp)
    .filter((value) => value >= startTimestamp && value <= endTimestamp)
    .reduce((earliest, value) => Math.min(earliest, value), Infinity);
  if (!Number.isFinite(firstActivityTimestamp)) return new Date(startTimestamp);
  return new Date(Math.max(startTimestamp, firstActivityTimestamp - 1));
}

export function playbackProgressAtElapsed(startProgress, activityStartProgress, elapsedSeconds, durationSeconds) {
  const resolvedStart = Math.max(0, Math.min(1, Number(startProgress) || 0));
  const resolvedActivityStart = Math.max(0, Math.min(1, Number(activityStartProgress) || 0));
  const resolvedElapsed = Math.max(0, Number(elapsedSeconds) || 0);
  const resolvedDuration = Math.max(Number.EPSILON, Number(durationSeconds) || 0);
  const activeSpan = 1 - resolvedActivityStart;
  return Math.max(0, Math.min(1, resolvedStart + (resolvedElapsed / resolvedDuration) * activeSpan));
}

export function playbackProgressForFrame(frameIndex, startFrame, endFrame, activityStartProgress) {
  const resolvedActivityStart = Math.max(0, Math.min(1, Number(activityStartProgress) || 0));
  if (frameIndex < startFrame) return resolvedActivityStart;
  if (frameIndex > endFrame) return 1;
  const frameProgress = Math.max(0, Math.min(1, (frameIndex - startFrame) / Math.max(1, endFrame - startFrame)));
  return resolvedActivityStart + frameProgress * (1 - resolvedActivityStart);
}

export function commitCountAtPlaybackProgress(commits, start, end, progress) {
  return binaryCountByDate(commits, 'date', playbackDateAtProgress(start, end, progress));
}
