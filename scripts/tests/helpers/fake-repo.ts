import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface FakeRepo {
  root: string;
  write: (rel: string, content: string | object) => void;
  cleanup: () => void;
}

/**
 * Мінімальний синтетичний репозиторій у тимчасовій папці: маркетплейс і два валідні плагіни.
 * Тести псують окремі файли й перевіряють, що validate це ловить.
 */
export function makeFakeRepo(): FakeRepo {
  const root = mkdtempSync(path.join(tmpdir(), 'af-validate-'));
  const write = (rel: string, content: string | object) => {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  };
  write('package.json', { name: 'fake', private: true, type: 'module', config: { claudeCodeVersion: '2.1.321' } });
  write('.claude-plugin/marketplace.json', {
    name: 'fake-market',
    owner: { name: 'Test' },
    description: 'test marketplace',
    plugins: [
      { name: 'af-core', source: './plugins/af-core', description: 'core' },
      { name: 'af-metrics', source: './plugins/af-metrics', description: 'metrics' },
    ],
  });
  for (const name of ['af-core', 'af-metrics']) {
    write(`plugins/${name}/.claude-plugin/plugin.json`, {
      name,
      version: '0.1.0',
      description: `${name} plugin`,
      author: { name: 'Test' },
      license: 'MIT',
    });
    write(`plugins/${name}/README.md`, `# ${name}\n`);
  }
  return { root, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export interface ValidateRun {
  code: number | null;
  out: string;
}

const VALIDATE = path.join(import.meta.dirname, '..', '..', 'validate.ts');

/** Запуск validate.ts на фейковому репо; тести самого репо всередині не запускаються. */
export function runValidate(root: string, args: string[] = []): ValidateRun {
  const r = spawnSync(process.execPath, [VALIDATE, '--root', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AF_VALIDATE_NESTED: '1' },
    timeout: 120_000,
  });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
