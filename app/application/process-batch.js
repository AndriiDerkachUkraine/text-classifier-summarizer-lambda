/**
 * Use case: validate → cache → dedupe → batch → provider → normalize → retry once.
 * One output entry per input item, in input order; one failure never stops the rest.
 */
import { validateItem } from '../domain/email.js';
import { ErrorCode, ItemError } from '../domain/errors.js';
import { resultKey } from './result-key.js';

/** Runs `fn` over `items` with at most `limit` promises in flight. */
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const chunk = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

/**
 * @param {{ items: unknown[], mode: import('./ports.js').Mode, modeOptions?: object,
 *   provider: import('./ports.js').ModelProvider, config: ReturnType<import('../config.js').loadConfig>,
 *   logger: import('./ports.js').Logger, cache?: import('./ports.js').ResultCache }} args
 */
export async function processItems({ items, mode, modeOptions = {}, provider, config, logger, cache }) {
  const started = Date.now();
  const ctx = mode.prepare(modeOptions);
  const model = provider.modelId(mode);
  const output = new Array(items.length);
  const stats = {
    mode: mode.name,
    provider: provider.name,
    model,
    items: items.length,
    succeeded: 0,
    failed: 0,
    errors: {},
    cacheHits: 0,
    duplicatesSkipped: 0,
    modelCalls: 0,
    retriedItems: 0,
    inputTokens: 0,
    outputTokens: 0,
  };

  const fail = (item, code, reason) => {
    output[item.key] = { id: item.id, error: code };
    stats.failed += 1;
    stats.errors[code] = (stats.errors[code] ?? 0) + 1;
    logger.warn('item failed', { index: item.key, id: item.id, error: code, reason });
  };

  const succeed = (item, value) => {
    output[item.key] = { id: item.id, [mode.outputKey]: value };
    stats.succeeded += 1;
  };

  // Invalid or empty items are answered here and never reach a model.
  const valid = [];
  const seenIds = new Set();
  items.forEach((raw, index) => {
    const result = validateItem(raw, index, config.input);
    if (!result.ok) return fail({ key: index, id: result.id }, result.error, result.reason);
    if (seenIds.has(result.item.id)) logger.warn('duplicate id in input', { index, id: result.item.id });
    seenIds.add(result.item.id);
    for (const warning of result.warnings) logger.warn('input adjusted', { index, id: result.item.id, warning });
    valid.push(result.item);
  });

  if (valid.length && !provider.supports(mode)) {
    for (const item of valid) fail(item, ErrorCode.UNSUPPORTED_MODE, `provider "${provider.name}" cannot run "${mode.name}"`);
    valid.length = 0;
  }

  // Each distinct text goes to the model at most once.
  const scope = JSON.stringify([provider.name, model, mode.name, ctx]);
  const groups = new Map(); // representative item.key → { cacheKey, members }
  const byCacheKey = new Map();
  for (const item of valid) {
    const cacheKey = resultKey(scope, item.subject, item.body);
    const cached = cache?.get(cacheKey);
    if (cached !== undefined) {
      stats.cacheHits += 1;
      succeed(item, cached);
    } else if (byCacheKey.has(cacheKey)) {
      stats.duplicatesSkipped += 1;
      byCacheKey.get(cacheKey).members.push(item);
    } else {
      const group = { cacheKey, members: [item] };
      byCacheKey.set(cacheKey, group);
      groups.set(item.key, group);
    }
  }

  const settle = (item, value) => {
    const { cacheKey, members } = groups.get(item.key);
    for (const member of members) succeed(member, value);
    cache?.set(cacheKey, value);
  };
  const failGroup = (item, code, reason) => {
    for (const member of groups.get(item.key).members) fail(member, code, reason);
  };

  /** Raw provider answer → `{ value }` or `{ error }`. */
  const interpret = (raw) => {
    if (raw === undefined) return { error: new ItemError(ErrorCode.INVALID_MODEL_OUTPUT, 'no result returned for item') };
    if (raw instanceof Error) return { error: raw };
    try {
      return { value: mode.normalize(raw, ctx) };
    } catch (error) {
      return { error };
    }
  };

  const runBatches = async (batchItems, { lastAttempt }) => {
    const retry = [];
    const limit = Math.max(1, Math.min(config.processing.concurrency, provider.maxConcurrency));

    await mapWithConcurrency(chunk(batchItems, provider.batchSize), limit, async (batch) => {
      stats.modelCalls += 1;
      let response;
      try {
        response = await provider.run(mode, batch, ctx, logger);
      } catch (error) {
        // Not retried here: the SDK already retried transient errors.
        logger.error('provider call failed', { provider: provider.name, batchSize: batch.length, error: error.message });
        for (const item of batch) failGroup(item, ErrorCode.MODEL_ERROR, error.message);
        return;
      }

      stats.inputTokens += response.usage?.inputTokens ?? 0;
      stats.outputTokens += response.usage?.outputTokens ?? 0;

      for (const item of batch) {
        const { value, error } = interpret(response.results.get(item.key));
        if (!error) {
          settle(item, value);
          continue;
        }
        logger.debug('item result rejected', { id: item.id, error: error.message, willRetry: !lastAttempt });
        if (!lastAttempt) retry.push(item);
        else failGroup(item, error instanceof ItemError ? error.code : ErrorCode.MODEL_ERROR, error.message);
      }
    });
    return retry;
  };

  // A deterministic provider would give the same answer again.
  const retryOnce = config.processing.retryFailedOnce && !provider.deterministic;
  const toRetry = await runBatches(
    [...groups.values()].map((group) => group.members[0]),
    { lastAttempt: !retryOnce },
  );
  if (toRetry.length) {
    stats.retriedItems = toRetry.length;
    logger.info('retrying failed items', { count: toRetry.length });
    await runBatches(toRetry, { lastAttempt: true });
  }

  stats.durationMs = Date.now() - started;
  if (provider.pricing) {
    const { inputPerMTok, outputPerMTok } = provider.pricing;
    stats.estimatedCostUsd = Number(((stats.inputTokens * inputPerMTok + stats.outputTokens * outputPerMTok) / 1e6).toFixed(6));
  }
  return { results: output, stats };
}
