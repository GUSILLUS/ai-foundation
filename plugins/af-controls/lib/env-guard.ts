/**
 * env-guard (PreToolUse): забороняє агенту читати й редагувати файли оточення (.env),
 * щоб секрети не потрапляли в контекст (CLAUDE.md: «Ніколи не читати й не виводити секрети»).
 *
 * Блокуються: `.env`, `.env.<будь-що>`, `<будь-що>.env` і `.envrc` (direnv).
 * Дозволені шаблони без секретів: `.env.example`, `.env.sample`, `.env.template`, `.env.dist`.
 *
 * Обмеження: команди Bash (наприклад, `cat .env`) цей хук не розбирає.
 *
 * Точка входу хука — hooks/env-guard.ts.
 */
import path from 'node:path';
import type { HookInput, HookOutcome } from './shared/hook-runtime.ts';

export const GUARDED_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SAFE_SUFFIXES = new Set(['example', 'sample', 'template', 'dist']);

export const DENY_REASON =
  'af-controls/env-guard: читання й редагування файлів оточення (.env) заборонене — секрети не мають потрапляти в контекст. ' +
  'Якщо потрібна структура змінних, використайте .env.example або спитайте користувача.';

/** Чи є ім’я файлу файлом оточення з потенційними секретами. */
export function isEnvFile(filePath: string): boolean {
  const base = path.basename(filePath.replace(/\\/g, '/')).toLowerCase();
  if (base === '.env' || base === '.envrc') return true;
  if (base.startsWith('.env.')) return !SAFE_SUFFIXES.has(base.slice('.env.'.length));
  return base.endsWith('.env') && base.length > '.env'.length;
}

export function decide(input: HookInput): HookOutcome {
  if (typeof input.tool_name !== 'string') return { kind: 'degrade', reason: 'у вході немає tool_name' };
  if (!GUARDED_TOOLS.has(input.tool_name)) return { kind: 'pass' };
  const toolInput = input.tool_input;
  if (typeof toolInput !== 'object' || toolInput === null) {
    return { kind: 'degrade', reason: `у вході ${input.tool_name} немає tool_input` };
  }
  const target = (toolInput as Record<string, unknown>)[input.tool_name === 'NotebookEdit' ? 'notebook_path' : 'file_path'];
  if (typeof target !== 'string' || target === '') {
    return { kind: 'degrade', reason: `у вході ${input.tool_name} немає шляху до файлу` };
  }
  return isEnvFile(target) ? { kind: 'deny', reason: DENY_REASON } : { kind: 'pass' };
}
