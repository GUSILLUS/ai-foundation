import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { listRepoFiles, rel } from '../lib/repo.ts';
import { emptyResult, type Check } from '../lib/types.ts';

/** Рядок з цією позначкою сканер пропускає — для навмисних прикладів у документації. */
export const ALLOW_MARKER = 'af-validate:allow-secret';
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const FORBIDDEN_FILES: Array<[RegExp, string]> = [
  [/^\.env(\..+)?$/, 'файл оточення'],
  [/\.(pem|key|p12|pfx)$/i, 'ключ або сертифікат'],
  [/^id_(rsa|ed25519|ecdsa|dsa)$/, 'SSH-ключ'],
];
const ALLOWED_FILES = new Set(['.env.example']);

const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, 'приватний ключ'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'ключ AWS'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'токен GitHub'],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/, 'токен GitHub'],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/, 'токен GitLab'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'ключ Anthropic'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/, 'ключ OpenAI'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'токен Slack'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'ключ Google'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/\b(?:api[_-]?key|secret|token|password|passwd)\b["']?\s*[:=]\s*["'][^"'\s]{16,}["']/i, 'значення схоже на секрет'],
];

/**
 * Секрети в репозиторії. Повідомлення містять лише файл, рядок і тип — ніколи саме значення.
 */
export const secretsCheck: Check = {
  id: 'secrets',
  title: 'Секрети: жодних токенів, ключів і .env',
  run: ({ root }) => {
    const res = emptyResult();
    const files = listRepoFiles(root);
    for (const file of files) {
      const name = rel(root, file);
      const base = path.basename(file);
      if (!ALLOWED_FILES.has(base)) {
        for (const [re, what] of FORBIDDEN_FILES) {
          if (re.test(base)) res.errors.push(`${name}: ${what} не має бути в репозиторії`);
        }
      }
      let size: number;
      try {
        size = statSync(file).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) continue;
      const buf = readFileSync(file);
      if (buf.includes(0)) continue; // бінарний файл
      const lines = buf.toString('utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (line.includes(ALLOW_MARKER)) return;
        for (const [re, what] of PATTERNS) {
          if (re.test(line)) {
            res.errors.push(`${name}:${i + 1}: ${what}`);
            break;
          }
        }
      });
    }
    res.notes.push(`${files.length} файл(ів) перевірено`);
    return res;
  },
};
