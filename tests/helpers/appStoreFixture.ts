// Phase 2 Task 14 (docs/GO_LIVE_PLAN.md Phase 2.5, "Store consolidation"):
// shared test-seeding helper. Before this task, integration tests seeded
// operational state (config, sync logs, legacy trades/analyses, the
// simulated portfolio) by writing a fixture db.json directly to disk, then
// relying on server.ts's readDB() re-reading that file fresh on every
// request. db.json is no longer read at request time (it's frozen legacy
// state after the one-time boot migration -- see src/server/appStore.ts) --
// this helper opens a SECOND connection to the SAME quantpaca.sqlite file
// server.ts's own module-scope productionStore/appStore already have open
// (safe under WAL mode, same pattern many existing tests already use to seed
// app_state/audit events directly) and writes through the identical
// appStore facade server.ts uses, so tests get the exact same read-your-
// writes semantics db.json fixtures used to provide.
import path from "node:path";
import { createProductionStore } from "../../src/server/persistence";
import { AppStore, createAppStore } from "../../src/server/appStore";

/**
 * Opens a throwaway AppStore pointed at `dataDir`'s quantpaca.sqlite, hands
 * it to `fn` for seeding/reading, then closes the underlying connection.
 * `dataDir` must be the SAME QUANTPACA_DATA_DIR the test pointed server.ts
 * at (via process.env.QUANTPACA_DATA_DIR) before importing "../server".
 */
export function withAppStore<T>(dataDir: string, fn: (store: AppStore) => T): T {
  const productionStore = createProductionStore(path.join(dataDir, "quantpaca.sqlite"));
  try {
    return fn(createAppStore(productionStore));
  } finally {
    productionStore.close();
  }
}
