import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../app/config.js';
import { classifyMode } from '../app/domain/modes/classify.js';
import { summarizeMode } from '../app/domain/modes/summarize.js';
import { buildResponseSchema, createAnthropicProvider } from '../app/infrastructure/providers/anthropic.js';
import { createProvider } from '../app/infrastructure/providers/index.js';
import { buildItemSchema, capStrings } from '../app/infrastructure/providers/local-llm.js';

const config = loadConfig({});
const items = [
  { key: 0, id: 1, subject: 'Invoice', body: 'Pay now', text: 'Invoice\n\nPay now' },
  { key: 1, id: 2, subject: '', body: 'Deploy tonight', text: 'Deploy tonight' },
];

/** Fake Anthropic client: captures the request, returns a canned Message. */
function fakeClient(message) {
  const requests = [];
  return {
    requests,
    messages: {
      async create(params) {
        requests.push(params);
        return { stop_reason: 'end_turn', usage: { input_tokens: 300, output_tokens: 40 }, ...message };
      },
    },
  };
}

const textMessage = (obj) => ({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(obj) }] });

describe('anthropic provider', () => {
  it('sends the whole batch in one structured-output request', async () => {
    const client = fakeClient(textMessage({ results: [{ key: 0, summary: 'A' }, { key: 1, summary: 'B' }] }));
    const provider = createAnthropicProvider(config, { client });
    const { results, usage } = await provider.run(summarizeMode, items, {});

    assert.equal(client.requests.length, 1);
    const [req] = client.requests;
    assert.equal(req.model, 'claude-haiku-5-5');
    assert.equal(req.output_config.effort, 'low');
    assert.equal(req.output_config.format.type, 'json_schema');
    assert.ok(req.messages[0].content.includes('<email key="0">\nSubject: Invoice\nPay now\n</email>'));
    assert.ok(!('temperature' in req), 'sampling params are rejected by current models');
    assert.deepEqual([...results], [[0, 'A'], [1, 'B']]);
    assert.deepEqual(usage, { inputTokens: 300, outputTokens: 40 });
  });

  it('ignores unknown keys and leaves skipped items absent (they get retried)', async () => {
    const client = fakeClient(textMessage({ results: [{ key: 1, summary: 'B' }, { key: 99, summary: 'X' }] }));
    const { results } = await createAnthropicProvider(config, { client }).run(summarizeMode, items, {});
    assert.deepEqual([...results], [[1, 'B']]);
  });

  it('marks every item failed on refusal or broken JSON', async () => {
    for (const message of [
      { stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] },
      { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"results": [' }] },
    ]) {
      const { results } = await createAnthropicProvider(config, { client: fakeClient(message) }).run(summarizeMode, items, {});
      assert.equal(results.size, 2);
      assert.ok([...results.values()].every((v) => v instanceof Error));
    }
  });

  it('builds a strict schema around the mode schema', () => {
    const schema = buildResponseSchema(classifyMode, classifyMode.prepare());
    const item = schema.properties.results.items;
    assert.deepEqual(item.required, ['key', 'topics']);
    assert.equal(item.additionalProperties, false);
    assert.equal(item.properties.topics.properties.primary.enum.at(-1), 'other');
  });

  it('fails fast with a clear message when no API key is configured', () => {
    const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      assert.throws(() => createAnthropicProvider(config), { code: 'missing_credentials' });
    } finally {
      if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
    }
  });
});

describe('local LLM provider helpers', () => {
  it('caps free-text strings but leaves enums alone', () => {
    const capped = capStrings(
      { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string', enum: ['x'] } } },
      50,
    );
    assert.equal(capped.properties.a.maxLength, 50);
    assert.equal(capped.properties.b.maxLength, undefined);
  });

  it('wraps the mode schema into a single-item object', () => {
    const schema = buildItemSchema(summarizeMode, {}, 300);
    assert.deepEqual(schema, { type: 'object', properties: { summary: { type: 'string', maxLength: 300 } }, required: ['summary'] });
  });
});

describe('provider factory', () => {
  it('creates the mock provider and rejects unknown names', async () => {
    const mock = await createProvider('mock', config);
    assert.equal(mock.name, 'mock');
    await assert.rejects(createProvider('gpt-9000', config), { code: 'unknown_provider' });
  });
});
