import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mapWithConcurrency, processItems } from '../app/application/process-batch.js';
import { loadConfig } from '../app/config.js';
import { classifyMode } from '../app/domain/modes/classify.js';
import { summarizeMode } from '../app/domain/modes/summarize.js';
import { createLogger } from '../app/infrastructure/logger.js';
import { createResultCache } from '../app/infrastructure/result-cache.js';

const config = loadConfig({});
const silent = createLogger({ level: 'ERROR', sink: () => {} });

/** Test double for the ModelProvider port: records calls, answers via `answer(item, attempt)`. */
function fakeProvider({ answer = (item) => `summary of ${item.id}`, batchSize = 10, ...overrides } = {}) {
  const calls = [];
  const attempts = new Map();
  return {
    calls,
    name: 'fake',
    batchSize,
    maxConcurrency: Infinity,
    pricing: { inputPerMTok: 1, outputPerMTok: 2 },
    modelId: () => 'fake-1',
    supports: () => true,
    async run(mode, items) {
      calls.push(items.map((i) => i.id));
      const results = new Map();
      for (const item of items) {
        const n = (attempts.get(item.id) ?? 0) + 1;
        attempts.set(item.id, n);
        const value = answer(item, n);
        if (value !== undefined) results.set(item.key, value);
      }
      return { results, usage: { inputTokens: 1000, outputTokens: 500 } };
    },
    ...overrides,
  };
}

const run = (items, provider, extra = {}) =>
  processItems({ items, mode: summarizeMode, provider, config, logger: silent, ...extra });

describe('processItems', () => {
  it('keeps input order and answers invalid items without calling the model', async () => {
    const provider = fakeProvider();
    const { results, stats } = await run(
      [{ id: 1, body: 'a' }, { id: 2, body: ' ' }, null, { id: 3, subject: 'c' }],
      provider,
    );
    assert.deepEqual(results, [
      { id: 1, summary: 'summary of 1' },
      { id: 2, error: 'empty_input' },
      { id: null, error: 'invalid_input' },
      { id: 3, summary: 'summary of 3' },
    ]);
    assert.deepEqual(provider.calls, [[1, 3]]);
    assert.deepEqual(stats.errors, { empty_input: 1, invalid_input: 1 });
  });

  it('sends identical texts to the model once and fans the result out', async () => {
    const provider = fakeProvider();
    const { results, stats } = await run(
      [{ id: 'a', body: 'same' }, { id: 'b', body: 'same' }, { id: 'c', body: 'other' }],
      provider,
    );
    assert.deepEqual(provider.calls, [['a', 'c']]);
    assert.equal(results[1].summary, 'summary of a');
    assert.equal(stats.duplicatesSkipped, 1);
  });

  it('serves repeated requests from the cache', async () => {
    const provider = fakeProvider();
    const cache = createResultCache(10);
    await run([{ id: 1, body: 'x' }], provider, { cache });
    const { stats } = await run([{ id: 1, body: 'x' }], provider, { cache });
    assert.equal(provider.calls.length, 1);
    assert.equal(stats.cacheHits, 1);
  });

  it('splits work into provider-sized batches', async () => {
    const provider = fakeProvider({ batchSize: 2 });
    await run([1, 2, 3, 4, 5].map((id) => ({ id, body: `t${id}` })), provider);
    assert.deepEqual(provider.calls, [[1, 2], [3, 4], [5]]);
  });

  it('retries only the items the model skipped, once', async () => {
    // Item 2 is missing in the first answer and present in the second.
    const provider = fakeProvider({ answer: (item, attempt) => (item.id === 2 && attempt === 1 ? undefined : `ok ${item.id}`) });
    const { results, stats } = await run([{ id: 1, body: 'a' }, { id: 2, body: 'b' }], provider);
    assert.deepEqual(provider.calls, [[1, 2], [2]]);
    assert.equal(results[1].summary, 'ok 2');
    assert.equal(stats.retriedItems, 1);
  });

  it('does not retry deterministic providers', async () => {
    const provider = fakeProvider({ deterministic: true, answer: () => undefined });
    const { results } = await run([{ id: 1, body: 'a' }], provider);
    assert.equal(provider.calls.length, 1);
    assert.deepEqual(results, [{ id: 1, error: 'invalid_model_output' }]);
  });

  it('isolates a failed batch: other batches still succeed', async () => {
    const provider = fakeProvider({ batchSize: 1 });
    const original = provider.run;
    provider.run = async (mode, items, ctx) => {
      if (items[0].id === 1) throw new Error('network down');
      return original(mode, items, ctx);
    };
    const { results } = await run([{ id: 1, body: 'a' }, { id: 2, body: 'b' }], provider);
    assert.deepEqual(results, [
      { id: 1, error: 'model_error' },
      { id: 2, summary: 'summary of 2' },
    ]);
  });

  it('reports unsupported modes per item', async () => {
    const provider = fakeProvider({ supports: () => false });
    const { results } = await run([{ id: 1, body: 'a' }], provider);
    assert.deepEqual(results, [{ id: 1, error: 'unsupported_mode' }]);
    assert.equal(provider.calls.length, 0);
  });

  it('turns model answers into the public classify format', async () => {
    const provider = fakeProvider({ answer: () => ({ primary: 'hr', secondary: 'marketing' }) });
    const { results } = await processItems({ items: [{ id: 3, body: 'retreat' }], mode: classifyMode, provider, config, logger: silent });
    assert.deepEqual(results, [{ id: 3, topics: ['hr', 'marketing'] }]);
  });

  it('accumulates token usage and estimates cost', async () => {
    const { stats } = await run([{ id: 1, body: 'a' }], fakeProvider());
    assert.equal(stats.inputTokens, 1000);
    assert.equal(stats.outputTokens, 500);
    assert.equal(stats.estimatedCostUsd, 0.002);
  });
});

describe('mapWithConcurrency', () => {
  it('never exceeds the limit and keeps result order', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([30, 10, 20, 5], 2, async (ms, i) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, ms));
      active -= 1;
      return i;
    });
    assert.deepEqual(out, [0, 1, 2, 3]);
    assert.equal(peak, 2);
  });
});
