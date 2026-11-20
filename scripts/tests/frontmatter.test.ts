import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../lib/frontmatter.ts';

test('читає прості, лапкові й блокові значення', () => {
  const fm = parseFrontmatter(
    ['---', 'name: demo', 'description: "Says: hello"', 'when_to_use: >', '  first line', '  second line', 'allowed-tools:', '  - Read', '---', 'Body', ''].join('\n'),
  );
  assert.equal(fm.present, true);
  assert.equal(fm.fields.name, 'demo');
  assert.equal(fm.fields.description, 'Says: hello');
  assert.equal(fm.fields.when_to_use, 'first line second line');
  assert.equal(fm.lineCount, 10);
});

test('без відкриваючого чи закриваючого --- frontmatter відсутній', () => {
  assert.equal(parseFrontmatter('# Title\n').present, false);
  assert.equal(parseFrontmatter('---\nname: x\n').present, false);
});

test('CRLF не заважає розбору', () => {
  const fm = parseFrontmatter('---\r\nname: crlf\r\n---\r\nbody\r\n');
  assert.equal(fm.fields.name, 'crlf');
});
