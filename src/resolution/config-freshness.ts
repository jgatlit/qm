import { VERSIONED_CACHE_MAX_AGE_MS, type DurableMap } from "../persistence/durable-map.ts";
import type { ScopeId } from "../types.ts";

export function createConfigFreshness(queue: <T>(key: string, fn: () => Promise<T>) => Promise<T>) {
  const resets: Array<() => void> = [];
  return {
    reset() {
      for (const reset of resets) reset();
    },
    gate(store: Pick<DurableMap<unknown>, "version">, key: string, load: (id: ScopeId) => Promise<void>) {
      let seen: string | undefined;
      let seenAt = 0;
      const current = new Set<ScopeId>();
      resets.push(() => {
        seen = undefined;
        current.clear();
      });
      return async (ids: readonly ScopeId[]): Promise<void> => {
        const version = await store.version();
        if (version !== seen || Date.now() - seenAt > VERSIONED_CACHE_MAX_AGE_MS) {
          seen = version;
          seenAt = Date.now();
          current.clear();
        }
        await Promise.all(
          [...new Set(ids)]
            .filter((id) => !current.has(id))
            .map((id) =>
              queue(`${key}:${id}`, async () => {
                if (seen === version && current.has(id)) return;
                await load(id);
                if (seen === version) current.add(id);
              }),
            ),
        );
      };
    },
  };
}
