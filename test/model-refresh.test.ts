import { test } from "node:test";
import assert from "node:assert/strict";
import { createModelRefresh } from "../src/model/model-refresh.ts";

test("callers during a model refresh share one follow-up that sees writes made meanwhile", async () => {
  let version = 1;
  const rebuiltAt: number[] = [];
  let release!: () => void;
  const refresh = createModelRefresh({
    inputs: [{ version: async () => String(version) }],
    refreshCatalog: async () => {},
    routes: () => "routes",
    rebuild: async () => {
      rebuiltAt.push(version);
      if (rebuiltAt.length === 1) await new Promise<void>((resolve) => (release = resolve));
      return true;
    },
  });

  const first = refresh();
  await new Promise((resolve) => setImmediate(resolve));
  version = 2;
  const later = [refresh(), refresh(), refresh()];
  release();
  await Promise.all([first, ...later]);
  assert.deepEqual(rebuiltAt, [1, 2]);

  await refresh();
  assert.deepEqual(rebuiltAt, [1, 2]);
});
