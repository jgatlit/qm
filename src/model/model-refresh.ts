import type { DurableMap } from "../persistence/durable-map.ts";

export function createModelRefresh(input: {
  inputs: readonly Pick<DurableMap<unknown>, "version">[];
  refreshCatalog: () => Promise<void>;
  routes: () => unknown;
  rebuild: () => Promise<boolean>;
}): () => Promise<void> {
  let built: { versions: string; routes: unknown } | undefined;
  let running: Promise<void> | undefined;
  let next: Promise<void> | undefined;
  const refreshNow = async () => {
    await input.refreshCatalog();
    const versions = (await Promise.all(input.inputs.map((map) => map.version()))).join(":");
    const routes = input.routes();
    if (built?.versions === versions && built.routes === routes) return;
    built = (await input.rebuild()) ? { versions, routes } : undefined;
  };
  const refresh = (): Promise<void> => {
    if (!running) {
      running = refreshNow().finally(() => {
        running = undefined;
      });
      return running;
    }
    next ??= running
      .catch(() => undefined)
      .then(() => {
        next = undefined;
        return refresh();
      });
    return next;
  };
  return refresh;
}
