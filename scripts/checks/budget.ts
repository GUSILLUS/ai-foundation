import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { emptyResult, type Check } from '../lib/types.ts';

/** Ліміт Claude Code на additionalContext хука SessionStart (ADR 0001). */
export const SESSION_START_LIMIT = 10_000;

/**
 * Що af-core підставляє на старті сесії і скільки кожна частина може займати (ADR 0004, пп. 1, 8).
 * Картка проєкту наповнюється в ~/ai-foundation-data, тож тут міряємо шаблон — його порожній каркас.
 */
export const SESSION_START_PARTS = [
  { file: 'plugins/af-core/context/global-rules.md', limit: 2_000, what: 'глобальні правила' },
  { file: 'plugins/af-core/templates/context.md', limit: 6_000, what: 'шаблон картки проєкту' },
] as const;

/**
 * Постійний контекст — бюджет (рішення 6 roadmap друга). Перевищення — попередження, а не помилка:
 * під час роботи хук обрізає картку сам, але сюрприз краще побачити до релізу.
 */
export const budgetCheck: Check = {
  id: 'budget',
  title: 'Бюджет контексту на старті сесії',
  run: ({ root }) => {
    const res = emptyResult();
    let total = 0;
    let found = 0;
    for (const part of SESSION_START_PARTS) {
      const file = path.join(root, part.file);
      if (!existsSync(file)) continue;
      found++;
      const size = readFileSync(file, 'utf8').length;
      total += size;
      if (size > part.limit) res.warnings.push(`${part.file}: ${part.what} — ${size} символів, ліміт ${part.limit}`);
    }
    if (found === 0) {
      res.notes.push('файлів контексту ще немає');
      return res;
    }
    if (total > SESSION_START_LIMIT) {
      res.warnings.push(`разом ${total} символів — більше за ліміт SessionStart ${SESSION_START_LIMIT}`);
    }
    res.notes.push(`${total} / ${SESSION_START_LIMIT} символів`);
    return res;
  },
};
