const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

export function isSemver(value: unknown): value is string {
  return typeof value === 'string' && SEMVER.test(value);
}

/** Порівняння major.minor.patch; пре-реліз молодший за реліз. Повертає -1, 0 або 1. */
export function compareSemver(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === '') return 1;
  if (pb.pre === '') return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

function parse(v: string): { nums: number[]; pre: string } {
  const [core = '', pre = ''] = v.split('+')[0]!.split(/-(.*)/s);
  return { nums: core.split('.').map((n) => Number(n)), pre };
}

/**
 * Мінімальна версія з діапазону: `>=1.2.3`, `^1.2.3`, `~1.2.3` або `1.2.3`.
 * Для інших форм повертає null — такі діапазони ми не приймаємо.
 */
export function minOfRange(range: unknown): string | null {
  if (typeof range !== 'string') return null;
  const m = /^\s*(?:>=|\^|~)?\s*(\S+)\s*$/.exec(range);
  if (!m || !isSemver(m[1])) return null;
  return m[1]!;
}
