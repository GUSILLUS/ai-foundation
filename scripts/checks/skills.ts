import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '../lib/frontmatter.ts';
import { KEBAB, listPluginDirs, rel, walkFiles } from '../lib/repo.ts';
import { emptyResult, type Check, type CheckResult } from '../lib/types.ts';

/** Ліміт Claude Code на description + when_to_use у списку скілів (ADR 0001, п. 7). */
export const SKILL_DESCRIPTION_LIMIT = 1536;
export const SKILL_MAX_LINES = 500;

export const skillsCheck: Check = {
  id: 'skills',
  title: 'Скіли: ліміти, імена, посилання, блоки коду',
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
        const folder = path.basename(path.dirname(file));
        if (name !== undefined && name !== folder) res.errors.push(`${where}: name "${name}" не збігається з текою "${folder}"`);
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
        const skillDir = path.dirname(file);
        for (const md of walkFiles(skillDir, (f) => f.endsWith('.md'))) checkMarkdown(root, skillDir, md, res);
      }
    }
    if (count === 0) res.notes.push('скілів поки немає');
    return res;
  },
};

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const MD_LINK = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
/** Шляхи до файлів скіла в бектиках: `references/x.md`, `scripts/run.ts`. */
const CODE_REF = /`((?:references|scripts|assets|examples|templates)\/[^`\s]+)`/g;

/**
 * Markdown-файл скіла: блоки коду закриті, посилання на файли скіла існують.
 * Посилання всередині блоків коду — приклади, їх не перевіряємо.
 */
export function checkMarkdown(root: string, skillDir: string, file: string, res: CheckResult): void {
  const where = rel(root, file);
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  let open: { char: string; len: number; line: number } | null = null;
  lines.forEach((line, i) => {
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] as string;
      if (!open) {
        open = { char: marker[0] as string, len: marker.length, line: i + 1 };
        return;
      }
      if (marker[0] === open.char && marker.length >= open.len && (fence[2] ?? '').trim() === '') {
        open = null;
        return;
      }
    }
    if (open) return;
    const targets = [...line.matchAll(MD_LINK)].map((m) => ({ ref: m[1] as string, base: path.dirname(file) }));
    targets.push(...[...line.matchAll(CODE_REF)].map((m) => ({ ref: m[1] as string, base: skillDir })));
    for (const { ref, base } of targets) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('#') || ref.includes('${')) continue;
      const target = decodeURI(ref.split('#')[0] as string);
      if (!target) continue;
      if (!existsSync(path.resolve(base, target))) res.errors.push(`${where}:${i + 1}: посилання на неіснуючий файл ${target}`);
    }
  });
  if (open) res.errors.push(`${where}:${(open as { line: number }).line}: незакритий блок коду`);
}

