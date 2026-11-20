import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

/**
 * Читання транскриптів Claude Code (ADR 0001, п. 11; ADR 0002).
 * Формат внутрішній і змінюється між версіями — тут лише пошук файлів і безпечний розбір рядків.
 */

export interface ConfigDir {
  dir: string;
  /** Звідки взято шлях: прапорець, змінна оточення чи типовий ~/.claude. */
  source: 'flag' | 'CLAUDE_CONFIG_DIR' | 'default';
}

export function resolveConfigDir(flag?: string): ConfigDir {
  if (flag) return { dir: path.resolve(flag), source: 'flag' };
  if (process.env.CLAUDE_CONFIG_DIR) return { dir: path.resolve(process.env.CLAUDE_CONFIG_DIR), source: 'CLAUDE_CONFIG_DIR' };
  return { dir: path.join(os.homedir(), '.claude'), source: 'default' };
}

/** Тека з даними AI Foundation на цій машині — поза будь-яким git (CLAUDE.md, «Структура»). */
export function dataDir(): string {
  return path.join(os.homedir(), 'ai-foundation-data');
}

/** Усі *.jsonl під <config>/projects, рекурсивно (транскрипти субагентів можуть лежати глибше). */
export function findTranscriptFiles(configDir: string): string[] {
  const root = path.join(configDir, 'projects');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
  };
  if (existsSync(root) && statSync(root).isDirectory()) walk(root);
  return out.sort();
}

export type Line =
  | { kind: 'record'; record: Record<string, unknown> }
  | { kind: 'empty' }
  | { kind: 'invalid' }
  | { kind: 'non-object' };

/** Потокове читання JSONL: файли бувають великими, тож рядок за рядком. Помилки не кидає. */
export async function* readLines(file: string): AsyncGenerator<Line> {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() === '') {
      yield { kind: 'empty' };
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      yield { kind: 'invalid' };
      continue;
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      yield { kind: 'record', record: value as Record<string, unknown> };
    } else {
      yield { kind: 'non-object' };
    }
  }
}

/** Значення за шляхом `a.b.c`; масиви не розгортає. */
export function getPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const key of dotted.split('.')) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
