/** Provider factory (contract: `ModelProvider` in application/ports.js). Lazy imports keep cold starts small. */
import { RequestError } from '../../domain/errors.js';

const FACTORIES = {
  local: async () => (await import('./local-llm.js')).createLocalLlmProvider,
  anthropic: async () => (await import('./anthropic.js')).createAnthropicProvider,
  mock: async () => (await import('./mock.js')).createMockProvider,
};

export async function createProvider(name, config) {
  const load = FACTORIES[name];
  if (!load) {
    throw new RequestError(`unknown MODEL_PROVIDER "${name}", expected one of: ${Object.keys(FACTORIES).join(', ')}`, 'unknown_provider');
  }
  return (await load())(config);
}
