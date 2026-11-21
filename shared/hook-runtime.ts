/**
 * Спільна обв'язка command-хуків AI Foundation.
 *
 * Канонічне джерело — shared/hook-runtime.ts; копії в plugins/<плагін>/lib/shared/
 * створює `npm run sync`. Редагувати лише канонічний файл.
 *
 * Правила (CLAUDE.md, «Архітектурні правила»):
 * - хук, що не може виконати перевірку, деградує: код 0 і повідомлення користувачу, дія не блокується;
 * - exit 2 не використовуємо — блокування лише свідоме, через JSON-рішення;
 * - вхід хука ніколи не виводиться: у ньому можуть бути вміст файлів і секрети.
 */

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  [key: string]: unknown;
}

export type HookOutcome =
  /** Нічого не робити: звичайний потік дозволів Claude Code. */
  | { kind: 'pass' }
  /** Свідомо заблокувати виклик інструмента (PreToolUse); причину бачить Claude. */
  | { kind: 'deny'; reason: string }
  /** Перевірку виконати неможливо: дія триває, користувач бачить попередження. */
  | { kind: 'degrade'; reason: string }
  /**
   * Додати текст у контекст агента (SessionStart, UserPromptSubmit); `notice` — один рядок користувачу.
   * Порожній текст без notice — те саме, що pass.
   */
  | { kind: 'context'; text: string; notice?: string };

/** Події, для яких Claude Code приймає additionalContext від command-хука. */
export const CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);

export interface HookResponse {
  code: number;
  stdout: string;
}

export type HookHandler = (input: HookInput) => HookOutcome | Promise<HookOutcome>;

/**
 * Чиста частина хука: сирий stdin → відповідь. Будь-яка помилка перетворюється на деградацію,
 * тож код виходу завжди 0.
 */
export async function processHook(name: string, raw: string, handler: HookHandler): Promise<HookResponse> {
  let input: unknown;
  try {
    input = raw.trim() === '' ? undefined : JSON.parse(raw);
  } catch {
    return degrade(name, 'вхід хука — невалідний JSON');
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return degrade(name, 'вхід хука порожній або має невідому структуру');
  }

  let outcome: HookOutcome;
  try {
    outcome = await handler(input as HookInput);
  } catch (e) {
    return degrade(name, `внутрішня помилка (${e instanceof Error ? e.name : 'невідома'})`);
  }

  switch (outcome.kind) {
    case 'pass':
      return { code: 0, stdout: '' };
    case 'degrade':
      return degrade(name, outcome.reason);
    case 'context': {
      const event = (input as HookInput).hook_event_name;
      if (typeof event !== 'string' || !CONTEXT_EVENTS.has(event)) {
        return degrade(name, `контекст підтримується лише для ${[...CONTEXT_EVENTS].join(', ')}, отримано ${String(event)}`);
      }
      if (!outcome.text && !outcome.notice) return { code: 0, stdout: '' };
      const out: Record<string, unknown> = {};
      if (outcome.text) out.hookSpecificOutput = { hookEventName: event, additionalContext: outcome.text };
      if (outcome.notice) out.systemMessage = `[${name}] ${outcome.notice}`;
      return { code: 0, stdout: JSON.stringify(out) };
    }
    case 'deny': {
      const event = (input as HookInput).hook_event_name;
      if (event !== 'PreToolUse') return degrade(name, `блокування підтримується лише для PreToolUse, отримано ${String(event)}`);
      return {
        code: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            // Ім'я хука в причині — щоб аналізатор історії знав, який бар'єр відмовив (урок L2 roadmap друга).
            permissionDecisionReason: `[${name}] ${outcome.reason}`,
          },
        }),
      };
    }
  }
}

function degrade(name: string, reason: string): HookResponse {
  return { code: 0, stdout: JSON.stringify({ systemMessage: `[${name}] перевірку пропущено: ${reason}` }) };
}

/** Точка входу хука: читає stdin, викликає обробник, друкує відповідь і завершує процес. */
export async function runHook(name: string, handler: HookHandler): Promise<never> {
  const raw = process.stdin.isTTY ? '' : await readStdin();
  const res = await processHook(name, raw, handler);
  if (res.stdout) process.stdout.write(res.stdout + '\n');
  process.exit(res.code);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
