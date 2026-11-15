/**
 * Laporan workspace — shared helpers for format, compute, and delta.
 * Keep lightweight and pure (no React) so they can be unit-tested.
 */

export function formatDeltaPercent(current: number, previous: number): string | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) {
    return current === 0 ? '0%' : null;
  }
  const delta = ((current - previous) / Math.abs(previous)) * 100;
  if (!Number.isFinite(delta)) return null;
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toFixed(1)}%`;
}

export function deltaTone(current: number, previous: number): 'up' | 'down' | 'flat' | 'unknown' {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return 'unknown';
  if (current === previous) return 'flat';
  return current > previous ? 'up' : 'down';
}

export function isPeriodSingleDay(start: string | null, end: string | null): boolean {
  return Boolean(start && end && start === end);
}
