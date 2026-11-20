import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSemver, isSemver, minOfRange } from '../lib/semver.ts';

test('isSemver приймає коректні й відхиляє некоректні версії', () => {
  for (const v of ['0.1.0', '1.2.3', '10.20.30', '1.0.0-rc.1', '1.0.0+build.5']) assert.equal(isSemver(v), true, v);
  for (const v of ['banana', '1.2', '01.2.3', 'v1.2.3', '', 1, undefined]) assert.equal(isSemver(v), false, String(v));
});

test('compareSemver порівнює числово й ставить пре-реліз нижче за реліз', () => {
  assert.equal(compareSemver('1.10.0', '1.9.0'), 1);
  assert.equal(compareSemver('0.1.0', '0.1.0'), 0);
  assert.equal(compareSemver('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareSemver('2.1.289', '2.1.321'), -1);
});

test('minOfRange бере нижню межу з >=, ^, ~ і точної версії', () => {
  assert.equal(minOfRange('>=0.2.0'), '0.2.0');
  assert.equal(minOfRange('^1.0.0'), '1.0.0');
  assert.equal(minOfRange('~1.4.2'), '1.4.2');
  assert.equal(minOfRange('1.2.3'), '1.2.3');
  assert.equal(minOfRange('*'), null);
  assert.equal(minOfRange('>=1.0.0 <2.0.0'), null);
  assert.equal(minOfRange(undefined), null);
});
