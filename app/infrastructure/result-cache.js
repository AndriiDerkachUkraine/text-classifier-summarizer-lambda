/** In-memory LRU `ResultCache`; kept in module scope, so it survives warm Lambda invocations. */
export function createResultCache(maxSize = 500) {
  const store = new Map();

  return {
    get(key) {
      if (!store.has(key)) return undefined;
      // Re-insert = most recently used (Map keeps insertion order).
      const value = store.get(key);
      store.delete(key);
      store.set(key, value);
      return value;
    },
    set(key, value) {
      store.delete(key);
      store.set(key, value);
      if (store.size > maxSize) store.delete(store.keys().next().value);
    },
    get size() {
      return store.size;
    },
  };
}
