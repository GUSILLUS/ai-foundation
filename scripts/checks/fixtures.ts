import { readFileSync } from 'node:fs';
import path from 'node:path';
import { listPluginDirs, rel, walkFiles } from '../lib/repo.ts';
import { emptyResult, type Check, type CheckResult } from '../lib/types.ts';

/**
 * Фікстури тестів — лише синтетичні (ADR 0001, «Наслідки» п. 9; ADR 0002).
 *
 * Для JSON/JSONL діє білий список: кожне рядкове значення має бути
 *   - заглушкою `<fixture>` або `<fixture:щось>` (а також службовим `<synthetic>`-подібним значенням);
 *   - шляхом під дозволеним префіксом (`/fixtures/`, `C:/fixtures/`, `C:\fixtures\`)
 *     або відносним шляхом без пробілів;
 *   - коротким токеном без пробілів і слешів: ідентифікатор, версія, дата, назва інструмента чи моделі.
 * Вільний текст (з пробілами) і будь-які інші абсолютні шляхи — помилка. Так у git не потрапить
 * ні фрагмент реального транскрипту, ні нове поле з вмістом, яке з’явиться в майбутньому форматі.
 *
 * Для решти файлів — пошук e-mail і реальних абсолютних шляхів.
 * Повідомлення містять файл і місце, але ніколи значення.
 */
export const fixturesCheck: Check = {
  id: 'fixtures',
  title: 'Фікстури: лише синтетичні дані',
  run: ({ root }) => {
    const res = emptyResult();
    const dirs = [
      path.join(root, 'scripts', 'tests', 'fixtures'),
      ...listPluginDirs(root).map((p) => path.join(root, 'plugins', p, 'tests', 'fixtures')),
    ];
    let count = 0;
    for (const dir of dirs) {
      for (const file of walkFiles(dir, () => true)) {
        count++;
        checkFile(file, rel(root, file), res);
      }
    }
    res.notes.push(count ? `${count} файл(ів)` : 'фікстур немає');
    return res;
  },
};

const PLACEHOLDER = /^<fixture(?::[^<>]{0,60})?>$/;
/** Службові значення Claude Code в кутових дужках, наприклад `<synthetic>` для повідомлень про помилки API. */
const ANGLE_TOKEN = /^<[a-z][a-z_-]{0,30}>$/;
const FIXTURE_PATH = /^(?:\/fixtures\/|[A-Za-z]:[\\/]fixtures[\\/])[^\s]*$/;
const RELATIVE_PATH = /^(?![\\/~])(?![A-Za-z]:)[\w.@+-]+(?:[\\/][\w.@+-]+)*[\\/]?$/;
const TOKEN = /^[\w.:+@#=,-]{0,100}$/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
/** Абсолютні шляхи поза префіксом /fixtures/ у будь-якому тексті. */
const REAL_PATH = /(?:^|[\s"'=(])(?:\/(?:home|Users|root|mnt|sessions|var|opt|tmp)\/|~[\\/]|[A-Za-z]:[\\/](?!fixtures[\\/])|\\\\[\w.-]+\\)/;

export function classifyString(value: string): string | null {
  if (EMAIL.test(value)) return 'e-mail';
  if (PLACEHOLDER.test(value) || ANGLE_TOKEN.test(value) || FIXTURE_PATH.test(value)) return null;
  if (REAL_PATH.test(value) || /^[\\/]/.test(value)) return 'абсолютний шлях поза /fixtures/';
  if (TOKEN.test(value) || RELATIVE_PATH.test(value)) return null;
  return 'вільний текст — замініть на "<fixture>"';
}

function checkFile(file: string, name: string, res: CheckResult): void {
  const text = readFileSync(file, 'utf8');
  if (/\.jsonl?$/i.test(file)) {
    const lines = file.toLowerCase().endsWith('.jsonl') ? text.split(/\r?\n/) : [text];
    lines.forEach((line, i) => {
      if (line.trim() === '') return;
      const where = file.toLowerCase().endsWith('.jsonl') ? `${name}:${i + 1}` : name;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        // Навмисно зламаний JSON у фікстурі — допустимо, але перевіряємо як звичайний текст.
        scanText(line, where, res);
        return;
      }
      walk(value, '', where, res);
    });
    return;
  }
  text.split(/\r?\n/).forEach((line, i) => scanText(line, `${name}:${i + 1}`, res));
}

function walk(value: unknown, at: string, where: string, res: CheckResult): void {
  if (typeof value === 'string') {
    const problem = classifyString(value);
    if (problem) res.errors.push(`${where} → ${at || '(значення)'}: ${problem}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${at}[${i}]`, where, res));
  } else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      const keyProblem = EMAIL.test(k) ? 'e-mail у ключі' : REAL_PATH.test(k) ? 'абсолютний шлях у ключі' : null;
      if (keyProblem) res.errors.push(`${where} → ${at}: ${keyProblem}`);
      walk(v, at ? `${at}.${k}` : k, where, res);
    }
  }
}

function scanText(line: string, where: string, res: CheckResult): void {
  if (EMAIL.test(line)) res.errors.push(`${where}: e-mail`);
  else if (REAL_PATH.test(line)) res.errors.push(`${where}: абсолютний шлях поза /fixtures/`);
}
