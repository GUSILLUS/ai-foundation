import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Назви клієнтів і їхніх проєктів не повинні потрапляти в публічний репозиторій (ADR 0004).
 *
 * Список назв лежить лише локально, поза репо. У репо — тільки HMAC-відбитки нормалізованих назв
 * (`.private-names.json`): без ключа з них назву не відновити, а CI з ключем (секрет `AF_NAMES_KEY`)
 * перевіряє так само, як локальна машина. Повідомлення ніколи не містять самої назви.
 */

export const HASH_FILE = '.private-names.json';
export const MIN_NAME_LENGTH = 3;
export const MAX_WORDS = 4;

/** Локальний список: AF_PRIVATE_NAMES_FILE або ~/ai-foundation-data/private-names.txt. */
export function namesFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.AF_PRIVATE_NAMES_FILE ?? path.join(homedir(), 'ai-foundation-data', 'private-names.txt');
}

/** Файл ключа поруч із секретами: %APPDATA%\ai-foundation\names.key / ~/.config/ai-foundation/names.key. */
export function keyFilePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AF_NAMES_KEY_FILE) return env.AF_NAMES_KEY_FILE;
  if (process.platform === 'win32') {
    return path.join(env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'ai-foundation', 'names.key');
  }
  return path.join(env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'ai-foundation', 'names.key');
}

/** Ключ: змінна AF_NAMES_KEY (CI) або файл ключа; undefined, якщо немає. */
export function readKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.AF_NAMES_KEY?.trim();
  if (fromEnv) return fromEnv;
  const file = keyFilePath(env);
  if (!existsSync(file)) return undefined;
  const v = readFileSync(file, 'utf8').trim();
  return v || undefined;
}

/** Слова рядка: розбиття за camelCase і будь-якими не-буквами/цифрами, у нижньому регістрі. */
export function words(text: string): string[] {
  return text
    .normalize('NFKC')
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Нормалізована назва: слова без роздільників (`acme_cms`, `ACME-CMS`, `acmeCms` → одне значення). */
export function normalizeName(name: string): string {
  return words(name).join('');
}

export interface NamesList {
  names: string[]; // нормалізовані
  maxWords: number;
  errors: string[];
}

/** Розбір списку: одна назва на рядок, `#` — коментар. */
export function parseNamesList(text: string): NamesList {
  const names = new Set<string>();
  const errors: string[] = [];
  let maxWords = 1;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) return;
    const n = normalizeName(line);
    if (n.length < MIN_NAME_LENGTH) {
      errors.push(`рядок ${i + 1}: назва коротша за ${MIN_NAME_LENGTH} символи — забагато хибних збігів`);
      return;
    }
    const w = words(line).length;
    if (w > MAX_WORDS) {
      errors.push(`рядок ${i + 1}: більше ${MAX_WORDS} слів`);
      return;
    }
    maxWords = Math.max(maxWords, w);
    names.add(n);
  });
  return { names: [...names].sort(), maxWords, errors };
}

export function hashName(key: string, normalized: string): string {
  return createHmac('sha256', key).update(normalized).digest('hex').slice(0, 32);
}

export interface HashFile {
  version: 1;
  maxWords: number;
  hashes: string[];
}

export function buildHashFile(key: string, list: NamesList): HashFile {
  return { version: 1, maxWords: list.maxWords, hashes: list.names.map((n) => hashName(key, n)).sort() };
}

export function parseHashFile(text: string): HashFile | undefined {
  try {
    const v = JSON.parse(text) as Partial<HashFile>;
    if (v.version !== 1 || !Array.isArray(v.hashes) || typeof v.maxWords !== 'number') return undefined;
    return { version: 1, maxWords: v.maxWords, hashes: v.hashes.filter((h) => typeof h === 'string') };
  } catch {
    return undefined;
  }
}

/** Перевірка рядка: чи є серед вікон з 1..maxWords сусідніх слів назва зі списку. */
export interface Matcher {
  matches: (line: string) => boolean;
}

export function plainMatcher(list: Pick<NamesList, 'names' | 'maxWords'>): Matcher {
  const set = new Set(list.names);
  return { matches: (line) => windows(words(line), list.maxWords).some((w) => set.has(w)) };
}

export function hashMatcher(key: string, file: HashFile): Matcher {
  const set = new Set(file.hashes);
  const cache = new Map<string, boolean>();
  return {
    matches: (line) =>
      windows(words(line), file.maxWords).some((w) => {
        let hit = cache.get(w);
        if (hit === undefined) {
          hit = w.length >= MIN_NAME_LENGTH && set.has(hashName(key, w));
          cache.set(w, hit);
        }
        return hit;
      }),
  };
}

function windows(ws: string[], maxWords: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < ws.length; i++) {
    let acc = '';
    for (let n = 0; n < maxWords && i + n < ws.length; n++) {
      acc += ws[i + n];
      out.push(acc);
    }
  }
  return out;
}
