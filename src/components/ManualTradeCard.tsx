import { useState, FormEvent } from "react";
import { Play, ArrowRightLeft } from "lucide-react";

interface ManualTradeCardProps {
  onExecuteTrade: (symbol: string, qty: number, side: "buy" | "sell", price: number) => Promise<void>;
  isTrading: boolean;
  disabled?: boolean;
}

export default function ManualTradeCard({ onExecuteTrade, isTrading, disabled = true }: ManualTradeCardProps) {
  const [symbol, setSymbol] = useState("PLTR");
  const [qty, setQty] = useState(50);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [price, setPrice] = useState(41.50);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!symbol || qty <= 0 || price <= 0) return;
    
    const confirmMsg = `MANUAL OVERRIDE: Are you sure you want to trade ${qty} shares of ${symbol.toUpperCase()} (${side.toUpperCase()}) at approximately $${price} per share?`;
    if (window.confirm(confirmMsg)) {
      onExecuteTrade(symbol.toUpperCase().trim(), qty, side, price);
    }
  };

  return (
    <div className="bg-white rounded border border-[#E9ECEF] p-6">
      <h3 className="text-[10px] font-bold text-[#94A3B8] uppercase tracking-[0.2em] flex items-center gap-2 mb-4">
        <ArrowRightLeft className="h-3.5 w-3.5 text-[#94A3B8]" />
        Manual Override Control Deck
      </h3>

      <form onSubmit={handleSubmit} className="space-y-4">
        {disabled ? (
          <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-800">
            Manual UI trading is disabled. Broker-affecting commands require the server admin token and the shared risk pipeline.
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[#64748B] font-bold text-[10px] uppercase tracking-wider mb-2">
              Side
            </label>
            <div className="flex rounded bg-[#F8F9FA] p-0.5 border border-[#E9ECEF]">
            <button
                type="button"
                disabled={disabled}
                onClick={() => setSide("buy")}
                className={`flex-1 py-1 px-3 text-[10px] font-bold rounded uppercase tracking-wider transition-all cursor-pointer ${
                  side === "buy"
                    ? "bg-[#10B981] text-white"
                    : "text-[#64748B] hover:text-[#1A1A1A]"
                }`}
              >
                BUY
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => setSide("sell")}
                className={`flex-1 py-1 px-3 text-[10px] font-bold rounded uppercase tracking-wider transition-all cursor-pointer ${
                  side === "sell"
                    ? "bg-rose-500 text-white"
                    : "text-[#64748B] hover:text-[#1A1A1A]"
                }`}
              >
                SELL
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="ticker-input" className="block text-[#64748B] font-bold text-[10px] uppercase tracking-wider mb-2">
              Ticker Symbol
            </label>
            <input
              id="ticker-input"
              type="text"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              placeholder="e.g. PLTR"
              required
              disabled={disabled}
              className="w-full text-xs font-bold uppercase bg-[#F8F9FA] border border-[#E9ECEF] focus:border-[#1A1A1A] focus:bg-white rounded p-2 transition-all text-[#1A1A1A] outline-none font-mono"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="shares-input" className="block text-[#64748B] font-bold text-[10px] uppercase tracking-wider mb-2">
              Shares Count
            </label>
            <input
              id="shares-input"
              type="number"
              min="1"
              value={qty}
              onChange={(e) => setQty(Math.max(1, parseInt(e.target.value) || 0))}
              required
              disabled={disabled}
              className="w-full text-xs bg-[#F8F9FA] border border-[#E9ECEF] focus:border-[#1A1A1A] focus:bg-white rounded p-2 transition-all font-mono font-medium text-[#1A1A1A] outline-none"
            />
          </div>

          <div>
            <label htmlFor="price-input" className="block text-[#64748B] font-bold text-[10px] uppercase tracking-wider mb-2">
              Approx Price ($)
            </label>
            <input
              id="price-input"
              type="number"
              step="0.01"
              min="0.10"
              value={price}
              onChange={(e) => setPrice(Math.max(0.1, parseFloat(e.target.value) || 0))}
              required
              disabled={disabled}
              className="w-full text-xs bg-[#F8F9FA] border border-[#E9ECEF] focus:border-[#1A1A1A] focus:bg-white rounded p-2 transition-all font-mono font-medium text-[#1A1A1A] outline-none"
            />
          </div>
        </div>

        <div className="pt-3 border-t border-[#F1F5F9] flex items-center justify-between gap-4">
          <div className="text-[#94A3B8] font-mono text-[10px] uppercase tracking-wider">
            Est. Value: <span className="font-bold text-[#1a1a1a]">${(qty * price).toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
          </div>

          <button
            id="manual-override-submit-btn"
            type="submit"
            disabled={isTrading || disabled}
            className={`flex items-center gap-1.5 px-3.5 py-2 text-[10px] font-bold rounded uppercase tracking-wider text-white transition-all cursor-pointer ${
              side === "buy"
                ? "bg-[#10B981] hover:bg-[#0fa472] border border-[#0fa472]/20"
                : "bg-rose-500 hover:bg-rose-600 border border-rose-600/20"
            } disabled:bg-[#F8F9FA] disabled:text-[#94A3B8] disabled:border-[#E8ECEF] disabled:cursor-not-allowed`}
          >
            <Play className="h-3 w-3" />
            {isTrading ? "Executing..." : `Execute Override`}
          </button>
        </div>
      </form>
    </div>
  );
}
