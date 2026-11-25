import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cleanText, truncate, validateItem } from '../app/domain/email.js';
import { classifyMode, FALLBACK_TOPIC } from '../app/domain/modes/classify.js';
import { getMode } from '../app/domain/modes/index.js';
import { limitSentences, summarizeMode } from '../app/domain/modes/summarize.js';

const limits = { maxChars: 100 };

describe('validateItem', () => {
  it('accepts a normal email and builds the model text', () => {
    const result = validateItem({ id: 1, subject: 'Hi', body: 'Body text' }, 0, limits);
    assert.equal(result.ok, true);
    assert.deepEqual(result.item, { key: 0, id: 1, subject: 'Hi', body: 'Body text', text: 'Hi\n\nBody text' });
  });

  it('flags whitespace-only subject and body as empty_input', () => {
    assert.deepEqual(validateItem({ id: 4, subject: '', body: '  ' }, 3, limits), {
      ok: false,
      id: 4,
      error: 'empty_input',
      reason: 'subject and body are empty',
    });
  });

  for (const [label, raw, id] of [
    ['null', null, null],
    ['a string', 'text', null],
    ['an array', [1], null],
    ['missing id', { subject: 'x' }, null],
    ['blank string id', { id: ' ', subject: 'x' }, ' '],
    ['non-string body', { id: 2, body: 42 }, 2],
  ]) {
    it(`flags ${label} as invalid_input`, () => {
      const result = validateItem(raw, 0, limits);
      assert.equal(result.ok, false);
      assert.equal(result.error, 'invalid_input');
      assert.equal(result.id, id);
    });
  }

  it('treats a null subject as empty and keeps the body', () => {
    const result = validateItem({ id: 'a', subject: null, body: 'Shipped' }, 0, limits);
    assert.equal(result.ok, true);
    assert.equal(result.item.text, 'Shipped');
  });

  it('truncates long bodies and reports a warning', () => {
    const result = validateItem({ id: 1, body: 'word '.repeat(50) }, 0, limits);
    assert.equal(result.ok, true);
    assert.ok(result.item.body.length <= limits.maxChars + 1);
    assert.match(result.warnings[0], /truncated/);
  });
});

describe('cleanText / truncate', () => {
  it('drops quoted reply lines and collapses whitespace', () => {
    assert.equal(cleanText('Please help   now\n\n\n\n> old reply\n> more'), 'Please help now');
  });

  it('keeps quoted text when nothing else is left', () => {
    assert.equal(cleanText('> only a quote'), '> only a quote');
  });

  it('cuts on a word boundary when that loses little text', () => {
    assert.deepEqual(truncate('alpha beta gamma delta', 18), { text: 'alpha beta gamma…', truncated: true });
  });

  it('leaves short text untouched', () => {
    assert.deepEqual(truncate('short', 18), { text: 'short', truncated: false });
  });
});

describe('classify mode', () => {
  const ctx = classifyMode.prepare();

  it('maps the primary/secondary answer to a topics array', () => {
    assert.deepEqual(classifyMode.normalize({ primary: 'hr', secondary: 'marketing' }, ctx), ['hr', 'marketing']);
    assert.deepEqual(classifyMode.normalize({ primary: 'finance', secondary: 'none' }, ctx), ['finance']);
  });

  it('drops unknown labels and duplicates, falls back to "other"', () => {
    assert.deepEqual(classifyMode.normalize({ primary: ' Finance ', secondary: 'finance' }, ctx), ['finance']);
    assert.deepEqual(classifyMode.normalize({ primary: 'made-up', secondary: 'none' }, ctx), [FALLBACK_TOPIC]);
    assert.deepEqual(classifyMode.normalize({ primary: 'other', secondary: 'hr' }, ctx), ['hr']);
  });

  it('rejects a malformed answer', () => {
    assert.throws(() => classifyMode.normalize('finance', ctx), { code: 'invalid_model_output' });
    assert.throws(() => classifyMode.normalize(null, ctx), { code: 'invalid_model_output' });
  });

  it('accepts custom topics from the request', () => {
    const custom = classifyMode.prepare({ topics: ['Billing', 'Spam'] });
    assert.deepEqual(custom.allowed, ['billing', 'spam', FALLBACK_TOPIC]);
    assert.ok(classifyMode.llm.instructions(custom).includes('- billing'));
  });

  it('rejects an invalid topic list', () => {
    assert.throws(() => classifyMode.prepare({ topics: [] }), { name: 'RequestError' });
    assert.throws(() => classifyMode.prepare({ topics: [1, 2] }), { name: 'RequestError' });
  });

  it('puts every allowed topic into the LLM schema', () => {
    const schema = classifyMode.llm.resultSchema(ctx);
    assert.deepEqual(schema.properties.primary.enum, ctx.allowed);
    assert.ok(schema.properties.secondary.enum.includes('none'));
  });
});

describe('summarize mode', () => {
  it('keeps at most two sentences and strips a "Summary:" preamble', () => {
    assert.equal(summarizeMode.normalize('Summary:  One. Two!  Three?'), 'One. Two!');
  });

  it('does not split inside amounts', () => {
    assert.equal(limitSentences('The fee is 2.5% of 1,200.50 EUR. Pay by Friday. Thanks.'), 'The fee is 2.5% of 1,200.50 EUR. Pay by Friday.');
  });

  it('rejects empty or non-string output', () => {
    assert.throws(() => summarizeMode.normalize('   '), { code: 'invalid_model_output' });
    assert.throws(() => summarizeMode.normalize(null), { code: 'invalid_model_output' });
  });
});

describe('mode registry', () => {
  it('resolves modes case-insensitively and rejects unknown ones', () => {
    assert.equal(getMode('CLASSIFY'), classifyMode);
    assert.throws(() => getMode('translate'), { code: 'unknown_mode' });
  });
});
