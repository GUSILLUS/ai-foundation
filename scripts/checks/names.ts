import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  HASH_FILE,
  buildHashFile,
  hashMatcher,
  namesFilePath,
  parseHashFile,
  parseNamesList,
  plainMatcher,
  readKey,
  type Matcher,
} from '../lib/private-names.ts';
import { run } from '../lib/proc.ts';
import { listRepoFiles, rel } from '../lib/repo.ts';
import { emptyResult, type Check, type CheckResult } from '../lib/types.ts';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Назви клієнтів і проєктів у репозиторії (ADR 0004). Локально — за списком поза репо,
 * у CI — за HMAC-відбитками з `.private-names.json` і секретом `AF_NAMES_KEY`.
 * З `--commits <діапазон>` перевіряє й повідомлення комітів. Самої назви у звіті немає.
 */
export const namesCheck: Check = {
  id: 'names',
  title: 'Назви клієнтів і проєктів: лише поза репо',
  run: ({ root, commits }) => {
    const res = emptyResult();
    const env = process.env;
    const listFile = namesFilePath(env);
    const key = readKey(env);
    const hashPath = path.join(root, HASH_FILE);
    const hashFile = existsSync(hashPath) ? parseHashFile(readFileSync(hashPath, 'utf8')) : undefined;
    if (existsSync(hashPath) && !hashFile) res.errors.push(`${HASH_FILE}: невалідний формат — npm run names:update`);

    let matcher: Matcher;
    if (existsSync(listFile)) {
      const list = parseNamesList(readFileSync(listFile, 'utf8'));
      for (const e of list.errors) res.errors.push(`список назв, ${e}`);
      matcher = plainMatcher(list);
      res.notes.push(`список: ${list.names.length} назв(и)`);
      if (!key) {
        res.warnings.push(`немає ключа — CI не зможе перевіряти; npm run names:update`);
      } else {
        const fresh = buildHashFile(key, list);
        if (!hashFile || fresh.maxWords !== hashFile.maxWords || fresh.hashes.join() !== hashFile.hashes.join()) {
          res.errors.push(`${HASH_FILE} не відповідає локальному списку — npm run names:update і закомітьте файл`);
        }
      }
    } else if (hashFile && key) {
      matcher = hashMatcher(key, hashFile);
      res.notes.push(`відбитки: ${hashFile.hashes.length}`);
    } else if (hashFile && env.CI) {
      res.errors.push('у CI немає секрету AF_NAMES_KEY — додайте його в налаштуваннях репозиторію');
      return res;
    } else {
      return { ...res, skipped: hashFile ? 'немає ключа (AF_NAMES_KEY)' : `немає списку назв (${listFile})` };
    }

    scanFiles(root, matcher, res);
    if (commits && commits.length > 0) scanCommits(root, commits, matcher, res);
    return res;
  },
};

function scanFiles(root: string, matcher: Matcher, res: CheckResult): void {
  const files = listRepoFiles(root).filter((f) => rel(root, f) !== HASH_FILE);
  for (const file of files) {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    if (size > MAX_FILE_BYTES) continue;
    const buf = readFileSync(file);
    if (buf.includes(0)) continue;
    const name = rel(root, file);
    if (matcher.matches(name)) res.errors.push(`${name}: назва в шляху файлу`);
    buf
      .toString('utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (matcher.matches(line)) res.errors.push(`${name}:${i + 1}: назва клієнта чи проєкту`);
      });
  }
  res.notes.push(`${files.length} файл(ів)`);
}

function scanCommits(root: string, range: string[], matcher: Matcher, res: CheckResult): void {
  const r = run('git', ['log', '--format=%h%x00%B%x1e', ...range], { cwd: root });
  if (r.code !== 0) {
    res.warnings.push(`повідомлення комітів не перевірено: git log ${range.join(' ')} — ${r.stderr.trim()}`);
    return;
  }
  const entries = r.stdout.split('\x1e').map((s) => s.trim()).filter(Boolean);
  for (const entry of entries) {
    const [sha, body = ''] = entry.split('\0');
    body.split(/\r?\n/).forEach((line, i) => {
      if (matcher.matches(line)) res.errors.push(`коміт ${sha}, рядок ${i + 1}: назва клієнта чи проєкту`);
    });
  }
  res.notes.push(`${entries.length} коміт(ів)`);
}
