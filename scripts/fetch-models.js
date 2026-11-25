#!/usr/bin/env node
/** Pre-downloads the local model (the first local run does it too): `npm run models:fetch`. */
import { loadConfig } from '../app/config.js';
import { createLogger } from '../app/infrastructure/logger.js';
import { ensureModelFile, readModelSpec } from '../app/infrastructure/models/model-store.js';

const { local } = loadConfig();
const logger = createLogger();

try {
  const spec = await readModelSpec(local.lockFile, local.model);
  const file = await ensureModelFile(spec, { dir: local.modelsDir, logger });
  logger.info('model is ready', { model: local.model, file });
} catch (error) {
  logger.error('model fetch failed', { error: error.message });
  process.exitCode = 1;
}
