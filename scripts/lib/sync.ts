/**
 * Логіка синхронізації спільного коду: shared/<файл> → plugins/<плагін>/lib/shared/<файл>
 * за мапою shared/sync.json. CLI — scripts/sync-shared.ts.
 *
 * Копія = заголовок «не редагувати» + вміст джерела; порівняння без урахування CRLF/LF.
 * У --check помилкою також є відсутня копія й зайвий файл у lib/shared без запису в мапі.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const SHARED_DIR = 'shared';
export const MAP_FILE = 'shared/sync.json';
export const TARGET_SUBDIR = 'lib/shared';

export function header(source: string): string {
  return `// Згенеровано з shared/${source} командою \`npm run sync\`. Не редагуйте — зміни вносьте в shared/${source}.\n`;
}

interface Mapping {
  source: string;
  plugins: string[];
}

export interface SyncReport {
  errors: string[];
  changed: string[];
}

export function loadMap(root: string): Mapping[] {
  const raw = JSON.parse(readFileSync(path.join(root, MAP_FILE), 'utf8')) as { files?: unknown };
  if (!Array.isArray(raw.files)) throw new Error(`${MAP_FILE}: очікується поле files — масив`);
  return raw.files.map((f, i) => {
    const m = f as Partial<Mapping>;
    if (typeof m.source !== 'string' || !Array.isArray(m.plugins) || m.plugins.some((p) => typeof p !== 'string')) {
      throw new Error(`${MAP_FILE} → files[${i}]: очікується { "source": "<файл>", "plugins": ["<плагін>"] }`);
    }
    if (m.source.includes('/') || m.source.includes('\\')) {
      throw new Error(`${MAP_FILE} → files[${i}]: source — ім'я файлу в shared/, без підпапок`);
    }
    return { source: m.source, plugins: m.plugins as string[] };
  });
}

const normalize = (s: string) => s.replace(/\r\n/g, '\n');

export function syncShared(root: string, mode: 'write' | 'check'): SyncReport {
  const report: SyncReport = { errors: [], changed: [] };
  let map: Mapping[];
  try {
    map = loadMap(root);
  } catch (e) {
    report.errors.push((e as Error).message);
    return report;
  }

  const expected = new Map<string, string>(); // відносний шлях копії → очікуваний вміст
  for (const { source, plugins } of map) {
    const srcFile = path.join(root, SHARED_DIR, source);
    if (!existsSync(srcFile)) {
      report.errors.push(`${MAP_FILE}: джерела shared/${source} не існує`);
      continue;
    }
    const content = header(source) + normalize(readFileSync(srcFile, 'utf8'));
    for (const plugin of plugins) {
      if (!existsSync(path.join(root, 'plugins', plugin))) {
        report.errors.push(`${MAP_FILE}: плагіна plugins/${plugin} не існує`);
        continue;
      }
      expected.set(`plugins/${plugin}/${TARGET_SUBDIR}/${source}`, content);
    }
  }

  for (const [rel, content] of expected) {
    const file = path.join(root, rel);
    const current = existsSync(file) ? normalize(readFileSync(file, 'utf8')) : null;
    if (current === content) continue;
    if (mode === 'check') {
      report.errors.push(`${rel}: ${current === null ? 'копії немає' : 'копія відрізняється від shared/'} — виконайте npm run sync`);
    } else {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
      report.changed.push(rel);
    }
  }

  // Зайві файли в lib/shared — застарілі копії без запису в мапі.
  const pluginsDir = path.join(root, 'plugins');
  const plugins = existsSync(pluginsDir) ? readdirSync(pluginsDir) : [];
  for (const plugin of plugins) {
    const dir = path.join(pluginsDir, plugin, ...TARGET_SUBDIR.split('/'));
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const rel = `plugins/${plugin}/${TARGET_SUBDIR}/${name}`;
      if (!expected.has(rel)) report.errors.push(`${rel}: немає запису в ${MAP_FILE} — видаліть файл або додайте його в мапу`);
    }
  }
  return report;
}
