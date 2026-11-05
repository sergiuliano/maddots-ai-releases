import assert from 'node:assert/strict';
import test from 'node:test';
import {parseJsonWithoutDuplicateKeys} from '../src/shared/strict-json.js';

test('strict JSON rejects duplicate keys at every depth, including escaped aliases', () => {
  for (const text of [
    '{"purpose":"diagnostic","purpose":"activation"}',
    '{"authorization":{"purpose":"diagnostic","pur\\u0070ose":"activation"}}',
    '{"authorization":{"acceptanceGrant":{"scopeVersion":1,"scopeVersion":2}}}',
    '[{"nested":[{"toolKey":"codex","toolKey":"opencode"}]}]',
    '{"\\uD83D\\uDE00":1,"😀":2}', '{"__proto__":1,"__proto__":2}',
  ]) assert.throws(() => parseJsonWithoutDuplicateKeys(text), {name: 'SyntaxError', message: 'Invalid JSON: duplicate object key.'});
});

test('strict JSON preserves valid JSON values and scopes key sets to each object', () => {
  const text = ' \t\r\n' + JSON.stringify({same: 1, objects: [{same: 2}, {same: 3}],
    values: [null, true, false, -0, 1.25, -1.2e+3, 'escaped"\\/\b\f\n\r\t\u0000😀'], '': {}, ['__proto__']: []}) + '\n';
  assert.deepEqual(parseJsonWithoutDuplicateKeys(text), JSON.parse(text));
  for (const primitive of ['null', 'true', 'false', '-0', '1e300', '1e400', '"\\ud800"', '[]', '{}']) {
    assert.deepEqual(parseJsonWithoutDuplicateKeys(primitive), JSON.parse(primitive));
  }
  const deep = '['.repeat(20_000) + '0' + ']'.repeat(20_000);
  let value = parseJsonWithoutDuplicateKeys(deep);
  for (let depth = 0; depth < 20_000; depth++) {assert(Array.isArray(value)); value = value[0];}
  assert.equal(value, 0);
});

test('strict JSON rejects invalid grammar with fixed errors that omit input', () => {
  for (const text of ['', ' ', 'undefined', 'NaN', '01', '1.', '1e', '+1', '[1,]', '{"x":1,}', '{x:1}',
    '{"x" 1}', '{"x":}', '{"x":1 "y":2}', '{"x":1}{}', '[}', '"\\x00"', '"\\u000"', '"private-sentinel', '"raw\nnewline"']) {
    assert.throws(() => parseJsonWithoutDuplicateKeys(text), {name: 'SyntaxError', message: 'Invalid JSON.'});
  }
});
