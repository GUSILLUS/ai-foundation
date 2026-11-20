import path from 'node:path';
import { listPluginDirs, walkFiles } from './repo.ts';

/** Усі тести репозиторію: scripts/tests і plugins/<плагін>/tests, файли *.test.ts. */
export function findTestFiles(root: string): string[] {
  const isTest = (f: string) => f.endsWith('.test.ts');
  return [
    ...walkFiles(path.join(root, 'scripts', 'tests'), isTest),
    ...listPluginDirs(root).flatMap((p) => walkFiles(path.join(root, 'plugins', p, 'tests'), isTest)),
  ];
}
