/**
 * Контекст на старті сесії (ADR 0004): глобальні правила + картка проєкту.
 *
 * Проєкт визначається лише за реєстром ~/ai-foundation-data/projects.json — за git remote,
 * запасний варіант — за шляхом. Вгадувати за назвою теки не можна (принцип 8, ізоляція клієнтів).
 * Читаються лише файли: git не запускається, мережі немає.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { HookInput, HookOutcome } from './shared/hook-runtime.ts';
import { dataDir, readRegistry, resolveProject } from './shared/project-registry.ts';

export * from './shared/project-registry.ts';

export const SESSION_START_LIMIT = 10_000;
export const CARD_LIMIT = 6_000;

// ---------- збирання контексту ----------

/** Обрізати картку по межі розділу `## ` в межах ліміту. */
export function truncateCard(text: string, limit = CARD_LIMIT): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const head = text.slice(0, limit);
  const cut = head.lastIndexOf('\n## ');
  return { text: (cut > 0 ? head.slice(0, cut) : head).trimEnd(), truncated: true };
}

export interface BuildOptions {
  rules: string;
  env?: NodeJS.ProcessEnv;
}

export function buildSessionContext(input: HookInput, opts: BuildOptions): HookOutcome {
  const rules = opts.rules.trim();
  const dir = dataDir(opts.env);
  const parts = [rules];
  const finish = (notice?: string): HookOutcome => {
    let text = parts.filter(Boolean).join('\n\n');
    if (text.length > SESSION_START_LIMIT) text = text.slice(0, SESSION_START_LIMIT - 1) + '…';
    return notice ? { kind: 'context', text, notice } : { kind: 'context', text };
  };

  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : undefined;
  if (!cwd) return finish('немає cwd у вході — контекст проєкту не додано');

  const reg = readRegistry(dir);
  if (!reg.ok) {
    if (reg.missing) {
      parts.push('Контекст проєкту: реєстру проєктів ще немає (projects.json в ai-foundation-data).');
      return finish();
    }
    return finish(`${reg.error} — контекст проєкту не додано`);
  }

  const res = resolveProject(cwd, reg.projects);
  if (res.kind === 'ambiguous') return finish('тека відповідає кільком проєктам у projects.json — контекст проєкту не додано');
  if (res.kind === 'unknown') {
    parts.push('Контекст проєкту: ця тека не зареєстрована в projects.json — картки проєкту немає, базові речі доведеться з’ясувати.');
    return finish();
  }

  const { client, project } = res.entry;
  const projectDir = path.join(dir, 'projects', client, project);
  const cardFile = path.join(projectDir, 'context.md');
  const knowledge = [
    `База знань: ${path.join(projectDir, 'knowledge')}`,
    `спільне клієнта: ${path.join(dir, 'projects', client, '_shared', 'knowledge')}`,
  ].join('; ');
  if (!existsSync(cardFile)) {
    parts.push(`# Проєкт ${client}/${project}\n\nКартки проєкту ще немає (${cardFile}). ${knowledge}.`);
    return finish(`картки проєкту ${client}/${project} ще немає`);
  }
  const card = truncateCard(readFileSync(cardFile, 'utf8').replace(/^﻿/, '').trim());
  const note = card.truncated ? `\n\n_(Картку обрізано до ${CARD_LIMIT} символів; повна — ${cardFile}.)_` : '';
  parts.push(`# Проєкт ${client}/${project}\n\n${card.text}${note}\n\n${knowledge}.`);
  return finish(card.truncated ? `картка ${client}/${project} довша за ${CARD_LIMIT} символів — обрізано` : undefined);
}
