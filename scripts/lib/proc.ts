import { spawnSync } from 'node:child_process';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Помилка запуску (наприклад, програму не знайдено). */
  error?: Error;
}

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Запуск програми з аргументами. На Windows команди на кшталт `claude` часто є `.cmd`-шимами,
 * які не запускаються без оболонки, тож там збираємо командний рядок самі й передаємо в shell.
 * Для `node` (process.execPath) оболонка не потрібна на жодній ОС.
 */
export function run(command: string, args: string[], opts: RunOptions): RunResult {
  const useShell = process.platform === 'win32' && command !== process.execPath;
  const common = {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: 'utf8' as const,
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  };
  const r = useShell
    ? spawnSync([command, ...args].map(quoteWin).join(' '), { ...common, shell: true })
    : spawnSync(command, args, common);
  return {
    code: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    ...(r.error ? { error: r.error } : {}),
  };
}

function quoteWin(arg: string): string {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}
