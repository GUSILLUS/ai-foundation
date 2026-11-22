/**
 * Нагадування про кандидатів знань (ADR 0004, п. 5): на Stop, лише коли з'явилися нові кандидати
 * з моменту попереднього нагадування в цій сесії. Рядок бачить користувач — затверджує він.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { locate } from './knowledge.ts';
import { dataDir, readRegistry, resolveProject } from './session-context.ts';
import type { HookInput, HookOutcome } from './shared/hook-runtime.ts';

export function listCandidates(dirs: string[]): string[] {
  return dirs.flatMap((d) => {
    const inbox = path.join(d, '_inbox');
    if (!existsSync(inbox)) return [];
    return readdirSync(inbox).filter((f) => f.endsWith('.md')).sort().map((f) => path.join(inbox, f));
  });
}

function seenFile(sessionId: string, env: NodeJS.ProcessEnv): string {
  const base = env.CLAUDE_PLUGIN_DATA ?? path.join(tmpdir(), 'af-core');
  return path.join(base, 'inbox', `${sessionId.replace(/[^\w-]/g, '_')}.json`);
}

export function inboxReminder(input: HookInput, env: NodeJS.ProcessEnv = process.env): HookOutcome {
  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  if (!cwd || typeof input.session_id !== 'string') return { kind: 'pass' };
  // Stop, викликаний продовженням після іншого Stop-хука, не нагадує вдруге.
  if (input.stop_hook_active === true) return { kind: 'pass' };
  const reg = readRegistry(dataDir(env));
  if (!reg.ok) return { kind: 'pass' };
  const res = resolveProject(cwd, reg.projects);
  if (res.kind !== 'found') return { kind: 'pass' };
  const loc = locate(res.entry, env);
  const all = listCandidates([loc.knowledgeDir, loc.sharedDir]);
  const file = seenFile(input.session_id, env);
  let seen: string[] = [];
  try {
    seen = JSON.parse(readFileSync(file, 'utf8')) as string[];
  } catch {
    /* немає стану — нічого не бачили */
  }
  const fresh = all.filter((f) => !seen.includes(f));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(all));
  if (fresh.length === 0) return { kind: 'pass' };
  return {
    kind: 'context',
    text: '',
    notice: `кандидатів у базу знань: ${all.length} (нових ${fresh.length}) — розібрати: /af-core:project-knowledge verify`,
  };
}
