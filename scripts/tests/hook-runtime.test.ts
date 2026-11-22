import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { processHook, type HookHandler } from '../../shared/hook-runtime.ts';

const pre = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/fixtures/a.txt' } });
const parse = (s: string) => JSON.parse(s) as Record<string, any>;

test('pass — без виводу й з кодом 0', async () => {
  const r = await processHook('t', pre, () => ({ kind: 'pass' }));
  assert.deepEqual(r, { code: 0, stdout: '' });
});

test('deny для PreToolUse — JSON-рішення з причиною, код 0', async () => {
  const r = await processHook('t', pre, () => ({ kind: 'deny', reason: 'ні' }));
  assert.equal(r.code, 0);
  assert.deepEqual(parse(r.stdout).hookSpecificOutput, {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: '[t] ні',
  });
});

test('deny для іншої події деградує, а не блокує', async () => {
  const r = await processHook('t', JSON.stringify({ hook_event_name: 'PostToolUse' }), () => ({ kind: 'deny', reason: 'x' }));
  assert.equal(r.code, 0);
  assert.match(parse(r.stdout).systemMessage, /перевірку пропущено/);
});

for (const [label, raw] of [
  ['зламаний JSON', '{"hook_event_name": '],
  ['порожній вхід', ''],
  ['масив замість об’єкта', '[]'],
  ['рядок замість об’єкта', '"text"'],
] as const) {
  test(`деградація: ${label} → код 0 і повідомлення`, async () => {
    const handler: HookHandler = () => assert.fail('обробник не має викликатися');
    const r = await processHook('t', raw, handler);
    assert.equal(r.code, 0);
    assert.match(parse(r.stdout).systemMessage, /^\[t\] перевірку пропущено/);
  });
}

test('виняток в обробнику → деградація без тексту винятку', async () => {
  const r = await processHook('t', pre, () => {
    throw new Error('secret-value-in-message');
  });
  assert.equal(r.code, 0);
  assert.match(parse(r.stdout).systemMessage, /внутрішня помилка \(Error\)/);
  assert.ok(!r.stdout.includes('secret-value-in-message'));
});

describe('context', () => {
  const start = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' });

  test('SessionStart — additionalContext і рядок користувачу', async () => {
    const r = await processHook('t', start, () => ({ kind: 'context', text: 'правила', notice: 'картки немає' }));
    assert.deepEqual(parse(r.stdout), {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'правила' },
      systemMessage: '[t] картки немає',
    });
  });

  test('порожній контекст — без виводу', async () => {
    const r = await processHook('t', start, () => ({ kind: 'context', text: '' }));
    assert.equal(r.stdout, '');
  });

  test('лише рядок користувачу — для будь-якої події', async () => {
    const stop = JSON.stringify({ hook_event_name: 'Stop' });
    const r = await processHook('t', stop, () => ({ kind: 'context', text: '', notice: 'є кандидати' }));
    assert.deepEqual(parse(r.stdout), { systemMessage: '[t] є кандидати' });
  });

  test('контекст для PreToolUse деградує', async () => {
    const r = await processHook('t', pre, () => ({ kind: 'context', text: 'x' }));
    assert.match(parse(r.stdout).systemMessage, /контекст підтримується лише/);
  });
});

