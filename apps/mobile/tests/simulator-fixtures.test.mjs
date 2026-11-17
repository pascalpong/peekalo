import assert from 'node:assert/strict';
import test from 'node:test';
import { allowSimulatorFixtures } from '../src/lib/simulator-fixtures.ts';

test('test input requires an explicit isolated iOS development simulator', () => {
  assert.equal(allowSimulatorFixtures(true, 'ios', false, 'true', 'true'), true);
  for (const input of [
    [false, 'ios', false, 'true', 'true'], [true, 'ios', true, 'true', 'true'],
    [true, 'android', false, 'true', 'true'], [true, 'web', false, 'true', 'true'],
    [true, 'ios', false, undefined, 'true'], [true, 'ios', false, 'true', undefined],
    [true, 'ios', false, 'false', 'true'], [true, 'ios', false, 'true', 'false'],
  ]) assert.equal(allowSimulatorFixtures(...input), false);
});
