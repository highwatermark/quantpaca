import { ArrowUpRight, ArrowDownRight, Wallet, TrendingUp, AlertTriangle, ShieldCheck } from "lucide-react";
import { AlpacaAccount, AlpacaPosition } from "../types";

interface PortfolioSummaryProps {
  account: AlpacaAccount;
  positions: AlpacaPosition[];
  onEmergencyClose: () => void;
  isEmergencyClosing: boolean;
  autoTrading: boolean;
}

export default function PortfolioSummary({
  account,
  positions,
  onEmergencyClose,
  isEmergencyClosing,
  autoTrading,
}: PortfolioSummaryProps) {
  const equityNum = parseFloat(account.equity || "100000.00");
  const costBasisSum = positions.reduce((sum, pos) => sum + parseFloat(pos.cost_basis), 0);
  const marketValSum = positions.reduce((sum, pos) => sum + parseFloat(pos.market_value), 0);
  const totalGain = marketValSum - costBasisSum;
  const gainPercent = costBasisSum > 0 ? (totalGain / costBasisSum) * 100 : 0;
  const isLoss = totalGain < 0;

  return (
    <div className="bg-white rounded border border-[#E9ECEF] p-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#E9ECEF] pb-6 mb-8">
        <div>
          <span className="text-[10px] font-bold text-[#94A3B8] uppercase tracking-[0.2em] block mb-1">Trading Context</span>
          <h2 className="text-xl font-bold text-[#1A1A1A] flex items-center gap-3">
            Alpaca Paper Portfolio
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
              autoTrading ? "bg-[#10B981]/10 text-[#10B981] border border-[#10B981]/20" : "bg-slate-100 text-slate-500 border border-slate-200"
            }`}>
              <span className={`h-1.5 w-1.5 rounded-full ${autoTrading ? "bg-[#10B981] animate-pulse" : "bg-slate-400"}`} />
              {autoTrading ? "QUANT BOT ACTIVE" : "BOT PAUSED"}
            </span>
          </h2>
        </div>

        <div className="flex items-center gap-2">
          <button
            id="emergency-override-btn"
            onClick={() => {
              if (window.confirm("CRITICAL WARNING: Are you sure you want to execute manual liquidate? This sells ALL current positions at market price immediately!")) {
                onEmergencyClose();
              }
            }}
            disabled={isEmergencyClosing || positions.length === 0}
            className={`flex items-center gap-2 px-4 py-2.5 rounded text-xs font-bold uppercase tracking-wider transition-colors ${
              positions.length === 0
                ? "bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200"
                : "bg-rose-500 hover:bg-rose-600 text-white cursor-pointer border border-rose-600 shadow-sm"
            }`}
          >
            <AlertTriangle className="h-4 w-4" />
            {isEmergencyClosing ? "Liquidating..." : "Emergency Close All"}
          </button>
        </div>
      </div>

      {/* Numerical Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="bg-[#F8F9FA] rounded border border-[#E9ECEF] p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold text-[#64748B] uppercase tracking-[0.12em]">Portfolio Net Worth</span>
            <Wallet className="h-4 w-4 text-[#94A3B8]" />
          </div>
          <div className="text-3xl font-light tracking-tight text-[#1A1A1A]">
            ${equityNum.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="text-[10px] text-[#94A3B8] mt-1.5 font-mono uppercase tracking-wider">
            Initial Cap: $100,000.00
          </div>
        </div>

        <div className="bg-[#F8F9FA] rounded border border-[#E9ECEF] p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold text-[#64748B] uppercase tracking-[0.12em]">Unrealized Performance</span>
            <TrendingUp className="h-4 w-4 text-[#94A3B8]" />
          </div>
          <div className={`text-3xl font-light tracking-tight ${isLoss ? "text-rose-600" : "text-[#10B981]"}`}>
            {isLoss ? "" : "+"}${totalGain.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className={`text-[10px] font-bold uppercase tracking-wider flex items-center gap-0.5 mt-1.5 ${isLoss ? "text-rose-500" : "text-[#10B981]"}`}>
            {isLoss ? <ArrowDownRight className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
            {gainPercent.toFixed(2)}%
          </div>
        </div>

        <div className="bg-[#F8F9FA] rounded border border-[#E9ECEF] p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold text-[#64748B] uppercase tracking-[0.12em]">Available Buying Power</span>
            <ShieldCheck className="h-4 w-4 text-[#94A3B8]" />
          </div>
          <div className="text-3xl font-light tracking-tight text-[#1A1A1A]">
            ${parseFloat(account.buying_power || "200000.00").toLocaleString("en-US", { maximumFractionDigits: 2 })}
          </div>
          <div className="text-[10px] text-[#94A3B8] mt-1.5 font-mono uppercase tracking-wider">
            Unused Cash: ${parseFloat(account.cash || "40000.00").toLocaleString("en-US", { maximumFractionDigits: 2 })}
          </div>
        </div>

        <div className="bg-[#F8F9FA] rounded border border-[#E9ECEF] p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold text-[#64748B] uppercase tracking-[0.12em]">Active Allocations</span>
            <div className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 border border-[#E9ECEF] text-[#64748B] rounded">
              {positions.length} Tick
            </div>
          </div>
          <div className="text-3xl font-light tracking-tight text-[#1A1A1A]">
            ${marketValSum.toLocaleString("en-US", { maximumFractionDigits: 2 })}
          </div>
          <div className="text-[10px] text-[#94A3B8] mt-1.5 uppercase tracking-wider">
            Exposure Level: {((marketValSum / equityNum) * 100).toFixed(1)}% of Net
          </div>
        </div>
      </div>

      {/* Positions Table */}
      <div>
        <h3 className="text-xs font-bold uppercase tracking-[0.15em] text-[#64748B] mb-4">Open Positions</h3>
        {positions.length === 0 ? (
          <div className="text-center py-8 bg-[#F8F9FA] rounded border border-dashed border-[#E9ECEF]">
            <p className="text-[#64748B] text-xs">No active paper positions are currently held.</p>
            <p className="text-[10px] text-[#94A3B8] uppercase mt-1 tracking-wider">Trigger a thesis sync to place automated orders.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-sans">
              <thead className="bg-[#F8F9FA] text-[#64748B] uppercase tracking-wider font-mono text-[10px] border-b border-[#E9ECEF]">
                <tr>
                  <th className="py-3 px-4">Ticker</th>
                  <th className="py-3 px-4 text-right">Shares</th>
                  <th className="py-3 px-4 text-right">Avg Buy Price</th>
                  <th className="py-3 px-4 text-right">Current Price</th>
                  <th className="py-3 px-4 text-right">Market Value</th>
                  <th className="py-3 px-4 text-right">Unrealized Return</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E9ECEF]">
                {positions.map((pos) => {
                  const pl = parseFloat(pos.unrealized_pl || "0");
                  const plPlc = parseFloat(pos.unrealized_plpc || "0") * 100;
                  const plLoss = pl < 0;
                  return (
                    <tr key={pos.symbol} className="hover:bg-[#F8F9FA]/80">
                      <td className="py-3.5 px-4 font-bold text-[#1A1A1A]">{pos.symbol}</td>
                      <td className="py-3.5 px-4 text-right font-mono font-medium text-[#1A1A1A]">{pos.qty}</td>
                      <td className="py-3.5 px-4 text-right text-[#64748B] font-mono">${parseFloat(pos.avg_entry_price).toFixed(2)}</td>
                      <td className="py-3.5 px-4 text-right font-semibold text-[#1A1A1A] font-mono">${parseFloat(pos.current_price).toFixed(2)}</td>
                      <td className="py-3.5 px-4 text-right font-semibold text-[#1A1A1A] font-mono">${parseFloat(pos.market_value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      <td className={`py-3.5 px-4 text-right font-bold ${plLoss ? "text-rose-600" : "text-[#10B981]"}`}>
                        <div className="flex items-center justify-end gap-0.5 font-mono">
                          {plLoss ? <ArrowDownRight className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
                          ${Math.abs(pl).toFixed(2)} ({plPlc.toFixed(2)}%)
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
