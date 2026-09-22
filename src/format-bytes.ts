/**
 * Decimal byte labels for quota surfaces. Quotas a tier sells (storage,
 * vault, function bundle) are decimal — 250 MB is 250,000,000 bytes — and the
 * gateway sends each byte count with its human string beside it (`storage_limit`,
 * `total_storage`, ...). This renders the same shape locally for a byte count
 * that arrived without one.
 */
const DECIMAL_UNITS = ["B", "kB", "MB", "GB", "TB", "PB"] as const;

export function formatBytesDecimal(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < DECIMAL_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} ${DECIMAL_UNITS[unit]}`;
}
