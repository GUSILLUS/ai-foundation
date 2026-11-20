import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '../lib/frontmatter.ts';
import { KEBAB, listPluginDirs, rel, walkFiles } from '../lib/repo.ts';
import { emptyResult, type Check } from '../lib/types.ts';

/** Ліміт Claude Code на description + when_to_use у списку скілів (ADR 0001, п. 7). */
export const SKILL_DESCRIPTION_LIMIT = 1536;
export const SKILL_MAX_LINES = 500;

export const skillsCheck: Check = {
  id: 'skills',
  title: 'Скіли: ліміти опису й розміру',
  run: ({ root }) => {
    const res = emptyResult();
    let count = 0;
    for (const plugin of listPluginDirs(root)) {
      const base = path.join(root, 'plugins', plugin);
      if (existsSync(path.join(base, 'commands'))) {
        res.warnings.push(`plugins/${plugin}/commands: застарілий формат — використовуйте skills/`);
      }
      for (const file of walkFiles(path.join(base, 'skills'), (f) => path.basename(f) === 'SKILL.md')) {
        count++;
        const where = rel(root, file);
        const fm = parseFrontmatter(readFileSync(file, 'utf8'));
        if (!fm.present) {
          res.errors.push(`${where}: бракує frontmatter (--- … ---)`);
          continue;
        }
        const { name, description, when_to_use: whenToUse } = fm.fields;
        if (name !== undefined && !KEBAB.test(name)) res.errors.push(`${where}: name "${name}" має бути в kebab-case`);
        if (!description) {
          res.errors.push(`${where}: бракує description`);
        } else {
          const len = description.length + (whenToUse ? whenToUse.length + 1 : 0);
          if (len > SKILL_DESCRIPTION_LIMIT) {
            res.errors.push(`${where}: description + when_to_use — ${len} символів, ліміт ${SKILL_DESCRIPTION_LIMIT}`);
          }
        }
        if (fm.lineCount > SKILL_MAX_LINES) {
          res.errors.push(`${where}: ${fm.lineCount} рядків, ліміт ${SKILL_MAX_LINES} — деталі винесіть у references/`);
        }
      }
    }
    if (count === 0) res.notes.push('скілів поки немає');
    return res;
  },
};
