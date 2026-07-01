import { useState, FormEvent } from "react";
import { Settings, Save, AlertCircle, RefreshCw, Key, ShieldAlert } from "lucide-react";
import { AppConfig } from "../types";

interface SettingsCardProps {
  config: AppConfig;
  onSaveConfig: (newConfig: AppConfig) => Promise<void>;
  googleUser: { name: string; email: string } | null;
  googleToken: string | null;
  onGoogleLogin: () => Promise<void>;
  onGoogleLogout: () => void;
}

export default function SettingsCard({
  config,
  onSaveConfig,
  googleUser,
  googleToken,
  onGoogleLogin,
  onGoogleLogout,
}: SettingsCardProps) {
  const [alpacaKey, setAlpacaKey] = useState(config.alpaca.apiKeyId || "");
  const [alpacaSecret, setAlpacaSecret] = useState(config.alpaca.secretKey || "");
  const [paper, setPaper] = useState(config.alpaca.paper);

  const [notionToken, setNotionToken] = useState(config.notion.token || "");
  const [notionDb, setNotionDb] = useState(config.notion.databaseId || "");

  const [telegramToken, setTelegramToken] = useState(config.telegram.botToken || "");
  const [telegramChat, setTelegramChat] = useState(config.telegram.chatId || "");
  const [telegramEnabled, setTelegramEnabled] = useState(config.telegram.enabled);

  const [sheetId, setSheetId] = useState(config.google.spreadsheetId || "");
  const [sheetEnabled, setSheetEnabled] = useState(config.google.enabled);

  const [autoTrading, setAutoTrading] = useState(config.system.autoTrading);
  const [stopLoss, setStopLoss] = useState(config.system.stopLossPercent);
  const [maxPosition, setMaxPosition] = useState(config.system.maxPositionSizePercent);

  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      const updatedConfig: AppConfig = {
        alpaca: {
          apiKeyId: alpacaKey,
          secretKey: alpacaSecret,
          paper,
        },
        notion: {
          token: notionToken,
          databaseId: notionDb,
        },
        telegram: {
          botToken: telegramToken,
          chatId: telegramChat,
          enabled: telegramEnabled,
        },
        google: {
          spreadsheetId: sheetId,
          enabled: sheetEnabled,
        },
        system: {
          autoTrading,
          runIntervalMins: config.system.runIntervalMins || 15,
          maxPositionSizePercent: maxPosition,
          stopLossPercent: stopLoss,
          targetProfitPercent: config.system.targetProfitPercent || 15,
        },
      };
      await onSaveConfig(updatedConfig);
    } catch (err) {
      console.error(err);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="bg-white rounded border border-[#E9ECEF] p-8">
      <div className="flex items-center justify-between border-b border-[#E9ECEF] pb-4 mb-6">
        <h3 className="text-sm font-bold text-[#1A1A1A] flex items-center gap-2 uppercase tracking-wide">
          <Settings className="h-4 w-4 text-[#94A3B8]" />
          Settings Config & Risk Matrix
        </h3>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {/* Section 1: Google login container */}
        <div className="p-5 bg-[#F8F9FA] border border-[#E9ECEF] rounded">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h4 className="text-xs font-bold text-[#1A1A1A] uppercase tracking-wider flex items-center gap-1">
                Google Workspace Authorization
              </h4>
              <p className="text-[11px] text-[#64748B] leading-relaxed mt-1.5 font-sans">
                Enables reading emails from <b>charlie-from-ziptrader@ghost.io</b> and auto-logging executed transactions to Google Sheets.
              </p>
            </div>

            {googleToken ? (
              <span className="shrink-0 px-2.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/25">
                OAUTH CONCURRENT
              </span>
            ) : (
              <span className="shrink-0 px-2.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-slate-100 text-slate-500 border border-slate-200">
                OFFLINE PAPER SHADOW ONLY
              </span>
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 pt-4 border-t border-[#E9ECEF]">
            {googleToken ? (
              <div className="flex items-center justify-between w-full">
                <div className="text-[#64748B] text-xs font-medium">
                   Logged in: <span className="font-bold text-[#1A1A1A]">{googleUser?.email || "hariase@gmail.com"}</span>
                </div>
                <button
                  id="google-sign-out-btn"
                  type="button"
                  onClick={onGoogleLogout}
                  className="text-xs text-rose-500 hover:text-rose-600 font-bold uppercase tracking-wider cursor-pointer"
                >
                  Disconnect Google
                </button>
              </div>
            ) : (
              <button
                id="google-sign-in-btn"
                type="button"
                onClick={onGoogleLogin}
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#1A1A1A] hover:bg-black text-white text-[10px] font-bold uppercase tracking-wider rounded border border-[#1A1A1A] cursor-pointer transition-colors"
              >
                <svg className="h-3.5 w-3.5 fill-current" viewBox="0 0 24 24">
                  <path d="M12.24 10.285V14.4h6.887c-.275 1.564-1.78 4.594-6.887 4.594-4.42 0-8.02-3.66-8.02-8.18s3.6-8.18 8.02-8.18c2.51 0 4.2 1.04 5.16 1.96l3.24-3.12C18.64 1.77 15.7 1 12.24 1 5.48 1 0 6.48 0 13.24s5.48 12.24 12.24 12.24c7.06 0 11.76-4.96 11.76-11.96 0-.81-.09-1.42-.2-1.96H12.24z" />
                </svg>
                Connect to Gmail & Sheets (Google OAuth)
              </button>
            )}
          </div>
        </div>

        {/* Section 2: Trading Engine Mode */}
        <div className="border border-[#E9ECEF] rounded p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-xs font-bold text-[#1A1A1A] uppercase tracking-wider">Autonomous Trading Routine</h4>
              <p className="text-[10.5px] text-[#64748B] mt-1 font-sans">Allow the platform to automatically execution buy/sell rules based on sentiment.</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                id="toggle-autotrading"
                type="checkbox"
                checked={autoTrading}
                onChange={(e) => setAutoTrading(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#10B981] cursor-pointer"></div>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-4 pt-2">
            <div>
              <label htmlFor="max-allocation-input" className="block text-[10px] text-[#64748B] font-bold uppercase tracking-wider mb-2">Max allocation Limit</label>
              <div className="relative">
                <input
                  id="max-allocation-input"
                  type="number"
                  value={maxPosition}
                  onChange={(e) => setMaxPosition(Number(e.target.value))}
                  className="w-full bg-[#F8F9FA] text-xs border border-[#E9ECEF] rounded p-2 font-mono text-[#1A1A1A] outline-none focus:border-[#1A1A1A]"
                />
                <span className="absolute right-3 top-2.5 text-[10px] text-[#94A3B8] font-mono">% Port</span>
              </div>
            </div>
            <div>
              <label htmlFor="stop-loss-input" className="block text-[10px] text-[#64748B] font-bold uppercase tracking-wider mb-2">Stop Loss Tolerance</label>
              <div className="relative">
                <input
                  id="stop-loss-input"
                  type="number"
                  value={stopLoss}
                  onChange={(e) => setStopLoss(Number(e.target.value))}
                  className="w-full bg-[#F8F9FA] text-xs border border-[#E9ECEF] rounded p-2 font-mono text-[#1A1A1A] outline-none focus:border-[#1A1A1A]"
                />
                <span className="absolute right-3 top-2.5 text-[10px] text-[#94A3B8] font-mono">% Drop</span>
              </div>
            </div>
          </div>
        </div>

        {/* Section 3: API Configurations */}
        <div className="space-y-4">
          <h4 className="text-xs font-bold text-[#1A1A1A] uppercase tracking-wider flex items-center gap-1.5 border-b border-[#E9ECEF] pb-2">
            <Key className="h-3.5 w-3.5 text-[#94A3B8]" /> API Access Keys
          </h4>

          {/* Alpaca */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="alpaca-key-input" className="block text-[10px] font-mono font-bold text-[#64748B] uppercase">Alpaca API Key ID</label>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-[#94A3B8] uppercase">Paper simulation</span>
                <input
                  id="toggle-paper"
                  type="checkbox"
                  checked={paper}
                  onChange={(e) => setPaper(e.target.checked)}
                  className="rounded text-[#1A1A1A] h-3.5 w-3.5 cursor-pointer accent-black"
                />
              </div>
            </div>
            <input
              id="alpaca-key-input"
              type="text"
              value={alpacaKey}
              onChange={(e) => setAlpacaKey(e.target.value)}
              placeholder="Keep blank to run on simulated shadow paper"
              className="w-full text-xs bg-[#F8F9FA] border border-[#E9ECEF] focus:border-[#1A1A1A] rounded p-2.5 font-mono text-[#1A1A1A] outline-none"
            />
            <input
              id="alpaca-secret-input"
              type="password"
              value={alpacaSecret}
              onChange={(e) => setAlpacaSecret(e.target.value)}
              placeholder="Alpaca Secret Access Key"
              className="w-full text-xs bg-[#F8F9FA] border border-[#E9ECEF] focus:border-[#1A1A1A] rounded p-2.5 font-mono text-[#1A1A1A] outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* Notion */}
            <div className="space-y-1.5">
              <label htmlFor="notion-token-input" className="block text-[10px] font-mono font-bold text-[#64748B] uppercase">Notion Secret Token</label>
              <input
                id="notion-token-input"
                type="password"
                value={notionToken}
                onChange={(e) => setNotionToken(e.target.value)}
                placeholder="secret_notion_token"
                className="w-full text-xs bg-[#F8F9FA] border border-[#E9ECEF] focus:border-[#1A1A1A] rounded p-2.5 font-mono text-[#1A1A1A] outline-none"
              />
              <input
                id="notion-db-input"
                type="text"
                value={notionDb}
                onChange={(e) => setNotionDb(e.target.value)}
                placeholder="Database ID (32 digit hash)"
                className="w-full text-xs bg-[#F8F9FA] border border-[#E9ECEF] focus:border-[#1A1A1A] rounded p-2.5 font-mono text-[#1A1A1A] outline-none"
              />
            </div>

            {/* Telegram */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label htmlFor="telegram-token-input" className="block text-[10px] font-mono font-bold text-[#64748B] uppercase">Telegram Bot Token</label>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] font-mono text-[#94A3B8] uppercase">On</span>
                  <input
                    id="toggle-telegram"
                    type="checkbox"
                    checked={telegramEnabled}
                    onChange={(e) => setTelegramEnabled(e.target.checked)}
                    className="rounded text-[#1A1A1A] h-3.5 w-3.5 cursor-pointer accent-black"
                  />
                </div>
              </div>
              <input
                id="telegram-token-input"
                type="password"
                value={telegramToken}
                onChange={(e) => setTelegramToken(e.target.value)}
                placeholder="e.g. 123456:ABC-DEF"
                className="w-full text-xs bg-[#F8F9FA] border border-[#E9ECEF] focus:border-[#1A1A1A] rounded p-2.5 font-mono text-[#1A1A1A] outline-none"
              />
              <input
                id="telegram-chat-input"
                type="text"
                value={telegramChat}
                onChange={(e) => setTelegramChat(e.target.value)}
                placeholder="Group Chat Channel ID"
                className="w-full text-xs bg-[#F8F9FA] border border-[#E9ECEF] focus:border-[#1A1A1A] rounded p-2.5 font-mono text-[#1A1A1A] outline-none"
              />
            </div>
          </div>

          {/* Google Sheets Spreadsheet ID */}
          <div className="space-y-1.5 border-t border-[#E9ECEF] pt-4">
            <div className="flex items-center justify-between">
              <label htmlFor="sheet-id-input" className="block text-[10px] font-mono font-bold text-[#64748B] uppercase">Google Sheet Spreadsheet ID</label>
              <div className="flex items-center gap-1">
                <span className="text-[10px] font-mono text-[#94A3B8] uppercase">Enable Export</span>
                <input
                  id="toggle-sheets"
                  type="checkbox"
                  checked={sheetEnabled}
                  onChange={(e) => setSheetEnabled(e.target.checked)}
                  className="rounded text-[#1A1A1A] h-3.5 w-3.5 cursor-pointer accent-black"
                />
              </div>
            </div>
            <input
              id="sheet-id-input"
              type="text"
              value={sheetId}
              onChange={(e) => setSheetId(e.target.value)}
              placeholder="e.g. 1aBCDeFGhiJK_lM-nOpqRsTuVwXyZ"
              className="w-full text-xs bg-[#F8F9FA] border border-[#E9ECEF] focus:border-[#1A1A1A] rounded p-2.5 font-mono text-[#1A1A1A] outline-none"
            />
          </div>
        </div>

        {/* Submit */}
        <div className="pt-4 border-t border-[#E9ECEF] flex items-center justify-end">
          <button
            id="save-config-btn"
            type="submit"
            disabled={isSaving}
            className="flex items-center gap-2 px-5 py-3 bg-[#1A1A1A] hover:bg-black text-white font-bold text-[10px] uppercase tracking-wider rounded transition-colors cursor-pointer disabled:bg-slate-100 disabled:text-slate-400 disabled:border-slate-200 disabled:cursor-not-allowed"
          >
            <Save className={`h-4 w-4 ${isSaving ? "animate-spin" : ""}`} />
            {isSaving ? "Saving..." : "Save Settings Properties"}
          </button>
        </div>
      </form>
    </div>
  );
}
