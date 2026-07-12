export interface ProcessGuardDeps {
  log: (message: string, error?: unknown) => void;
  exit: (code: number) => void;
  closeServer?: (onClosed: () => void) => void;
  // Phase 2 Task 2 (docs/GO_LIVE_PLAN.md Phase 2.1): stops the autonomous
  // sync scheduler (clears its armed timer) as the first step of graceful
  // shutdown. Optional so every existing caller/test that predates the
  // scheduler keeps working unchanged. A cycle already in flight is not
  // interrupted -- it holds dbMutex and simply runs to completion.
  stopScheduler?: () => void;
}

const SHUTDOWN_GRACE_MS = 5000;

export function createProcessGuardHandlers(deps: ProcessGuardDeps) {
  let shuttingDown = false;
  return {
    onUncaughtException(error: unknown) {
      deps.log("[fatal] Uncaught exception — shutting down.", error);
      deps.exit(1);
    },
    onUnhandledRejection(reason: unknown) {
      deps.log("[fatal] Unhandled promise rejection — shutting down.", reason);
      deps.exit(1);
    },
    onShutdownSignal(signal: string) {
      if (shuttingDown) return;
      shuttingDown = true;
      deps.log(`[shutdown] Received ${signal}; closing HTTP server.`);
      deps.stopScheduler?.();
      let exited = false;
      const finish = () => {
        if (exited) return;
        exited = true;
        deps.exit(0);
      };
      if (!deps.closeServer) return finish();
      deps.closeServer(finish);
      const timer = setTimeout(finish, SHUTDOWN_GRACE_MS);
      timer.unref?.();
    },
  };
}

export function installProcessGuards(deps: ProcessGuardDeps) {
  const handlers = createProcessGuardHandlers(deps);
  process.on("uncaughtException", handlers.onUncaughtException);
  process.on("unhandledRejection", handlers.onUnhandledRejection);
  process.once("SIGTERM", () => handlers.onShutdownSignal("SIGTERM"));
  process.once("SIGINT", () => handlers.onShutdownSignal("SIGINT"));
  return handlers;
}
