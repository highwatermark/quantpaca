import { Terminal, RefreshCw, Layers } from "lucide-react";
import { SyncLog } from "../types";

interface ServerStatusLogsProps {
  logs: SyncLog[];
}

export default function ServerStatusLogs({ logs }: ServerStatusLogsProps) {
  return (
    <div className="bg-[#1A1A1A] border border-[#1A1A1A] rounded p-6 shadow-sm">
      <div className="flex items-center justify-between border-b border-white/10 pb-3 mb-4">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-[#10B981] animate-pulse" />
          <h3 className="text-xs font-bold uppercase tracking-wider text-white font-mono">
            Platform Logs & Reasoning Stream
          </h3>
        </div>
        <span className="text-[9px] font-mono uppercase bg-white/10 text-white/70 px-2 py-0.5 rounded border border-white/10">
          STDOUT ACTIVE
        </span>
      </div>

      <div className="bg-black/40 rounded p-4 font-mono text-[11px] leading-relaxed text-[#94A3B8] max-h-[180px] overflow-y-auto space-y-2 border border-black/30">
        {logs.length === 0 ? (
          <div className="text-white/40 italic py-2">Stream active. Waiting for system sync signals...</div>
        ) : (
          logs.map((log) => {
            let colorCls = "text-white/60";
            if (log.type === "error") colorCls = "text-rose-400 font-bold";
            if (log.type === "trade") colorCls = "text-[#10B981] font-semibold";
            if (log.type === "sentiment") colorCls = "text-amber-400 font-semibold";
            if (log.type === "override") colorCls = "text-blue-400";

            return (
              <div key={log.id} className="border-b border-white/5 pb-1.5 last:border-0">
                <div className="flex items-start gap-2">
                  <span className="text-[#64748B] shrink-0 select-none text-[10px]">
                    [{new Date(log.timestamp).toLocaleTimeString("en-US", { hour12: false })}]
                  </span>
                  <div className="flex-1">
                    <span className={`${colorCls} uppercase mr-2 text-[9px] font-bold tracking-wider`}>
                      ({log.type})
                    </span>
                    <span className="text-white/90">{log.message}</span>
                    {log.details && (
                      <span className="block mt-0.5 text-[#64748B] font-sans">
                        ↳ Details: {log.details}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
