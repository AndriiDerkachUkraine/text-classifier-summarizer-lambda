#!/usr/bin/env node
/** Local Lambda simulator: builds the event from a JSON file and calls the real handler. */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const USAGE = `Usage: node app/run.js --input <file.json> --mode <classify|summarize> [options]

Options:
  --input, -i       JSON file: an array of { id, subject, body } (or { "items": [...] })
  --mode, -m        classify | summarize
  --log-level, -l   DEBUG | INFO | WARN | ERROR (default: INFO)
  --provider, -p    local | anthropic | mock (default: $MODEL_PROVIDER or "local")
  --topics          comma-separated topic list for classify (default: built-in list)
  --output, -o      write the result to a file instead of stdout
  --help, -h        show this help`;

async function main() {
  // Local convenience (.env is git-ignored); in Lambda these come from the function config.
  if (existsSync('.env')) process.loadEnvFile('.env');

  const { values } = parseArgs({
    options: {
      input: { type: 'string', short: 'i' },
      mode: { type: 'string', short: 'm' },
      'log-level': { type: 'string', short: 'l', default: process.env.LOG_LEVEL ?? 'INFO' },
      provider: { type: 'string', short: 'p' },
      topics: { type: 'string' },
      output: { type: 'string', short: 'o' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help || !values.input || !values.mode) {
    console.error(USAGE);
    process.exitCode = values.help ? 0 : 2;
    return;
  }

  // The handler reads env vars at import time, as in Lambda, so set them first.
  process.env.LOG_LEVEL = values['log-level'];
  if (values.provider) process.env.MODEL_PROVIDER = values.provider;
  const { handler } = await import('./handler.js');

  let data;
  try {
    data = JSON.parse(await readFile(values.input, 'utf8'));
  } catch (error) {
    console.error(`Cannot read input file "${values.input}": ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const event = {
    mode: values.mode,
    items: Array.isArray(data) ? data : data?.items,
    ...(values.topics && { topics: values.topics.split(',').map((t) => t.trim()).filter(Boolean) }),
  };

  const context = { awsRequestId: randomUUID(), functionName: 'local-simulator' };

  try {
    const result = await handler(event, context);
    const json = JSON.stringify(result, null, 2);
    if (values.output) await writeFile(values.output, `${json}\n`);
    else process.stdout.write(`${json}\n`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
