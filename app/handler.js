/**
 * Lambda entry point. Accepts `{ mode, items, topics? }` directly or as an API Gateway /
 * Function URL `body`. Module-scope state (provider, model, cache) is reused by warm invocations.
 */
import { processItems } from './application/process-batch.js';
import { loadConfig } from './config.js';
import { RequestError } from './domain/errors.js';
import { getMode } from './domain/modes/index.js';
import { createLogger } from './infrastructure/logger.js';
import { createProvider } from './infrastructure/providers/index.js';
import { createResultCache } from './infrastructure/result-cache.js';

const config = loadConfig();
const cache = createResultCache(config.processing.cacheSize);
let providerPromise;

const isHttpEvent = (event) => typeof event?.body === 'string' || event?.requestContext?.http !== undefined;

const httpResponse = (statusCode, payload) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

function parseRequest(event) {
  let payload = event;
  if (isHttpEvent(event)) {
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body;
      payload = JSON.parse(raw || '{}');
    } catch {
      throw new RequestError('request body is not valid JSON');
    }
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RequestError('event must be an object: { "mode": "...", "items": [...] }');
  }
  if (!Array.isArray(payload.items)) throw new RequestError('"items" must be an array');
  return { mode: getMode(payload.mode), items: payload.items, modeOptions: { topics: payload.topics } };
}

export async function handler(event, context = {}) {
  const logger = createLogger({ level: process.env.LOG_LEVEL, context: { requestId: context.awsRequestId } });
  const http = isHttpEvent(event);

  try {
    const { mode, items, modeOptions } = parseRequest(event);
    logger.info('request received', { mode: mode.name, items: items.length, provider: config.provider });

    providerPromise ??= createProvider(config.provider, config).catch((error) => {
      providerPromise = undefined; // let a later invocation retry initialization
      throw error;
    });
    const provider = await providerPromise;

    const { results, stats } = await processItems({ items, mode, modeOptions, provider, config, logger, cache });
    logger.info('request completed', stats);
    return http ? httpResponse(200, results) : results;
  } catch (error) {
    const isRequestError = error instanceof RequestError;
    if (isRequestError) logger.error('request rejected', { code: error.code, error: error.message });
    else logger.error('unexpected failure', { error: error.message, stack: error.stack });

    if (http) {
      return isRequestError
        ? httpResponse(400, { error: error.code, message: error.message })
        : httpResponse(500, { error: 'internal_error' });
    }
    throw error; // direct invocation: Lambda reports the error to the caller
  }
}
