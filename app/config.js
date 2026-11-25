/** Config from env vars (full list: README → Configuration). */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const float = (value, fallback) => {
  const n = Number.parseFloat(value ?? '');
  return Number.isFinite(n) ? n : fallback;
};

const bool = (value, fallback) => (value === undefined || value === '' ? fallback : ['1', 'true', 'yes'].includes(value.toLowerCase()));

/** A function rather than a constant, so tests can pass their own env. */
export function loadConfig(env = process.env) {
  return {
    provider: (env.MODEL_PROVIDER || 'local').toLowerCase(),

    input: {
      // Cost grows with length; short-text tasks lose almost nothing beyond this.
      maxChars: int(env.MAX_INPUT_CHARS, 1200),
    },

    processing: {
      concurrency: int(env.CONCURRENCY, 2),
      retryFailedOnce: bool(env.RETRY_FAILED_ONCE, true),
      cacheSize: int(env.RESULT_CACHE_SIZE, 500),
    },

    anthropic: {
      // Cheapest current model; enough for short-text classification/summaries.
      model: env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
      batchSize: int(env.ANTHROPIC_BATCH_SIZE, 10),
      effort: env.ANTHROPIC_EFFORT || 'low',
      maxOutputTokensPerItem: int(env.ANTHROPIC_MAX_TOKENS_PER_ITEM, 120),
      maxRetries: int(env.ANTHROPIC_MAX_RETRIES, 2),
      timeoutMs: int(env.ANTHROPIC_TIMEOUT_MS, 60_000),
      // USD per 1M tokens, used only for the cost estimate in logs.
      pricing: {
        inputPerMTok: float(env.ANTHROPIC_PRICE_INPUT_PER_MTOK, 0.1),
        outputPerMTok: float(env.ANTHROPIC_PRICE_OUTPUT_PER_MTOK, 0.5),
      },
    },

    local: {
      // Entry in models.lock.json (pinned Hugging Face commit + SHA-256).
      model: env.LOCAL_MODEL || 'qwen2.5-1.5b-instruct',
      lockFile: env.LOCAL_MODELS_LOCK || path.join(ROOT_DIR, 'models.lock.json'),
      modelsDir: env.MODEL_CACHE_DIR || path.join(ROOT_DIR, 'models'),
      offline: bool(env.LOCAL_MODELS_OFFLINE, false),
      // CPU by default: Lambda has no GPU, and an integrated GPU is often slower anyway.
      gpu: env.LOCAL_GPU === 'auto' ? 'auto' : false,
      contextSize: int(env.LOCAL_CONTEXT_SIZE, 2048),
      threads: int(env.LOCAL_THREADS, 0), // 0 = auto
      maxOutputTokens: int(env.LOCAL_MAX_OUTPUT_TOKENS, 160),
      maxStringChars: int(env.LOCAL_MAX_STRING_CHARS, 320),
    },
  };
}
