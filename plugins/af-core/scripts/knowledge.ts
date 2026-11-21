#!/usr/bin/env node
/**
 * Детермінована частина скіла project-knowledge (ADR 0004). Завжди завершується з кодом 0,
 * а проблеми друкує текстом: скіл викликає `where` під час завантаження, і збій там зірвав би скіл.
 *
 *   where                              що відомо про поточну теку
 *   register --client <c> --project <p>  дописати проєкт у projects.json (наявне не перезаписує)
 *   index                              _topic.md, _index.md, розділ «Знання» картки, перевірка записів
 *   stale                              записи, код під якими змінився після перевірки
 *
 * Спільні опції: --cwd <тека> (за замовчуванням — поточна).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  autoMemoryDir,
  buildIndex,
  lintRecords,
  locate,
  readRecords,
  registerProject,
  remotesOf,
  staleness,
  updateCardKnowledge,
} from '../lib/knowledge.ts';
import { CARD_LIMIT, dataDir, normalizeRemote, readRegistry, resolveProject } from '../lib/session-context.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { cwd: { type: 'string' }, client: { type: 'string' }, project: { type: 'string' } },
});
const cmd = positionals[0] ?? 'where';
const cwd = path.resolve(values.cwd ?? process.cwd());
const say = (...lines: string[]) => console.log(lines.join('\n'));

function current() {
  const reg = readRegistry(dataDir());
  if (!reg.ok) return { reg, res: undefined };
  return { reg, res: resolveProject(cwd, reg.projects) };
}

function countMd(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.md')).length;
}

try {
  switch (cmd) {
    case 'where': {
      const { reg, res } = current();
      const remote = remotesOf(cwd)[0];
      say(`Тека: ${cwd}`, `Git remote: ${remote ? normalizeRemote(remote) : 'немає'}`, `Дані: ${dataDir()}`);
      if (!reg.ok) {
        say(reg.missing ? 'Реєстр: projects.json ще немає — почніть з реєстрації.' : `Реєстр: ${reg.error} — виправте вручну, скіл його не перезаписує.`);
        break;
      }
      if (!res || res.kind !== 'found') {
        say(res?.kind === 'ambiguous' ? 'Проєкт: тека відповідає кільком записам реєстру — виправте вручну.' : 'Проєкт: не зареєстровано — почніть з реєстрації.');
        break;
      }
      const loc = locate(res.entry);
      const card = existsSync(loc.cardFile) ? readFileSync(loc.cardFile, 'utf8').length : -1;
      const mem = autoMemoryDir(cwd);
      say(
        `Проєкт: ${loc.client}/${loc.project} (знайдено за ${res.by === 'remote' ? 'remote' : 'шляхом'})`,
        `Картка: ${card < 0 ? `немає (${loc.cardFile})` : `${loc.cardFile} — ${card} / ${CARD_LIMIT} символів`}`,
        `Знання проєкту: ${loc.knowledgeDir} — записів ${readRecords(loc.knowledgeDir).length}`,
        `Спільне клієнта: ${loc.sharedDir} — записів ${readRecords(loc.sharedDir).length}`,
        `Кандидати: проєкт ${countMd(path.join(loc.knowledgeDir, '_inbox'))}, клієнт ${countMd(path.join(loc.sharedDir, '_inbox'))}`,
        `Auto memory: ${existsSync(mem) ? `${mem} — файлів ${countMd(mem)}` : 'немає'}`,
      );
      break;
    }
    case 'register': {
      if (!values.client || !values.project) {
        say('Потрібні --client і --project.');
        break;
      }
      const r = registerProject(cwd, values.client, values.project);
      say(r.ok ? r.message : `Не зареєстровано: ${r.message}`);
      break;
    }
    case 'index':
    case 'stale': {
      const { res } = current();
      if (!res || res.kind !== 'found') {
        say('Проєкт не зареєстровано — спершу register.');
        break;
      }
      const loc = locate(res.entry);
      const out: string[] = [];
      for (const [label, dir] of [['проєкт', loc.knowledgeDir], ['клієнт', loc.sharedDir]] as const) {
        const records = readRecords(dir);
        const st = staleness(records, cwd);
        const stale = st.filter((s) => s.state === 'stale');
        if (cmd === 'stale') {
          out.push(`${label}: застарілих ${stale.length} з ${records.length}`, ...stale.map((s) => `  ⚠ ${s.rel} — ${s.reason}`));
          out.push(...st.filter((s) => s.state === 'unknown').map((s) => `  ? ${s.rel} — ${s.reason}`));
          continue;
        }
        if (!existsSync(dir) && records.length === 0) continue;
        buildIndex(dir, new Map(st.map((s) => [s.rel, s])));
        const issues = lintRecords(records);
        out.push(`${label}: записів ${records.length}, застарілих ${stale.length}`, ...issues.map((i) => `  ✘ ${i}`));
      }
      if (cmd === 'index') out.push(updateCardKnowledge(loc) ? 'Картку: розділ «Знання» оновлено.' : 'Картки ще немає — розділ «Знання» не оновлено.');
      say(...out);
      break;
    }
    default:
      say(`Невідома команда "${cmd}". Доступні: where, register, index, stale.`);
  }
} catch (e) {
  say(`Помилка: ${(e as Error).message}`);
}
