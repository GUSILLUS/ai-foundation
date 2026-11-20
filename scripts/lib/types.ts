export interface CheckResult {
  errors: string[];
  warnings: string[];
  notes: string[];
  /** Причина, з якої перевірку пропущено; якщо задано, errors ігноруються. */
  skipped?: string;
}

export interface Context {
  /** Абсолютний шлях до кореня репозиторію, який перевіряємо. */
  root: string;
}

export interface Check {
  id: string;
  title: string;
  run: (ctx: Context) => CheckResult | Promise<CheckResult>;
}

export function emptyResult(): CheckResult {
  return { errors: [], warnings: [], notes: [] };
}
