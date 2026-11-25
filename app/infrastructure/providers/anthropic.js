/**
 * Claude via the Messages API. Emails are batched (instructions paid once per batch);
 * structured outputs guarantee schema-valid JSON, so no repair round-trips.
 */
import Anthropic from '@anthropic-ai/sdk';
import { RequestError } from '../../domain/errors.js';
import { buildSystemPrompt, renderEmails } from './llm-prompt.js';

const FRAMING = [
  'You process a batch of emails. Each email is wrapped in <email key="N"> tags.',
  'Return exactly one result per email and copy its key unchanged.',
];

// JSON envelope + brief thinking, on top of the per-item budget.
const BASE_OUTPUT_TOKENS = 512;

export function buildResponseSchema(mode, ctx) {
  return {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: { key: { type: 'integer' }, [mode.outputKey]: mode.llm.resultSchema(ctx) },
          required: ['key', mode.outputKey],
          additionalProperties: false,
        },
      },
    },
    required: ['results'],
    additionalProperties: false,
  };
}

const failAll = (items, message) => {
  const error = new Error(message);
  return new Map(items.map((item) => [item.key, error]));
};

/**
 * @param {ReturnType<import('../../config.js').loadConfig>} config
 * @param {{ client?: Pick<Anthropic, 'messages'> }} [deps] injectable client for tests
 */
export function createAnthropicProvider(config, { client } = {}) {
  const settings = config.anthropic;

  if (!client && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new RequestError(
      'MODEL_PROVIDER=anthropic requires ANTHROPIC_API_KEY (see .env.example). Use MODEL_PROVIDER=local to run without keys.',
      'missing_credentials',
    );
  }

  // The SDK retries 429/5xx and connection errors with backoff.
  const api = client ?? new Anthropic({ maxRetries: settings.maxRetries, timeout: settings.timeoutMs });

  return {
    name: 'anthropic',
    batchSize: settings.batchSize,
    maxConcurrency: Infinity,
    pricing: settings.pricing,
    modelId: () => settings.model,
    supports: (mode) => Boolean(mode.llm),

    async run(mode, items, ctx) {
      const response = await api.messages.create({
        model: settings.model,
        max_tokens: BASE_OUTPUT_TOKENS + settings.maxOutputTokensPerItem * items.length,
        system: buildSystemPrompt(FRAMING, mode, ctx),
        messages: [{ role: 'user', content: renderEmails(items) }],
        output_config: {
          effort: settings.effort,
          format: { type: 'json_schema', schema: buildResponseSchema(mode, ctx) },
        },
      });

      const usage = { inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 };

      if (response.stop_reason === 'refusal') {
        return { results: failAll(items, `model refused the request (${response.stop_details?.category ?? 'unspecified'})`), usage };
      }

      // Thinking blocks may come first: read text blocks by type, not by position.
      const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        const hint = response.stop_reason === 'max_tokens' ? ' (output hit max_tokens)' : '';
        return { results: failAll(items, `response is not valid JSON${hint}`), usage };
      }

      // Keys the model skipped stay absent; the use case retries them.
      const wanted = new Set(items.map((item) => item.key));
      const results = new Map();
      for (const entry of parsed?.results ?? []) {
        if (wanted.has(entry?.key)) results.set(entry.key, entry[mode.outputKey]);
      }
      return { results, usage };
    },
  };
}
