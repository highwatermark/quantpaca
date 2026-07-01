import { Shield, CheckCircle2, XCircle } from "lucide-react";
import { Trade } from "../types";

interface TradeLogsTableProps {
  trades: Trade[];
}

export default function TradeLogsTable({ trades }: TradeLogsTableProps) {
  return (
    <div className="bg-white rounded border border-[#E9ECEF] p-6">
      <div className="flex items-center justify-between border-b border-[#E9ECEF] pb-4 mb-4">
        <div>
          <span className="text-[10px] font-bold text-[#94A3B8] uppercase tracking-[0.2em] block mb-1">Order Dispatch Center</span>
          <h3 className="text-sm font-bold text-[#1A1A1A] flex items-center gap-1.5 uppercase tracking-wider">
            <Shield className="h-4 w-4 text-[#1A1A1A]" />
            Trade Verification Audit Log
          </h3>
        </div>
      </div>

      <div className="overflow-x-auto max-h-[300px] overflow-y-auto pr-1">
        {trades.length === 0 ? (
          <div className="text-center py-12 text-[#64748B]">
            <p className="text-xs uppercase font-bold tracking-wider">No executed automation orders have been logged yet.</p>
          </div>
        ) : (
          <table className="w-full text-left text-xs font-sans">
            <thead className="bg-[#F8F9FA] text-[#64748B] font-mono text-[10px] uppercase tracking-wider border-b border-[#E9ECEF]">
              <tr>
                <th className="py-3 px-4">Date</th>
                <th className="py-3 px-4">Symbol</th>
                <th className="py-3 px-4">Type</th>
                <th className="py-3 px-4 text-right">Shares</th>
                <th className="py-3 px-4 text-right">Price</th>
                <th className="py-3 px-4">Reasoning & Audit Trail</th>
                <th className="py-3 px-4 text-center">Telegram Alert</th>
                <th className="py-3 px-4 text-center">Sheets Sync</th>
                <th className="py-3 px-4 text-center">Notion Log</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E9ECEF]">
              {trades.map((tr) => (
                <tr key={tr.id} className="hover:bg-[#F8F9FA]/60">
                  <td className="py-3.5 px-4 text-[#64748B] font-mono text-[11px] whitespace-nowrap">
                    {new Date(tr.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" })}{" "}
                    {new Date(tr.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
                  </td>
                  <td className="py-3.5 px-4 font-bold text-[#1A1A1A] font-mono">{tr.symbol}</td>
                  <td className="py-3.5 px-4">
                    <span className={`px-2.5 py-0.5 rounded font-mono font-bold text-[10px] uppercase tracking-wider ${
                      tr.side === "buy" ? "bg-[#10B981]/15 text-[#10B981]" : "bg-rose-500/15 text-rose-600"
                    }`}>
                      {tr.side}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 text-right font-mono font-semibold text-[#1A1A1A]">{tr.qty}</td>
                  <td className="py-3.5 px-4 text-right font-mono font-semibold text-[#1A1A1A]">${parseFloat(String(tr.price || "41.50")).toFixed(2)}</td>
                  <td className="py-3.5 px-4 text-[#64748B] max-w-sm text-xs font-sans">
                    <div className="line-clamp-2" title={tr.reasoning}>
                      {tr.reasoning}
                    </div>
                  </td>
                  <td className="py-3.5 px-4 text-center whitespace-nowrap">
                    <div className="flex justify-center">
                      {tr.notifiedTelegram ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-[#10B981] bg-[#10B981]/10 px-2 py-0.5 rounded">
                          <CheckCircle2 className="h-3 w-3" /> Sent
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 bg-slate-100 px-2 py-0.5 rounded">
                          <XCircle className="h-3 w-3" /> No Bot
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-3.5 px-4 text-center whitespace-nowrap">
                    <div className="flex justify-center">
                      {tr.exportedSheets ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-[#10B981] bg-[#10B981]/10 px-2 py-0.5 rounded">
                          <CheckCircle2 className="h-3 w-3" /> Exported
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 bg-slate-100 px-2 py-0.5 rounded">
                          <XCircle className="h-3 w-3" /> Offline
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-3.5 px-4 text-center whitespace-nowrap">
                    <div className="flex justify-center">
                      {tr.loggedNotion ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-700 bg-slate-100 px-2 py-0.5 rounded border border-slate-200">
                          <CheckCircle2 className="h-3 w-3" /> Saved
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 bg-slate-100 px-2 py-0.5 rounded">
                          <XCircle className="h-3 w-3" /> Offline
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
