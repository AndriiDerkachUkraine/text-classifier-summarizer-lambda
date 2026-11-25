/** End-to-end through the real handler and CLI, with the mock provider. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

process.env.MODEL_PROVIDER = 'mock';
process.env.LOG_LEVEL = 'ERROR';
const { handler } = await import('../app/handler.js');

const items = [
  { id: 1, subject: 'Invoice #1234 overdue', body: 'Please pay the invoice.' },
  { id: 4, subject: '', body: ' ' },
];

describe('Lambda handler', () => {
  it('handles a direct invocation', async () => {
    const result = await handler({ mode: 'classify', items });
    assert.deepEqual(result, [
      { id: 1, topics: ['finance'] },
      { id: 4, error: 'empty_input' },
    ]);
  });

  it('handles an API Gateway / Function URL event', async () => {
    const response = await handler({ body: JSON.stringify({ mode: 'summarize', items }), requestContext: { http: {} } });
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body)[0].summary, 'Please pay the invoice.');
  });

  it('returns 400 for a bad HTTP request and throws for a bad direct invocation', async () => {
    const response = await handler({ body: '{not json' });
    assert.equal(response.statusCode, 400);
    await assert.rejects(handler({ mode: 'translate', items }), { code: 'unknown_mode' });
    await assert.rejects(handler({ mode: 'classify', items: 'nope' }), { name: 'RequestError' });
  });
});

describe('CLI (app/run.js)', () => {
  const exec = promisify(execFile);
  const env = { ...process.env, MODEL_PROVIDER: 'mock' };

  it('runs the documented command and prints JSON to stdout', async () => {
    const { stdout, stderr } = await exec(
      process.execPath,
      ['app/run.js', '--input', 'sample/emails.json', '--mode', 'classify', '--log-level', 'INFO'],
      { env },
    );
    const output = JSON.parse(stdout);
    assert.equal(output.length, 4);
    assert.deepEqual(output[3], { id: 4, error: 'empty_input' });
    // Logs are JSON lines on stderr, never mixed into stdout.
    assert.ok(stderr.split('\n').filter(Boolean).every((line) => JSON.parse(line).level));
  });

  it('exits with a non-zero code on an unknown mode', async () => {
    await assert.rejects(exec(process.execPath, ['app/run.js', '-i', 'sample/emails.json', '-m', 'translate'], { env }), (error) => {
      assert.equal(error.code, 1);
      return true;
    });
  });
});
