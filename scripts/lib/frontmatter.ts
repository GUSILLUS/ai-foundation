export interface Frontmatter {
  /** Чи є блок frontmatter (перший рядок `---` і закриваючий `---`). */
  present: boolean;
  /** Ключі верхнього рівня зі скалярними значеннями; списки й об’єкти — порожній рядок. */
  fields: Record<string, string>;
  /** Кількість рядків файлу разом із frontmatter. */
  lineCount: number;
}

/**
 * Мінімальний розбір YAML-frontmatter без залежностей: рядкові значення верхнього рівня,
 * лапки й блокові скаляри `|` / `>`. Синтаксичну коректність YAML перевіряє `claude plugin validate`.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const lineCount = text.endsWith('\n') ? lines.length - 1 : lines.length;
  const fields: Record<string, string> = {};
  if (lines[0]?.trim() !== '---') return { present: false, fields, lineCount };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return { present: false, fields, lineCount };

  const body = lines.slice(1, end);
  for (let i = 0; i < body.length; i++) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(body[i]!);
    if (!m) continue;
    const key = m[1]!;
    const raw = m[2]!.trim();
    if (/^[|>][+-]?$/.test(raw)) {
      const folded = raw.startsWith('>');
      const parts: string[] = [];
      while (i + 1 < body.length && (/^\s+\S/.test(body[i + 1]!) || body[i + 1]!.trim() === '')) {
        i++;
        parts.push(body[i]!.trim());
      }
      fields[key] = parts.join(folded ? ' ' : '\n').trim();
    } else {
      fields[key] = unquote(raw);
    }
  }
  return { present: true, fields, lineCount };
}

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}
