#!/usr/bin/env node
/**
 * Детермінована частина скіла handoff. Завжди код 0; проблеми — текстом.
 *
 *   where                    тека handoff проєкту, останні знімки, ім'я для нового ручного handoff
 *   snapshot --session <id>  знімок поточної сесії з транскрипту (друкує, не зберігає)
 *
 * Спільна опція: --cwd <тека> (за замовчуванням — поточна).
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { branchOf, extractFacts, handoffPlace, readTail, renderSnapshot } from '../lib/snapshot.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { cwd: { type: 'string' }, session: { type: 'string' } } });
const cmd = positionals[0] ?? 'where';
const cwd = path.resolve(values.cwd ?? process.cwd());
const now = new Date();

/** Транскрипт сесії: `<config>/projects/<cwd, не-алфанумерика → ->/<id>.jsonl`, інакше пошук по всіх проєктах. */
export function findTranscript(sessionId: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const projects = path.join(env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude'), 'projects');
  const direct = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  if (!existsSync(projects)) return undefined;
  for (const d of readdirSync(projects)) {
    const f = path.join(projects, d, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return undefined;
}

try {
  const place = handoffPlace(cwd);
  if (cmd === 'where') {
    const files = existsSync(place.dir) ? readdirSync(place.dir).filter((x) => x.endsWith('.md')).sort().slice(-5) : [];
    console.log(
      [
        `Проєкт: ${place.label}`,
        `Тека handoff: ${place.dir}`,
        `Останні: ${files.length ? files.join(', ') : 'немає'}`,
        `Новий ручний handoff: ${path.join(place.dir, `${now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-manual.md`)}`,
      ].join('\n'),
    );
  } else if (cmd === 'snapshot') {
    const file = values.session ? findTranscript(values.session) : undefined;
    if (!file) console.log('Транскрипт поточної сесії не знайдено — знімок зробити не можна; заповни шаблон з того, що знаєш.');
    else console.log(renderSnapshot(extractFacts(readTail(file), cwd), { trigger: 'manual', when: now, label: place.label, branch: branchOf(cwd), candidates: 0 }));
  } else console.log(`Невідома команда "${cmd}". Доступні: where, snapshot.`);
} catch (e) {
  console.log(`Помилка: ${(e as Error).message}`);
}
