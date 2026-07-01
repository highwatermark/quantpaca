export interface ProcessGuardDeps {
  log: (message: string, error?: unknown) => void;
  exit: (code: number) => void;
  closeServer?: (onClosed: () => void) => void;
}

const SHUTDOWN_GRACE_MS = 5000;

export function createProcessGuardHandlers(deps: ProcessGuardDeps) {
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
      deps.log(`[shutdown] Received ${signal}; closing HTTP server.`);
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
  process.on("SIGTERM", () => handlers.onShutdownSignal("SIGTERM"));
  process.on("SIGINT", () => handlers.onShutdownSignal("SIGINT"));
  return handlers;
}
