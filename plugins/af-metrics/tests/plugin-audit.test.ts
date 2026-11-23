import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildAudit, decide, formatAudit, THRESHOLDS, type Unit } from '../lib/audit.ts';
import { collectInstalled, parseYamlFrontmatter } from '../lib/audit-inventory.ts';
import { collectUsage, textLength } from '../lib/audit-usage.ts';
import { findTranscriptFiles } from '../lib/transcripts.ts';

/**
 * Усе синтетичне й генерується в тимчасовій теці: installPath у installed_plugins.json
 * мусить бути абсолютним, а реальних шляхів у фікстурах git ми не тримаємо.
 */

const CLI = path.join(import.meta.dirname, '..', 'scripts', 'plugin-audit.ts');
const SENTINEL = 'zz-sentinel-value-0000';
const CLIENT_PATH = '/fixtures/client-zz/project-zz';
const NOW = new Date('2026-11-23T12:00:00.000Z');
const SINCE = '2026-10-24T12:00:00.000Z';

const root = mkdtempSync(path.join(tmpdir(), 'af-audit-'));
after(() => rmSync(root, { recursive: true, force: true }));

function write(file: string, content: string | object): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

function skillMd(name: string, description: string, extra = '', body = 'Body.'): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`;
}

/** Повний синтетичний ~/.claude: плагіни, особисті скіли, MCP, транскрипти. */
function makeConfig(dir: string): { config: string; claudeJson: string } {
  const config = path.join(dir, '.claude');
  const plugins = path.join(dir, 'installed');

  // alpha: два скіли (один використовується), агент, MCP-сервер, хуки SessionStart і PreToolUse, згадка субагентів.
  const alpha = path.join(plugins, 'alpha');
  write(path.join(alpha, '.claude-plugin', 'plugin.json'), { name: 'alpha', version: '1.2.0' });
  write(path.join(alpha, 'skills', 'used-skill', 'SKILL.md'), skillMd('used-skill', 'Does a thing.'));
  write(path.join(alpha, 'skills', 'idle-skill', 'SKILL.md'), skillMd('idle-skill', '>\n  Folded\n  description.', '', 'Dispatch parallel agents for each task.'));
  write(path.join(alpha, 'agents', 'helper.md'), '---\nname: helper\ndescription: Helps.\n---\n');
  write(path.join(alpha, '.mcp.json'), { mcpServers: { tracker: { command: 'node', env: { TOKEN: SENTINEL } } } });
  write(path.join(alpha, 'hooks', 'hooks.json'), { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node' }] }], PreToolUse: [{ matcher: 'Read|Grep', hooks: [] }] } });

  // beta: лише команда, використана слешем; хуки на Stop — з шляху в маніфесті.
  const beta = path.join(plugins, 'beta');
  write(path.join(beta, '.claude-plugin', 'plugin.json'), { name: 'beta', version: '0.1.0', hooks: './extra-hooks.json' });
  write(path.join(beta, 'commands', 'cmd.md'), '---\ndescription: A command.\n---\n');
  write(path.join(beta, 'extra-hooks.json'), { hooks: { Stop: [{ hooks: [] }] } });

  // gamma: вимкнений. hooksonly: лише хук. ghost: тека не існує. af-controls: наш, лише хук.
  const gamma = path.join(plugins, 'gamma');
  write(path.join(gamma, 'skills', 'used-skill', 'SKILL.md'), skillMd('used-skill', 'Same short name as alpha.'));
  const hooksonly = path.join(plugins, 'hooksonly');
  write(path.join(hooksonly, 'hooks', 'hooks.json'), { hooks: { PostToolUse: [{ matcher: '*', hooks: [] }] } });
  const ours = path.join(plugins, 'af-controls');
  write(path.join(ours, 'hooks', 'hooks.json'), { hooks: { PreToolUse: [{ matcher: 'Read|Edit|Write', hooks: [] }] } });

  const entry = (p: string, version: string) => [{ scope: 'user', installPath: p, version, installedAt: '2026-10-01T00:00:00.000Z', lastUpdated: '2026-11-01T00:00:00.000Z' }];
  write(path.join(config, 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'alpha@mkt': entry(alpha, '1.2.0'),
      'beta@mkt': entry(beta, '0.1.0'),
      'gamma@mkt': entry(gamma, '2.0.0'),
      'hooksonly@mkt': entry(hooksonly, '1.0.0'),
      'ghost@mkt': entry(path.join(plugins, 'missing'), '1.0.0'),
      'af-controls@ai-foundation': entry(ours, '0.1.3'),
    },
  });
  write(path.join(config, 'settings.json'), { enabledPlugins: { 'alpha@mkt': true, 'beta@mkt': true, 'gamma@mkt': false, 'hooksonly@mkt': true, 'af-controls@ai-foundation': true } });

  // Особисті: скіл з disable-model-invocation (не в списку) і скіл без використань у вікні.
  write(path.join(config, 'skills', 'mine', 'SKILL.md'), skillMd('mine', 'Personal.', 'disable-model-invocation: true\n'));
  write(path.join(config, 'skills', 'unused-mine', 'SKILL.md'), skillMd('unused-mine', 'Personal unused.'));

  const claudeJson = path.join(dir, '.claude.json');
  write(claudeJson, {
    mcpServers: { docs: { type: 'http', url: 'https://fixtures.invalid', headers: { Authorization: SENTINEL } } },
    projects: { [CLIENT_PATH]: { mcpServers: { docs: { command: 'x' }, localdb: { command: 'y', env: { PASS: SENTINEL } } } } },
  });

  // Транскрипти: стара сесія (поза вікном 30 днів) і нова.
  const s1 = '00000000-0000-4000-8000-00000000a001';
  const s2 = '00000000-0000-4000-8000-00000000a002';
  let n = 0;
  const rec = (session: string, ts: string, type: string, extra: object) =>
    JSON.stringify({ type, uuid: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, sessionId: session, timestamp: ts, version: '2.1.321', cwd: '/fixtures/project-a', ...extra });
  const toolUse = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input });
  const old = [
    rec(s1, '2026-09-01T10:00:00.000Z', 'user', { origin: { kind: 'human' }, message: { role: 'user', content: '<fixture>' } }),
    rec(s1, '2026-09-01T10:00:01.000Z', 'assistant', { message: { id: 'm-old', model: 'm', content: [toolUse('t-old', 'Skill', { skill: 'unused-mine' })] } }),
  ];
  const fresh = [
    rec(s2, '2026-11-20T10:00:00.000Z', 'attachment', { attachment: { type: 'skill_listing', content: 'x'.repeat(300), skillCount: 3 } }),
    rec(s2, '2026-11-20T10:00:00.000Z', 'attachment', { attachment: { type: 'hook_additional_context', hookEvent: 'SessionStart', hookName: 'SessionStart:startup', content: ['y'.repeat(120)] } }),
    rec(s2, '2026-11-20T10:00:00.000Z', 'attachment', { attachment: { type: 'mcp_instructions_delta', addedNames: ['plugin:alpha:tracker'], addedBlocks: ['z'.repeat(2500)] } }),
    rec(s2, '2026-11-20T10:00:01.000Z', 'user', { origin: { kind: 'human' }, message: { role: 'user', content: '<command-name>/beta:cmd</command-name>' } }),
    rec(s2, '2026-11-20T10:00:02.000Z', 'assistant', {
      message: {
        id: 'm1',
        model: 'm',
        content: [
          toolUse('t1', 'Skill', { skill: 'alpha:used-skill' }),
          toolUse('t2', 'mcp__plugin_alpha_tracker__get', {}),
          toolUse('t3', 'mcp__plugin_alpha_tracker__get', {}),
          toolUse('t4', 'mcp__docs__search', {}),
          toolUse('t5', 'Agent', { subagent_type: 'alpha:helper' }),
          toolUse('t6', 'Read', { file_path: '/fixtures/project-a/.env' }),
        ],
      },
    }),
    rec(s2, '2026-11-20T10:00:03.000Z', 'user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: '<fixture>' }] } }),
    rec(s2, '2026-11-20T10:00:04.000Z', 'user', {
      permissionDecision: { decision: 'reject', source: 'hook', reasonCode: 'hook:PreToolUse' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't6', is_error: true, content: '[af-controls/env-guard] denied' }] },
    }),
  ];
  write(path.join(config, 'projects', '-fixtures-project-a', `${s1}.jsonl`), old.join('\n') + '\n');
  write(path.join(config, 'projects', '-fixtures-project-a', `${s2}.jsonl`), fresh.join('\n') + '\n');
  return { config, claudeJson };
}

const full = makeConfig(path.join(root, 'full'));
const files = findTranscriptFiles(full.config);
const projects = path.join(full.config, 'projects');

describe('інвентар', () => {
  const inst = collectInstalled({ configDir: full.config, claudeJson: full.claudeJson });
  const byId = (id: string) => inst.sources.find((s) => s.id === id);

  test('плагіни: компоненти, хуки, MCP і версії', () => {
    const alpha = byId('alpha@mkt');
    assert.ok(alpha);
    assert.deepEqual(alpha.skills.map((s) => s.name).sort(), ['idle-skill', 'used-skill']);
    assert.deepEqual(alpha.agents.map((a) => a.name), ['helper']);
    assert.deepEqual(alpha.mcpServers, ['tracker']);
    assert.deepEqual(alpha.hooks.map((h) => `${h.event}:${h.matcher}`).sort(), ['PreToolUse:Read|Grep', 'SessionStart:*']);
    assert.equal(alpha.version, '1.2.0');
    assert.equal(alpha.enabled, true);
    assert.equal(alpha.skills.find((s) => s.name === 'idle-skill')?.mentionsSubagents, true);
    assert.deepEqual(byId('beta@mkt')?.hooks.map((h) => h.event), ['Stop']);
    assert.deepEqual(byId('beta@mkt')?.commands.map((c) => c.name), ['cmd']);
    assert.equal(byId('gamma@mkt')?.enabled, false);
    assert.deepEqual(byId('ghost@mkt')?.problems, ['тека встановлення не знайдена']);
  });

  test('особисті скіли: disable-model-invocation не додає символів у список', () => {
    const personal = byId('personal');
    assert.equal(personal?.skills.find((s) => s.name === 'mine')?.listingChars, 0);
    assert.ok((personal?.skills.find((s) => s.name === 'unused-mine')?.listingChars ?? 0) > 0);
  });

  test('MCP із ~/.claude.json: лише імена й рівні, без env, заголовків і шляхів проєктів', () => {
    assert.equal(byId('docs')?.scope, 'user,local');
    assert.equal(byId('localdb')?.scope, 'local');
    const dump = JSON.stringify(inst);
    assert.ok(!dump.includes(SENTINEL));
    assert.ok(!dump.includes(CLIENT_PATH));
    assert.ok(!dump.includes('fixtures.invalid'));
  });
});

describe('використання', () => {
  test('вікно відсікає старі сесії', async () => {
    const u = await collectUsage(files, projects, SINCE);
    assert.equal(u.sessions, 1);
    assert.equal(u.skills['unused-mine'], undefined);
    const all = await collectUsage(files, projects);
    assert.equal(all.sessions, 2);
    assert.equal(all.skills['unused-mine'], 1);
  });

  test('скіли, агенти, MCP з помилками, слеш-команди, відмови наших хуків', async () => {
    const u = await collectUsage(files, projects, SINCE);
    assert.equal(u.skills['alpha:used-skill'], 1);
    assert.equal(u.agents['alpha:helper'], 1);
    assert.equal(u.mcpCalls['mcp__plugin_alpha_tracker'], 2);
    assert.equal(u.mcpErrors['mcp__plugin_alpha_tracker'], 1);
    assert.equal(u.mcpCalls['mcp__docs'], 1);
    assert.equal(u.commands['beta:cmd'], 1);
    assert.equal(u.hookRejections['af-controls'], 1);
  });

  test('контекст старту з транскрипту — лише довжини', async () => {
    const u = await collectUsage(files, projects, SINCE);
    assert.deepEqual(u.skillListingChars, { sessions: 1, avg: 300 });
    assert.deepEqual(u.hookContext['SessionStart:startup'], { sessions: 1, avgChars: 120 });
    assert.deepEqual(u.mcpInstructions['plugin:alpha:tracker'], { sessions: 1, avgChars: 2500 });
  });

  test('textLength: рядки, масиви, блоки', () => {
    assert.equal(textLength('abc'), 3);
    assert.equal(textLength(['ab', { text: 'cde' }, { content: [{ text: 'f' }] }]), 6);
    assert.equal(textLength(42), 0);
  });
});

describe('вердикти', async () => {
  const inst = collectInstalled({ configDir: full.config, claudeJson: full.claudeJson });
  const usage = await collectUsage(files, projects, SINCE);
  const report = buildAudit(inst, usage, { since: SINCE, now: NOW, analyzer: 'test' });
  const unit = (id: string) => report.units.find((u) => u.id === id) as Unit;

  test('вікно в днях від since', () => {
    assert.equal(report.window.days, 30);
  });

  test('використаний плагін з конфліктами — переглянути, з переліком причин', () => {
    const a = unit('alpha@mkt');
    assert.equal(a.uses, 4); // скіл, агент, 2 виклики MCP
    assert.deepEqual(a.usedParts, { 'skill:used-skill': 1, 'agent:helper': 1, 'mcp:tracker': 2 });
    assert.deepEqual(a.unusedParts, ['skill:idle-skill']);
    assert.ok(a.startupChars >= 2500, 'інструкції MCP враховано');
    assert.equal(a.verdict, 'переглянути');
    assert.ok(a.conflicts.some((c) => c.startsWith('хук SessionStart')));
    assert.ok(a.conflicts.some((c) => c.includes('env-guard')), 'PreToolUse на Read перетинається з env-guard');
    assert.ok(a.conflicts.some((c) => c.includes('субагентів')));
    assert.ok(a.conflicts.some((c) => c.includes('скіл «used-skill» є також у: gamma')));
  });

  test('beta: команда використана, Stop не конфліктує — лишити', () => {
    assert.equal(unit('beta@mkt').uses, 1);
    assert.equal(unit('beta@mkt').verdict, 'лишити');
  });

  test('вимкнений і порожній — переглянути', () => {
    assert.equal(unit('gamma@mkt').verdict, 'переглянути');
    assert.equal(unit('gamma@mkt').reason, 'вимкнено, але встановлено');
    assert.equal(unit('ghost@mkt').verdict, 'переглянути');
    assert.match(unit('ghost@mkt').reason, /компонентів не знайдено; не прочитано: тека встановлення не знайдена/);
  });

  test('сторонній плагін лише з хуками без конфліктів — лишити', () => {
    assert.equal(unit('hooksonly@mkt').verdict, 'лишити');
    assert.match(unit('hooksonly@mkt').reason, /лише хуки/);
  });

  test('особистий скіл без використань за 30 днів — прибрати, з шляхом для перенесення', () => {
    const u = unit('personal:skill:unused-mine');
    assert.equal(u.verdict, 'прибрати');
    assert.match(u.removeCommand ?? '', /~\/\.claude\/skills\/unused-mine\//);
  });

  test('наш плагін лише з хуками — лишити, з відмовами', () => {
    const u = unit('af-controls@ai-foundation');
    assert.equal(u.own, true);
    assert.equal(u.verdict, 'лишити');
    assert.match(u.reason, /відмов хуків: 1/);
  });

  test('окремий MCP: виклики рахуються, команда видалення за рівнями', () => {
    assert.equal(unit('docs').uses, 1);
    assert.equal(unit('docs').verdict, 'лишити');
    assert.equal(unit('localdb').verdict, 'прибрати');
    assert.equal(unit('localdb').removeCommand, 'claude mcp remove localdb -s local (у теці проєкту)');
  });

  test('звіт без секретів і шляхів клієнта; команди видалення лише для «прибрати»', () => {
    const md = formatAudit(report);
    const json = JSON.stringify(report);
    for (const s of [md, json]) {
      assert.ok(!s.includes(SENTINEL));
      assert.ok(!s.includes(CLIENT_PATH));
      assert.ok(!s.includes(root));
    }
    assert.match(md, /## Команди для видалення/);
    assert.match(md, /claude mcp remove localdb -s local/);
    assert.ok(!md.includes('claude plugin uninstall beta@mkt'));
  });
});

describe('правила decide', () => {
  const base = (over: Partial<Unit> = {}): Unit => ({
    kind: 'plugin',
    id: 'p@m',
    name: 'p',
    version: null,
    enabled: true,
    own: false,
    parts: { skills: 1, agents: 0, commands: 0, mcpServers: 0, hooks: 0 },
    uses: 0,
    usedParts: {},
    unusedParts: [],
    mcpCalls: 0,
    mcpErrors: 0,
    hookRejections: 0,
    startupChars: 100,
    hookEvents: [],
    conflicts: [],
    verdict: 'лишити',
    reason: '',
    removeCommand: null,
    ...over,
  });

  test('коротке вікно не радить «прибрати»', () => {
    const u = base();
    decide(u, THRESHOLDS.minWindowDays - 1);
    assert.equal(u.verdict, 'переглянути');
    decide(u, THRESHOLDS.minWindowDays);
    assert.equal(u.verdict, 'прибрати');
  });

  test('наш невикористаний плагін — переглянути, не прибрати', () => {
    const u = base({ own: true });
    decide(u, 60);
    assert.equal(u.verdict, 'переглянути');
  });

  test('помилки MCP від порогу', () => {
    const mcp = { skills: 0, agents: 0, commands: 0, mcpServers: 1, hooks: 0 };
    const u = base({ uses: 10, mcpCalls: 10, mcpErrors: 5, parts: mcp });
    decide(u, 30);
    assert.equal(u.verdict, 'переглянути');
    assert.match(u.reason, /помилки MCP: 5 з 10/);
    const ok = base({ uses: 10, mcpCalls: 10, mcpErrors: 4, parts: mcp });
    decide(ok, 30);
    assert.equal(ok.verdict, 'лишити');
  });

  test('рідко й дорого — переглянути', () => {
    const u = base({ uses: THRESHOLDS.rareUses, startupChars: THRESHOLDS.expensiveChars });
    decide(u, 30);
    assert.equal(u.verdict, 'переглянути');
    assert.match(u.reason, /^рідко/);
  });
});

describe('frontmatter', () => {
  test('блокові скаляри й лапки', () => {
    const fm = parseYamlFrontmatter('---\nname: "x"\ndescription: |\n  line one\n  line two\nwhen_to_use: >-\n  folded\n  text\nother: plain\n---\nbody');
    assert.deepEqual(fm, { name: 'x', description: 'line one\nline two', when_to_use: 'folded text', other: 'plain' });
  });

  test('без frontmatter — порожньо', () => {
    assert.deepEqual(parseYamlFrontmatter('# title'), {});
  });
});

describe('CLI і деградація', () => {
  const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

  test('--print з --all: звіт без запису файлів', () => {
    const r = run(['--all', '--print', '--config-dir', full.config, '--claude-json', full.claudeJson]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /# Аудит плагінів/);
    assert.match(r.stdout, /усі наявні транскрипти/);
  });

  test('запис звіту в --out', () => {
    const out = path.join(root, 'out');
    const r = run(['--days', '30', '--out', out, '--config-dir', full.config, '--claude-json', full.claudeJson]);
    assert.equal(r.status, 0, r.stderr);
    const name = r.stdout.match(/plugin-audit-\d{4}-\d{2}-\d{2}/)?.[0];
    assert.ok(name);
    assert.ok(JSON.parse(readFileSync(path.join(out, `${name}.json`), 'utf8')).units.length > 0);
  });

  test('неправильні прапорці — код 2', () => {
    assert.equal(run(['--all', '--days', '5']).status, 2);
    assert.equal(run(['--since', '2026-13-45']).status, 2);
    assert.equal(run(['--days', '0']).status, 2);
  });

  test('порожня тека Claude Code — звіт без падіння, діагностика', () => {
    const empty = path.join(root, 'empty');
    mkdirSync(empty, { recursive: true });
    const r = run(['--print', '--config-dir', empty, '--claude-json', path.join(empty, 'none.json')]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Не знайдено: .*installed_plugins\.json/);
  });

  test('зламаний JSON — діагностика, не падіння', () => {
    const broken = path.join(root, 'broken');
    write(path.join(broken, 'plugins', 'installed_plugins.json'), '{not json');
    write(path.join(broken, 'settings.json'), '[]');
    const r = run(['--print', '--config-dir', broken, '--claude-json', path.join(broken, 'none.json')]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /installed_plugins\.json: не розбирається як JSON/);
  });
});
