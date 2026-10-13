import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/security.js';

test('Bearer tokens are masked, keeping the scheme so the log line still makes sense', () => {
  assert.equal(redact('Authorization: Bearer abcdefghijklmnop1234567890'), 'Authorization: Bearer ***');
  assert.equal(redact('curl -H "Authorization: Bearer eyJhbGciOi.abc-def_ghi.jkl" https://x'), 'curl -H "Authorization: Bearer ***" https://x');
  assert.equal(redact('authorization: bearer abcdefgh12345678'), 'authorization: bearer ***');
});

test('x-api-key header values are masked, whatever the case of the header name', () => {
  assert.equal(redact('x-api-key: abcdef1234567890zzzz'), 'x-api-key: ***');
  assert.equal(redact('X-API-Key: abcdef1234567890zzzz'), 'X-API-Key: ***');
  assert.equal(redact('{"x-api-key":"abcdef1234567890zzzz"}'), '{"x-api-key":"***"}');
});

test('ordinary text and short words are left alone', () => {
  assert.equal(redact('the bearer of bad news'), 'the bearer of bad news');
  assert.equal(redact('Bearer of gifts'), 'Bearer of gifts');
  assert.equal(redact('x-api-key header is required'), 'x-api-key header is required');
});

test('the existing key formats are still masked', () => {
  assert.equal(redact(`token ghp_${'b'.repeat(30)}`), 'token ghp_***');
  assert.equal(redact(`sk-ant-${'a'.repeat(30)}`), 'sk-ant-***');
  assert.equal(redact(42), 42);
});
