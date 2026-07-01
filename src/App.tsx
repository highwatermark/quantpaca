import { useState, useEffect } from "react";
import { motion } from "motion/react";
import {
  Compass,
  LayoutDashboard,
  ShieldAlert,
  Sliders,
  LogOut,
  RefreshCw,
  FolderLock,
  ArrowUpRight,
  TrendingUp,
  FileCheck2,
  LineChart
} from "lucide-react";
import { AppConfig, StockAnalysis, Trade, SyncLog, AlpacaPosition, AlpacaAccount } from "./types";
import PortfolioSummary from "./components/PortfolioSummary";
import ManualTradeCard from "./components/ManualTradeCard";
import ZipTraderCard from "./components/ZipTraderCard";
import TradeLogsTable from "./components/TradeLogsTable";
import SettingsCard from "./components/SettingsCard";
import ServerStatusLogs from "./components/ServerStatusLogs";
import AdminTokenCard from "./components/AdminTokenCard";
import { loginWithGoogle, logoutGoogle, getCachedToken, getGoogleUser, setCachedToken, setGoogleUser } from "./services/googleAuth";

function ReviewMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded border border-[#E9ECEF] bg-[#F8F9FA] p-3 min-h-[76px]">
      <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-[#94A3B8] mb-2">{label}</div>
      <div className="text-xs font-bold text-[#1A1A1A] uppercase truncate">{value}</div>
      <div className="text-[10px] text-[#64748B] font-mono mt-1 truncate">{detail}</div>
    </div>
  );
}

export default function App() {
  const [activePane, setActivePane] = useState<"dashboard" | "settings">("dashboard");

  // Configuration and Sync state
  const [configs, setConfigs] = useState<AppConfig | null>(null);
  const [analyses, setAnalyses] = useState<StockAnalysis[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [reviewConsole, setReviewConsole] = useState<Record<string, any>>({});

  // Alpaca paper states
  const [account, setAccount] = useState<AlpacaAccount>({
    cash: "100000.00",
    buying_power: "200000.00",
    portfolio_value: "100000.00",
    equity: "100000.00",
    long_market_value: "0.00",
    daytrade_count: 0
  });
  const [positions, setPositions] = useState<AlpacaPosition[]>([]);

  // Auth statuses
  const [googleUser, setUserGoogle] = useState<{ name: string; email: string } | null>(getGoogleUser());
  const [googleToken, setTokenGoogle] = useState<string | null>(getCachedToken());

  // Admin command token (localStorage-backed; sent as x-admin-token on admin routes)
  const [adminToken, setAdminToken] = useState<string>(
    () => localStorage.getItem("quantpaca_admin_token") || "",
  );
  const saveAdminToken = (token: string) => {
    localStorage.setItem("quantpaca_admin_token", token);
    setAdminToken(token);
  };
  const adminHeaders = (): Record<string, string> =>
    adminToken ? { "x-admin-token": adminToken } : {};

  // Loading indicator states
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isTrading, setIsTrading] = useState(false);
  const [isEmergencyClosing, setIsEmergencyClosing] = useState(false);

  // Load backend states on mount
  const fetchAllStates = async () => {
    try {
      const configRes = await fetch("/api/config");
      if (configRes.ok) {
        const confData = await configRes.json();
        setConfigs(confData);
      }

      const analysesRes = await fetch("/api/analyses");
      if (analysesRes.ok) setAnalyses(await analysesRes.json());

      const tradesRes = await fetch("/api/trades");
      if (tradesRes.ok) setTrades(await tradesRes.json());

      const logsRes = await fetch("/api/logs");
      if (logsRes.ok) setLogs(await logsRes.json());

      const portRes = await fetch("/api/portfolio");
      if (portRes.ok) {
        const pData = await portRes.json();
        setAccount(pData);
        setPositions(pData.positions || []);
      }

      const reviewEndpoints = [
        ["health", "/api/health"],
        ["regime", "/api/regime/latest"],
        ["portfolioAssessment", "/api/portfolio/assessment"],
        ["reviewedSignals", "/api/signals/reviewed"],
        ["tradeIntents", "/api/trade-intents"],
        ["riskDecisions", "/api/risk-decisions"],
        ["exitPlans", "/api/exit-plans"],
        ["reconciliation", "/api/reconciliation/latest"],
        ["audit", "/api/audit"],
        ["telegram", "/api/telegram/status"],
      ] as const;
      const entries = await Promise.all(reviewEndpoints.map(async ([key, url]) => {
        const response = await fetch(url);
        return [key, response.ok ? await response.json() : null];
      }));
      setReviewConsole(Object.fromEntries(entries));
    } catch (err) {
      console.error("Failed fetching data from the backend. Real routes missing?", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchAllStates();
    // Periodic poll for updates
    const timer = setInterval(() => {
      fetchAllStates();
    }, 15000);
    return () => clearInterval(timer);
  }, []);

  // Configuration updators
  const handleSaveConfig = async (updated: AppConfig) => {
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders() },
        body: JSON.stringify(updated),
      });
      if (res.ok) {
        const data = await res.json();
        setConfigs(data.config);
        fetchAllStates();
        alert("Settings configuration saved successfully.");
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || `Saving settings failed (HTTP ${res.status}). Check the admin token in Settings.`);
      }
    } catch (err) {
      console.error("Save config error:", err);
      alert("Saving settings failed: network error.");
    }
  };

  // Sync core logic triggering (checks GMail and does Gemini calculations)
  const handleForceSync = async () => {
    setIsSyncing(true);
    try {
      // Pass oauth token in authorization header if logged in
      const headers: HeadersInit = {
        ...(googleToken ? { Authorization: `Bearer ${googleToken}` } : {}),
        ...adminHeaders(),
      };
      const res = await fetch("/api/sync", {
        method: "POST",
        headers,
      });
      if (res.ok) {
        await fetchAllStates();
      } else {
        const data = await res.json();
        alert(data.error || "Sync command is disabled.");
      }
    } catch (err) {
      console.error("Sync error:", err);
    } finally {
      setIsSyncing(false);
    }
  };

  // Execute custom manual trade override
  const handleManualTrade = async (symbol: string, qty: number, side: "buy" | "sell", price: number) => {
    setIsTrading(true);
    try {
      const headers: HeadersInit = { "Content-Type": "application/json", ...adminHeaders() };
      if (googleToken) headers["Authorization"] = `Bearer ${googleToken}`;

      const res = await fetch("/api/override/trade", {
        method: "POST",
        headers,
        body: JSON.stringify({ symbol, qty, side, price }),
      });
      if (res.ok) {
        const data = await res.json();
        alert(`Override order state: ${data.trade?.status || "submitted"}.`);
        await fetchAllStates();
      } else {
        const data = await res.json();
        alert(data.error || "Manual override is disabled.");
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsTrading(false);
    }
  };

  // Clear-out sequence override
  const handleEmergencyClose = async () => {
    setIsEmergencyClosing(true);
    try {
      const res = await fetch("/api/override/close-all", {
        method: "POST",
        headers: adminHeaders(),
      });
      if (res.ok) {
        alert("Emergency close request submitted through the risk pipeline.");
        await fetchAllStates();
      } else {
        const data = await res.json();
        alert(data.error || "Emergency close is disabled.");
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsEmergencyClosing(false);
    }
  };

  // Google Login / Logout handlers
  const handleGoogleLogin = async () => {
    try {
      const response = await loginWithGoogle();
      setUserGoogle({ name: response.name, email: response.email });
      setTokenGoogle(response.token);
      alert("Connected to Google Workspace APIs successfully.");
      fetchAllStates();
    } catch (err) {
      console.error(err);
    }
  };

  const handleGoogleLogout = () => {
    logoutGoogle();
    setUserGoogle(null);
    setTokenGoogle(null);
    alert("Google Workspace connection disconnected.");
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="h-8 w-8 text-indigo-600 animate-spin" />
          <p className="text-zinc-600 text-sm font-semibold tracking-wide">
            Accessing Quant Platform Control Desk...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] flex flex-col font-sans">
      {/* 1. System Navigation Ribbon header */}
      <header className="sticky top-0 z-50 h-16 bg-white border-b border-[#E9ECEF] px-8 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="w-8 h-8 bg-[#1A1A1A] rounded flex items-center justify-center shrink-0">
            <div className="w-3.5 h-3.5 bg-white rotate-45"></div>
          </div>
          <div>
            <h1 className="text-sm font-bold text-[#1A1A1A] tracking-tight uppercase leading-none">
              Quantpaca Engine <span className="text-[#94A3B8] font-normal tracking-normal ml-2">v2.4.0</span>
            </h1>
            <p className="text-[10px] text-[#64748B] font-medium uppercase font-mono tracking-wider mt-1.5">
              Active Alpha • Shadow Quantitative Paper Mode
            </p>
          </div>
        </div>

        {/* Action states panel */}
        <div className="flex items-center gap-6">
          <div className="hidden md:flex items-center gap-4 text-[11px] font-mono">
            <div className="flex items-center gap-2 text-[#64748B]">
              <span className="w-2 h-2 rounded-full bg-[#10B981] animate-pulse"></span>
              <span className="uppercase tracking-wider font-medium">Alpaca Paper: Active</span>
            </div>

            {googleToken ? (
              <div className="flex items-center gap-2 text-[#10B981]">
                <span className="w-2 h-2 rounded-full bg-[#10B981]"></span>
                <span className="uppercase tracking-wider font-medium">Sheets & Gmail: Live</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-[#94A3B8]">
                <span className="w-2 h-2 rounded-full bg-[#94A3B8]"></span>
                <span className="uppercase tracking-wider font-medium">Offline Shadow Mode</span>
              </div>
            )}
          </div>

          <div className="flex bg-[#F1F5F9] p-0.5 rounded border border-[#E2E8F0]">
            <button
              id="view-pane-dashboard"
              onClick={() => setActivePane("dashboard")}
              className={`flex items-center gap-1.5 text-[11px] font-bold py-1 px-3 rounded uppercase tracking-wider transition-all cursor-pointer ${
                activePane === "dashboard"
                  ? "bg-[#1A1A1A] text-white"
                  : "text-[#64748B] hover:text-[#1A1A1A]"
              }`}
            >
              <LayoutDashboard className="h-3 w-3" />
              Dashboard
            </button>
            <button
              id="view-pane-settings"
              onClick={() => setActivePane("settings")}
              className={`flex items-center gap-1.5 text-[11px] font-bold py-1 px-3 rounded uppercase tracking-wider transition-all cursor-pointer ${
                activePane === "settings"
                  ? "bg-[#1A1A1A] text-white"
                  : "text-[#64748B] hover:text-[#1A1A1A]"
              }`}
            >
              <Sliders className="h-3 w-3" />
              Settings
            </button>
          </div>
        </div>
      </header>

      {/* 2. Main content container */}
      <main className="flex-1 p-6 max-w-7xl mx-auto w-full">
        {activePane === "dashboard" ? (
          <div className="space-y-6">
            {/* Top row widget summary cards */}
            <PortfolioSummary
              account={account}
              positions={positions}
              onEmergencyClose={handleEmergencyClose}
              isEmergencyClosing={isEmergencyClosing}
              autoTrading={configs?.system.autoTrading || false}
            />

            {/* Middle Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Left dynamic column */}
              <div className="lg:col-span-4 space-y-6 flex flex-col justify-between h-full">
                <ManualTradeCard
                  onExecuteTrade={handleManualTrade}
                  isTrading={isTrading}
                />

                {/* Simulated performance equity card */}
                <div className="bg-white rounded border border-[#E9ECEF] p-6 flex-1 mt-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-[#94A3B8]">
                      Performance Alpha Curve
                    </h3>
                    <LineChart className="h-4 w-4 text-[#1A1A1A]" />
                  </div>
                  <div className="text-xs text-[#64748B] leading-normal mb-4 font-sans">
                    Visualization tracking total equity since deployment on June 1, 2026.
                  </div>
                  
                  {/* Decorative custom vector SVG performance chart */}
                  <div className="h-28 w-full bg-[#F8F9FA] rounded border border-[#E9ECEF] relative overflow-hidden p-2 flex items-end">
                    <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 100">
                      <defs>
                        <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#1A1A1A" stopOpacity="0.1"/>
                          <stop offset="100%" stopColor="#1A1A1A" stopOpacity="0.0"/>
                        </linearGradient>
                      </defs>
                      {/* Gradient Fill */}
                      <path d="M 0 60 Q 25 55 50 48 T 100 35 L 100 100 L 0 100 Z" fill="url(#chartGradient)" />
                      {/* Grid Lines */}
                      <line x1="0" y1="50" x2="100" y2="50" stroke="#E9ECEF" strokeWidth="0.5" strokeDasharray="3,3" />
                      {/* Line Plot */}
                      <path d="M 0 60 Q 25 55 50 48 T 100 35" fill="none" stroke="#1A1A1A" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                    <div className="z-10 flex justify-between w-full text-[10px] text-[#64748B] font-mono">
                      <span>June 1</span>
                      <span className="font-bold text-[#10B981] bg-white px-2 py-0.5 rounded border border-[#E9ECEF] flex items-center gap-0.5 shadow-sm">
                        <ArrowUpRight className="h-3 w-3" /> $100k Net
                      </span>
                    </div>
                  </div>
                  <div className="mt-4 flex items-center justify-between text-[11px] font-mono text-[#64748B] pt-3 border-t border-[#F1F5F9]">
                    <span>Target Return: +15.0%</span>
                    <span>Hold Drawdown limit: 5%</span>
                  </div>
                </div>
              </div>

              {/* Right research column */}
              <div className="lg:col-span-8 flex flex-col">
                <ZipTraderCard
                  analyses={analyses}
                  onForceSync={handleForceSync}
                  isSyncing={isSyncing}
                />
              </div>
            </div>

            {/* Bottom Row Audit Trail logs */}
            <div className="bg-white rounded border border-[#E9ECEF] p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-[#94A3B8]">
                  Production Review Console
                </h3>
                <ShieldAlert className="h-4 w-4 text-[#1A1A1A]" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 text-[11px]">
                <ReviewMetric label="Broker Health" value={reviewConsole.health?.ok ? "OK" : "Check"} detail={reviewConsole.health?.broker?.tradingMode || "paper"} />
                <ReviewMetric label="Regime" value={reviewConsole.regime?.marketMode || "unknown"} detail={reviewConsole.regime?.tradePermission || "reduce_size"} />
                <ReviewMetric label="Portfolio Risk" value={`${reviewConsole.portfolioAssessment?.totalLongExposurePercent ?? 0}% long`} detail={`${reviewConsole.portfolioAssessment?.pendingOrderNotional ?? 0} pending`} />
                <ReviewMetric label="Telegram" value={reviewConsole.telegram?.configured ? "Configured" : "Not Configured"} detail={`${reviewConsole.telegram?.adminsConfigured ?? 0} admins`} />
                <ReviewMetric label="Reviewed Signals" value={String(reviewConsole.reviewedSignals?.length ?? 0)} detail="normalized" />
                <ReviewMetric label="Trade Intents" value={String(reviewConsole.tradeIntents?.length ?? 0)} detail="pipeline records" />
                <ReviewMetric label="Risk Decisions" value={String(reviewConsole.riskDecisions?.length ?? 0)} detail="central engine" />
                <ReviewMetric label="Exit Plans" value={String(reviewConsole.exitPlans?.length ?? 0)} detail="attached plans" />
                <ReviewMetric label="Reconciliation" value={reviewConsole.reconciliation?.status || "not run"} detail={`${reviewConsole.reconciliation?.mismatches?.length ?? 0} mismatches`} />
                <ReviewMetric label="Audit Events" value={String(reviewConsole.audit?.length ?? 0)} detail="append-only" />
              </div>
            </div>

            <TradeLogsTable trades={trades} />

            {/* Terminal console status feed output logs */}
            <ServerStatusLogs logs={logs} />
          </div>
        ) : (
          <div className="space-y-6">
            <AdminTokenCard token={adminToken} onSaveToken={saveAdminToken} />
            {configs ? (
              <SettingsCard
                config={configs}
                onSaveConfig={handleSaveConfig}
                googleUser={googleUser}
                googleToken={googleToken}
                onGoogleLogin={handleGoogleLogin}
                onGoogleLogout={handleGoogleLogout}
              />
            ) : (
              <div className="p-12 text-center text-[#64748B] bg-white border border-[#E9ECEF] rounded">
                <span className="text-xs uppercase font-bold tracking-wider">Loading system config specifications...</span>
              </div>
            )}
          </div>
        )}
      </main>

      <footer className="bg-white border-t border-[#E9ECEF] py-8 px-8 mt-12">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-[11px] text-[#94A3B8] font-mono">
          <div className="uppercase tracking-wider">
            &copy; 2026 Stockton Quantitative Automation Lab. Shadow Paper Trading Mode.
          </div>
          <div className="flex items-center gap-1.5 text-[#64748B] uppercase tracking-wider">
            <FolderLock className="h-3.5 w-3.5 text-[#94A3B8]" />
            Broker credentials are loaded from environment variables only.
          </div>
        </div>
      </footer>
    </div>
  );
}
