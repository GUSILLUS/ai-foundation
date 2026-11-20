import { compareSemver, isSemver } from '../lib/semver.ts';
import { isObject, listPluginDirs, readPackageJson } from '../lib/repo.ts';
import { run } from '../lib/proc.ts';
import { emptyResult, type Check, type CheckResult } from '../lib/types.ts';

/** Шлях до CLI можна підмінити змінною AF_CLAUDE_BIN (наприклад, у тестах). */
export function claudeBin(): string {
  return process.env.AF_CLAUDE_BIN || 'claude';
}

/**
 * Вбудована валідація Claude Code: `claude plugin validate --strict --json` для маркетплейсу
 * й кожного плагіна окремо (маркетплейс-прогін не відкриває скіли й хуки плагінів — ADR 0001, п. 3).
 */
export const claudeCheck: Check = {
  id: 'claude',
  title: 'claude plugin validate --strict',
  run: ({ root }) => {
    const res = emptyResult();
    const bin = claudeBin();
    const pinned = pinnedVersion(root);

    const v = run(bin, ['--version'], { cwd: root, timeoutMs: 30_000 });
    const version = /(\d+\.\d+\.\d+)/.exec(v.stdout)?.[1];
    if (v.error || v.code !== 0 || !version) {
      res.errors.push(
        `Claude Code CLI не знайдено або не відповідає (${bin}). Встановіть: npm i -g @anthropic-ai/claude-code@${pinned ?? '<версія з package.json>'}`,
      );
      return res;
    }
    if (pinned) {
      const cmp = compareSemver(version, pinned);
      if (cmp < 0) res.errors.push(`Claude Code ${version} старіший за мінімум ${pinned} (package.json → config.claudeCodeVersion)`);
      else if (cmp > 0) res.notes.push(`Claude Code ${version}, у CI закріплено ${pinned}; якщо результат відрізняється від CI — час свідомо підняти версію`);
      else res.notes.push(`Claude Code ${version}`);
    } else {
      res.errors.push('package.json: бракує config.claudeCodeVersion');
    }

    const targets = ['.', ...listPluginDirs(root).map((d) => `plugins/${d}`)];
    for (const target of targets) validateTarget(bin, root, target, res);
    return res;
  },
};

function pinnedVersion(root: string): string | null {
  const pkg = readPackageJson(root);
  const v = isObject(pkg.config) ? pkg.config.claudeCodeVersion : undefined;
  return isSemver(v) ? v : null;
}

interface Issue {
  path?: string;
  message?: string;
}

function validateTarget(bin: string, root: string, target: string, res: CheckResult): void {
  const r = run(bin, ['plugin', 'validate', target, '--strict', '--json'], { cwd: root });
  const report = parseJson(r.stdout);
  if (r.error || r.code === 2 || !report) {
    const reason = r.error?.message ?? (r.stderr.trim().split('\n')[0] || `код виходу ${r.code}`);
    res.errors.push(`${target}: валідатор не відпрацював — ${reason}`);
    return;
  }
  if (report.success === true && r.code === 0) return;

  const issues: string[] = [];
  const add = (file: string, list: unknown, kind: string) => {
    if (!Array.isArray(list)) return;
    for (const item of list as Issue[]) issues.push(`${file}: ${kind} ${item.path ? `${item.path}: ` : ''}${item.message ?? ''}`.trim());
  };
  if (isObject(report.manifest)) {
    const file = typeof report.manifest.file === 'string' ? shorten(root, report.manifest.file) : target;
    add(file, report.manifest.errors, '✘');
    add(file, report.manifest.warnings, '⚠');
  }
  if (Array.isArray(report.contents)) {
    for (const c of report.contents) {
      if (!isObject(c)) continue;
      const file = typeof c.file === 'string' ? shorten(root, c.file) : target;
      add(file, c.errors, '✘');
      add(file, c.warnings, '⚠');
    }
  }
  if (issues.length === 0) issues.push(`${target}: Validation failed (код ${r.code})`);
  res.errors.push(...issues);
}

function parseJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) return null;
  try {
    const v: unknown = JSON.parse(text.slice(start, end + 1));
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

function shorten(root: string, file: string): string {
  const norm = (p: string) => p.split('\\').join('/');
  const r = norm(root).replace(/\/$/, '') + '/';
  const f = norm(file);
  return f.startsWith(r) ? f.slice(r.length) : f;
}
