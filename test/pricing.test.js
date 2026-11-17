import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceFor, normalizeModel, usageTokens, costOf, contextWindowFor } from '../src/pricing.js';
import { cfg } from './helpers.js';

test('model normalisation', () => {
  assert.equal(normalizeModel('claude-opus-5-5[1m]'), 'claude-opus-5-5');
  assert.equal(normalizeModel('us.anthropic.claude-sonnet-5-5'), 'claude-sonnet-5-5');
  assert.equal(normalizeModel('claude-opus-4-5@20251101'), 'claude-opus-4-5');
});

test('family matching picks the most specific row first', () => {
  assert.equal(priceFor('claude-opus-5-5', cfg).input, 4);
  assert.equal(priceFor('claude-opus-5', cfg).input, 5);
  assert.equal(priceFor('claude-fable-5-2', cfg).cacheWrite1h, 16);
  assert.equal(priceFor('claude-fable-5', cfg).cacheRead, 1);
  assert.equal(priceFor('claude-sonnet-5-5', cfg).cacheRead, 0.1);
  assert.equal(priceFor('claude-sonnet-4-6', cfg).input, 3);
  assert.equal(priceFor('claude-haiku-5-5', cfg).output, 0.5);
});

test('default cache-write multipliers are 1.25x (5m) and 2x (1h)', () => {
  const p = priceFor('claude-opus-5-5', cfg);
  assert.equal(p.cacheWrite5m, 5);
  assert.equal(p.cacheWrite1h, 8);
});

test('unknown models fall back and are flagged unpriced', () => {
  const p = priceFor('some-other-model', cfg);
  assert.equal(p.unpriced, true);
});

test('usage split into 5m / 1h cache writes', () => {
  const t = usageTokens({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 6, ephemeral_5m_input_tokens: 4 } });
  assert.deepEqual(t, { input: 1, output: 2, cacheRead: 3, cacheWrite5m: 4, cacheWrite1h: 6 });
  const t2 = usageTokens({ cache_creation_input_tokens: 10 });
  assert.equal(t2.cacheWrite5m, 10);
  assert.equal(t2.cacheWrite1h, 0);
});

test('cost math', () => {
  const p = priceFor('claude-opus-5-5', cfg);
  const c = costOf({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 }, p);
  assert.equal(Math.round(c * 100) / 100, 4 + 20 + 0.2 + 5 + 8);
});

test('context windows', () => {
  assert.equal(contextWindowFor('claude-opus-5-5', cfg), 1000000);
  assert.equal(contextWindowFor('claude-haiku-4-5', cfg), 200000);
  assert.equal(contextWindowFor('claude-sonnet-4-5', cfg), 200000);
});
