import { useState } from "react";
import { Mail, Youtube, ArrowUpRight, ArrowDownRight, Compass, HelpCircle, Activity } from "lucide-react";
import { StockAnalysis } from "../types";

interface ZipTraderCardProps {
  analyses: StockAnalysis[];
  onForceSync: () => Promise<void>;
  isSyncing: boolean;
}

export default function ZipTraderCard({ analyses, onForceSync, isSyncing }: ZipTraderCardProps) {
  const [activeTab, setActiveTab] = useState<"feed" | "theory">("feed");

  return (
    <div className="bg-white rounded border border-[#E9ECEF] p-6 flex flex-col h-full">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-[#E9ECEF] pb-4 mb-4 gap-4">
        <div>
          <span className="text-[10px] font-bold text-[#94A3B8] uppercase tracking-[0.2em] block mb-1">Thesis Intelligence</span>
          <h3 className="text-sm font-bold text-[#1A1A1A] flex items-center gap-1.5 uppercase tracking-wider">
            Sentiment Sentinel Feed
          </h3>
        </div>

        <button
          id="force-sync-btn"
          onClick={onForceSync}
          disabled={isSyncing}
          className="flex items-center justify-center gap-2 bg-[#1A1A1A] hover:bg-black text-white font-bold text-[10px] uppercase tracking-wider py-2 px-4 rounded border border-[#1A1A1A] transition-colors cursor-pointer disabled:bg-slate-100 disabled:text-slate-400 disabled:border-slate-200 disabled:cursor-not-allowed"
        >
          <Activity className={`h-3 w-3 ${isSyncing ? "animate-spin" : ""}`} />
          {isSyncing ? "SCANNING SOURCES..." : "SCAN GMAIL & YOUTUBE"}
        </button>
      </div>

      <div className="flex bg-[#F1F5F9] p-0.5 rounded border border-[#E2E8F0] mb-4">
        <button
          type="button"
          onClick={() => setActiveTab("feed")}
          className={`flex-1 py-1.5 px-3 text-[10px] font-bold uppercase tracking-wider rounded transition-colors cursor-pointer ${
            activeTab === "feed"
              ? "bg-[#1A1A1A] text-white"
              : "text-[#64748B] hover:text-[#1A1A1A]"
          }`}
        >
          RECENT FEEDS ({analyses.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("theory")}
          className={`flex-1 py-1.5 px-3 text-[10px] font-bold uppercase tracking-wider rounded transition-colors cursor-pointer ${
            activeTab === "theory"
              ? "bg-[#1A1A1A] text-white"
              : "text-[#64748B] hover:text-[#1A1A1A]"
          }`}
        >
          QUANT RISK CRITERIA
        </button>
      </div>

      <div className="flex-1 overflow-y-auto max-h-[450px] pr-1">
        {activeTab === "feed" ? (
          analyses.length === 0 ? (
            <div className="text-center py-12 text-[#64748B]">
              <Mail className="h-8 w-8 mx-auto stroke-1 mb-2 text-[#94A3B8]" />
              <p className="text-xs font-bold uppercase tracking-wider">No analysis logs detected.</p>
              <p className="text-[10px] text-[#94A3B8] uppercase mt-1 tracking-wider">Sync the sentiment sources to pull.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {analyses.map((an) => {
                const sentimentPos = an.sentimentScore >= 0;
                return (
                  <div
                    key={an.id}
                    className="p-5 rounded border border-[#E9ECEF] bg-[#F8F9FA] hover:bg-white hover:border-[#CBD5E1] transition-all"
                  >
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="flex items-center gap-2">
                        {an.source === "email" ? (
                          <span className="p-1.5 rounded bg-blue-100/60 text-blue-700">
                            <Mail className="h-3.5 w-3.5" />
                          </span>
                        ) : (
                          <span className="p-1.5 rounded bg-rose-100/60 text-rose-700">
                            <Youtube className="h-3.5 w-3.5" />
                          </span>
                        )}
                        <div>
                          <span className="text-[9px] text-[#94A3B8] font-mono uppercase tracking-wider block">
                            {an.source === "email" ? "GMail: charlie-from-ziptrader" : "YouTube Channel Video Scan"}
                          </span>
                          <h4 className="text-xs font-bold text-[#1A1A1A] line-clamp-1 mt-0.5">{an.sourceTitle}</h4>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[10px] font-mono font-bold bg-white px-2 py-0.5 rounded border border-[#E9ECEF] text-[#1A1A1A]">
                          {an.symbol}
                        </span>
                        <span className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded ${
                          an.decision === "BUY"
                            ? "bg-[#10B981]/15 text-[#10B981]"
                            : an.decision === "SELL"
                            ? "bg-rose-155 bg-rose-500/15 text-rose-600"
                            : "bg-[#F1F5F9] text-[#64748B]"
                        }`}>
                          {an.decision}
                        </span>
                      </div>
                    </div>

                    <p className="text-[#64748B] text-xs leading-relaxed italic bg-white p-3 rounded border border-[#E9ECEF] mb-4">
                      "{an.sourceContent}"
                    </p>

                    {/* Score Bar Indicators */}
                    <div className="grid grid-cols-2 gap-4 mb-4 border-b border-dashed border-[#E9ECEF] pb-4">
                      <div>
                        <div className="flex items-center justify-between text-[10px] mb-1">
                          <span className="text-[#64748B] font-medium uppercase tracking-wider">Growth Index</span>
                          <span className="font-bold text-[#1A1A1A] font-mono">{an.growthScore}%</span>
                        </div>
                        <div className="h-1 w-full bg-[#E9ECEF] rounded-full overflow-hidden">
                          <div
                            className="h-full bg-[#1A1A1A] rounded-full"
                            style={{ width: `${an.growthScore}%` }}
                          />
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center justify-between text-[10px] mb-1">
                          <span className="text-[#64748B] font-medium uppercase tracking-wider">Sentiment Score</span>
                          <span className={`${sentimentPos ? "text-[#10B981]" : "text-rose-500"} font-bold font-mono`}>
                            {sentimentPos ? "+" : ""}{an.sentimentScore}%
                          </span>
                        </div>
                        <div className="h-1 w-full bg-[#E9ECEF] rounded-full overflow-hidden relative">
                          <div
                            className={`h-full ${sentimentPos ? "bg-[#10B981]" : "bg-rose-500"} rounded-full absolute ${sentimentPos ? "left-1/2" : "right-1/2"}`}
                            style={{ width: `${Math.abs(an.sentimentScore) / 2}%` }}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Custom Whipsaw check details */}
                    <div className="mb-4 bg-amber-50 rounded border border-amber-200/60 p-3">
                      <div className="flex items-center gap-1.5 text-amber-800 font-bold text-[10px] uppercase tracking-wider mb-1">
                        <Activity className="h-3 w-3 text-amber-600" />
                        Pullback Volatility Assessment
                      </div>
                      <p className="text-amber-900/90 text-[11px] leading-relaxed font-sans">{an.whipsawCheck}</p>
                    </div>

                    {/* Risk & Core Reasoning Output */}
                    <div className="grid grid-cols-3 gap-2 text-[10px] mt-2">
                      <div className="bg-white p-2.5 rounded border border-[#E9ECEF] text-center">
                        <span className="text-[#94A3B8] font-bold uppercase tracking-wider block text-[9px]">Risk Level</span>
                        <span className={`font-bold uppercase tracking-wider block mt-1 text-[10px] ${
                          an.riskProfile === "High" ? "text-rose-500" : an.riskProfile === "Medium" ? "text-amber-600" : "text-[#10B981]"
                        }`}>
                          {an.riskProfile}
                        </span>
                      </div>

                      <div className="bg-white p-2.5 rounded border border-[#E9ECEF] col-span-2">
                        <span className="text-[#94A3B8] font-mono font-bold uppercase tracking-wider block text-[9px]">Signal Argument</span>
                        <span className="text-[#64748B] font-medium block mt-1 line-clamp-1">
                          {an.reasoning}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )
        ) : (
          <div className="space-y-4 text-xs leading-relaxed text-[#64748B]">
            <div className="bg-[#F8F9FA] rounded border border-[#E9ECEF] p-5">
              <h4 className="font-bold text-[#1A1A1A] text-xs uppercase tracking-wider flex items-center gap-1.5 mb-2">
                <HelpCircle className="h-4 w-4 text-[#1A1A1A]" />
                Whipsaw Valuation Verification
              </h4>
              <p className="text-[11px] text-[#64748B] leading-relaxed">
                Whipsaws represent technical headfakes where asset prices briefly breach supports owing to generalized market indices movements before returning to dominant levels. The platform's risk model executes these validation layers:
              </p>
              <ul className="list-disc list-inside space-y-1.5 mt-3 pl-1 text-[11px]">
                <li><strong className="text-[#1A1A1A] uppercase tracking-wider text-[10px]">Grounding Correlation:</strong> Compares current tickers pullbacks against SPY and QQQ indices variance.</li>
                <li><strong className="text-[#1A1A1A] uppercase tracking-wider text-[10px]">Sentiment Strength:</strong> Evaluates Charlie's conviction level inside emails and live sentiment feeds.</li>
                <li><strong className="text-[#1A1A1A] uppercase tracking-wider text-[10px]">Fundamental Guard:</strong> Enforces clean balance checks and revenue expansion patterns.</li>
                <li><strong className="text-[#1A1A1A] uppercase tracking-wider text-[10px]">Capital Threshold:</strong> Denies buys that risk over 10% total portfolio net liquification.</li>
              </ul>
            </div>

            <div className="border border-[#E9ECEF] rounded p-5 space-y-2">
              <h5 className="font-bold text-[#1A1A1A] uppercase tracking-wider text-xs">Automation Parameters</h5>
              <p className="text-[11px] leading-relaxed">
                The quant engine operates in a server-side cycle. Every 15 minutes, the system reads Charlie's letters, scans YouTube grounded metrics using Claude, executes paper instructions to Alpaca safely and routes real-time alerts to the active Telegram Chat Group as requested by user.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
