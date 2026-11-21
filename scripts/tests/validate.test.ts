import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeBin } from '../checks/claude.ts';
import { run } from '../lib/proc.ts';
import { makeFakeRepo, runValidate, type FakeRepo } from './helpers/fake-repo.ts';

/** Наші перевірки, які не потребують Claude Code, node_modules чи вкладених тестів. */
const OWN = ['--only', 'manifests,skills,budget,hooks,secrets,fixtures'];

let repo: FakeRepo;
beforeEach(() => {
  repo = makeFakeRepo();
});
afterEach(() => repo.cleanup());

function expectFail(fragment: string | RegExp): void {
  const r = runValidate(repo.root, OWN);
  assert.equal(r.code, 1, `очікувався код 1, вивід:\n${r.out}`);
  if (typeof fragment === 'string') assert.ok(r.out.includes(fragment), `немає "${fragment}" у виводі:\n${r.out}`);
  else assert.match(r.out, fragment);
}

test('чистий синтетичний репозиторій проходить наші перевірки', () => {
  const r = runValidate(repo.root, OWN);
  assert.equal(r.code, 0, r.out);
});

describe('маніфести', () => {
  test('зламаний JSON у plugin.json', () => {
    repo.write('plugins/af-core/.claude-plugin/plugin.json', '{ "name": "af-core", ');
    expectFail('plugins/af-core/.claude-plugin/plugin.json: невалідний JSON');
  });

  test('версія не semver', () => {
    repo.write('plugins/af-core/.claude-plugin/plugin.json', { name: 'af-core', version: 'banana', license: 'MIT', description: 'x' });
    expectFail('не semver');
  });

  test('ім’я не збігається з папкою', () => {
    repo.write('plugins/af-core/.claude-plugin/plugin.json', { name: 'af-kernel', version: '0.1.0', license: 'MIT', description: 'x' });
    expectFail('не збігається з назвою папки');
  });

  test('версія в записі маркетплейсу', () => {
    repo.write('.claude-plugin/marketplace.json', {
      name: 'fake-market',
      owner: { name: 'T' },
      plugins: [
        { name: 'af-core', source: './plugins/af-core', version: '0.1.0', description: 'c' },
        { name: 'af-metrics', source: './plugins/af-metrics', description: 'm' },
      ],
    });
    expectFail('version задається лише в plugin.json');
  });

  test('папка плагіна без запису в маркетплейсі', () => {
    repo.write('plugins/af-extra/.claude-plugin/plugin.json', { name: 'af-extra', version: '0.1.0', license: 'MIT', description: 'x' });
    expectFail('plugins/af-extra: немає запису');
  });

  test('ім’я без префікса af-', () => {
    repo.write('plugins/core/.claude-plugin/plugin.json', { name: 'core', version: '0.1.0', license: 'MIT', description: 'x' });
    expectFail('має починатися з "af-"');
  });

  test('зворотний слеш у шляху', () => {
    repo.write('plugins/af-core/.claude-plugin/plugin.json', {
      name: 'af-core', version: '0.1.0', license: 'MIT', description: 'x', skills: ['.\\extra'],
    });
    expectFail('зворотний слеш у skills[0]');
  });
});

describe('залежності між плагінами', () => {
  const metrics = (deps: unknown) => ({ name: 'af-metrics', version: '0.1.0', license: 'MIT', description: 'x', dependencies: deps });

  test('af-core не може мати залежностей', () => {
    repo.write('plugins/af-core/.claude-plugin/plugin.json', {
      name: 'af-core', version: '0.1.0', license: 'MIT', description: 'x', dependencies: [{ name: 'af-metrics', version: '>=0.1.0' }],
    });
    expectFail('af-core ні від кого не залежить');
  });

  test('залежність без мінімальної версії', () => {
    repo.write('plugins/af-metrics/.claude-plugin/plugin.json', metrics(['af-core']));
    expectFail('вкажіть мінімальну версію');
  });

  test('мінімальна версія новіша за існуючу', () => {
    repo.write('plugins/af-metrics/.claude-plugin/plugin.json', metrics([{ name: 'af-core', version: '>=9.0.0' }]));
    expectFail('новіша за поточну af-core 0.1.0');
  });

  test('коректна залежність проходить', () => {
    repo.write('plugins/af-metrics/.claude-plugin/plugin.json', metrics([{ name: 'af-core', version: '>=0.1.0' }]));
    assert.equal(runValidate(repo.root, OWN).code, 0);
  });
});

describe('скіли', () => {
  test('опис довший за 1536 символів', () => {
    repo.write('plugins/af-core/skills/long/SKILL.md', `---\nname: long\ndescription: ${'a'.repeat(1600)}\n---\nBody\n`);
    expectFail(/1600 символів, ліміт 1536/);
  });

  test('скіл без frontmatter', () => {
    repo.write('plugins/af-core/skills/bare/SKILL.md', '# Bare\n');
    expectFail('бракує frontmatter');
  });

  test('коректний скіл проходить', () => {
    repo.write('plugins/af-core/skills/ok/SKILL.md', '---\nname: ok\ndescription: Short description\n---\nBody\n');
    assert.equal(runValidate(repo.root, OWN).code, 0);
  });

  test('name не збігається з текою', () => {
    repo.write('plugins/af-core/skills/folder/SKILL.md', '---\nname: other\ndescription: d\n---\nBody\n');
    expectFail('name "other" не збігається з текою "folder"');
  });

  test('посилання на неіснуючий файл — markdown і бектики', () => {
    repo.write('plugins/af-core/skills/refs/SKILL.md', '---\nname: refs\ndescription: d\n---\nДив. [гайд](references/guide.md).\n');
    expectFail('SKILL.md:5: посилання на неіснуючий файл references/guide.md');
    repo.write('plugins/af-core/skills/refs/SKILL.md', '---\nname: refs\ndescription: d\n---\nЗапусти `scripts/run.ts`.\n');
    expectFail('посилання на неіснуючий файл scripts/run.ts');
  });

  test('посилання в reference-файлі резолвиться від нього', () => {
    repo.write('plugins/af-core/skills/refs/SKILL.md', '---\nname: refs\ndescription: d\n---\n[гайд](references/guide.md)\n');
    repo.write('plugins/af-core/skills/refs/references/guide.md', '[назад](../SKILL.md), [вийде](missing.md)\n');
    expectFail('references/guide.md:1: посилання на неіснуючий файл missing.md');
  });

  test('незакритий блок коду', () => {
    repo.write('plugins/af-core/skills/fence/SKILL.md', '---\nname: fence\ndescription: d\n---\n```ts\nconst a = 1;\n');
    expectFail('SKILL.md:5: незакритий блок коду');
  });

  test('посилання всередині блоку коду, зовнішні й якорі не перевіряються', () => {
    repo.write(
      'plugins/af-core/skills/ok2/SKILL.md',
      '---\nname: ok2\ndescription: d\n---\n```md\n[x](references/none.md)\n```\n[doc](https://example.com) [a](#top) [p](${CLAUDE_SKILL_DIR}/x.md)\n',
    );
    assert.equal(runValidate(repo.root, OWN).code, 0, runValidate(repo.root, OWN).out);
  });
});

describe('бюджет контексту', () => {
  test('перевищення — попередження, не помилка', () => {
    repo.write('plugins/af-core/context/global-rules.md', 'x'.repeat(2_500));
    repo.write('plugins/af-core/templates/context.md', 'y'.repeat(8_000));
    const r = runValidate(repo.root, ['--only', 'budget']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /глобальні правила — 2500 символів, ліміт 2000/);
    assert.match(r.out, /шаблон картки проєкту — 8000 символів, ліміт 6000/);
    assert.match(r.out, /разом 10500 символів — більше за ліміт SessionStart 10000/);
  });

  test('у межах бюджету — без попереджень', () => {
    repo.write('plugins/af-core/context/global-rules.md', 'x'.repeat(1_000));
    const r = runValidate(repo.root, ['--only', 'budget']);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /⚠/);
    assert.match(r.out, /1000 \/ 10000 символів/);
  });
});

describe('хуки', () => {
  const hooks = (hook: object) => ({ hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', ...hook }] }] } });

  test('shell-форма заборонена', () => {
    repo.write('plugins/af-core/hooks/hooks.json', hooks({ command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/x.ts"', timeout: 5 }));
    expectFail('потрібна exec-форма');
  });

  test('без timeout', () => {
    repo.write('plugins/af-core/hooks/x.ts', 'export {};\n');
    repo.write('plugins/af-core/hooks/hooks.json', hooks({ command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/x.ts'] }));
    expectFail('потрібен явний timeout');
  });

  test('скрипт не існує', () => {
    repo.write('plugins/af-core/hooks/hooks.json', hooks({ command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/missing.ts'], timeout: 5 }));
    expectFail('файл hooks/missing.ts не існує');
  });

  test('коректний хук проходить', () => {
    repo.write('plugins/af-core/hooks/x.ts', 'export {};\n');
    repo.write('plugins/af-core/hooks/hooks.json', hooks({ command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/x.ts'], timeout: 5 }));
    assert.equal(runValidate(repo.root, OWN).code, 0);
  });
});

describe('секрети', () => {
  // Фальшиві значення збираємо під час виконання, щоб у репозиторії не було рядків, схожих на секрети.
  const fakeGithub = 'gh' + 'p_' + 'A1b2C3d4'.repeat(5);

  test('файл .env заборонений', () => {
    repo.write('.env', 'X=1\n');
    expectFail('.env: файл оточення');
  });

  test('токен у файлі знайдено, а значення не виведено', () => {
    repo.write('notes.md', `token here: ${fakeGithub}\n`);
    const r = runValidate(repo.root, OWN);
    assert.equal(r.code, 1, r.out);
    assert.ok(r.out.includes('notes.md:1: токен GitHub'), r.out);
    assert.ok(!r.out.includes(fakeGithub), 'значення секрету потрапило у вивід');
  });

  test('рядок з позначкою дозволу пропускається', () => {
    repo.write('notes.md', `example ${fakeGithub} af-validate:allow-secret\n`);
    assert.equal(runValidate(repo.root, OWN).code, 0);
  });
});

describe('фікстури', () => {
  const fx = 'plugins/af-core/tests/fixtures/';

  test('синтетичні значення проходять', () => {
    repo.write(`${fx}ok.json`, {
      session_id: '00000000-0000-4000-8000-000000000001',
      cwd: '/fixtures/project-a',
      win: 'C:\\fixtures\\project-a\\.env',
      rel: 'config/.env.local',
      timestamp: '2026-11-20T10:00:00.000Z',
      model: 'claude-opus-5-5',
      text: '<fixture>',
      tokens: 42,
    });
    repo.write(`${fx}ok.jsonl`, '{"type":"user","message":{"content":"<fixture>"}}\n{"type":"assistant"}\n');
    assert.equal(runValidate(repo.root, OWN).code, 0);
  });

  test('реальний шлях падає, а значення не виводиться', () => {
    const secretPath = ['', 'home', 'ivan', 'client-x', 'src', 'a.ts'].join('/');
    repo.write(`${fx}real.json`, { tool_input: { file_path: secretPath } });
    const r = runValidate(repo.root, OWN);
    assert.equal(r.code, 1, r.out);
    assert.ok(r.out.includes('real.json → tool_input.file_path: абсолютний шлях поза /fixtures/'), r.out);
    assert.ok(!r.out.includes('client-x'), 'значення потрапило у вивід');
  });

  test('Windows-шлях поза C:/fixtures падає', () => {
    repo.write(`${fx}win.json`, { cwd: 'D:\\Work\\client' });
    expectFail('win.json → cwd: абсолютний шлях поза /fixtures/');
  });

  test('e-mail падає', () => {
    repo.write(`${fx}mail.jsonl`, JSON.stringify({ userEmail: ['someone', 'example.com'].join('@') }) + '\n');
    expectFail('mail.jsonl:1 → userEmail: e-mail');
  });

  test('вільний текст замість заглушки падає', () => {
    repo.write(`${fx}text.json`, { message: { content: 'please refactor the billing module' } });
    expectFail('text.json → message.content: вільний текст');
  });
});

/** Пункт чеклиста етапу 1: validate падає на навмисно зламаному маніфесті — і через Claude Code теж. */
describe('claude plugin validate', () => {
  const v = run(claudeBin(), ['--version'], { cwd: process.cwd(), timeoutMs: 30_000 });
  const available = !v.error && v.code === 0;
  const opts = available ? {} : { skip: 'Claude Code CLI недоступний (у CI він встановлений)' };

  test('валідний репозиторій проходить', opts, () => {
    const r = runValidate(repo.root, ['--only', 'claude']);
    assert.equal(r.code, 0, r.out);
  });

  test('зламаний маніфест падає', opts, () => {
    repo.write('plugins/af-core/.claude-plugin/plugin.json', { name: 'af-core', version: '0.1.0', homepage: 'not a url' });
    const r = runValidate(repo.root, ['--only', 'claude']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /homepage/);
  });
});
