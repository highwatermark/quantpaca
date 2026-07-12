import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { AppConfig, StockAnalysis, Trade, SyncLog } from "./src/types";
import {
  AuditEvent,
  BrokerConfig,
  buildBrokerConfigFromEnv,
  redactConfigForClient,
  stripPersistedSecrets,
  submitTradeThroughPipeline,
  TradeRequest,
} from "./src/server/tradingSafety";
import { createProductionStore } from "./src/server/persistence";
import { createRawSignal } from "./src/server/signalEngine";
import { reviewAndPersistSignal } from "./src/server/signalReviewStep";
import { extractEmailScanTarget, EmailScanTarget } from "./src/server/emailIngestion";
import { detectRegime } from "./src/server/regimeEngine";
import { assessPortfolio } from "./src/server/portfolioEngine";
import { reconcileBrokerState } from "./src/server/reconciliationEngine";
import { authorizeTelegramCommand, ConfirmationToken, consumeConfirmationToken, createConfirmationToken, parseTelegramAdminRoles } from "./src/server/telegramEngine";
import { createExitPlan } from "./src/server/exitEngine";
import { reviewRisk } from "./src/server/riskEngine";
import { evaluateBreaker } from "./src/server/breakerEngine";
import { validateStartupEnv } from "./src/server/startupChecks";
import { installProcessGuards } from "./src/server/processGuards";
import { loadRiskLimits, RiskLimits } from "./src/server/riskLimits";
import { sizeTradeIntent } from "./src/server/sizingEngine";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

const DATA_DIR = process.env.QUANTPACA_DATA_DIR || path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const productionStore = createProductionStore(path.join(DATA_DIR, "quantpaca.sqlite"));

// Simple queue-based lock to serialize all operations that read or write to DB
class DBConcurrencyMutex {
  private queue: (() => void)[] = [];
  private locked = false;

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const release = () => {
        if (this.queue.length > 0) {
          const next = this.queue.shift();
          next?.();
        } else {
          this.locked = false;
        }
      };

      if (!this.locked) {
        this.locked = true;
        resolve(release);
      } else {
        this.queue.push(() => {
          resolve(release);
        });
      }
    });
  }
}

const dbMutex = new DBConcurrencyMutex();

// Risk limits load ONCE at module scope (not inside run()) so that test imports of
// server.ts also get valid limits. See docs/LOOP_ARCHITECTURE.md "Structural
// Immutability of Risk Thresholds" — limits are fatal at startup if unparsable and are
// never re-read at runtime.
let riskLimits: RiskLimits;
{
  const loaded = loadRiskLimits(process.env);
  if (loaded.ok === false) {
    for (const error of loaded.errors) console.error(`[startup:fatal] ${error}`);
    console.error("[startup] Invalid risk limit configuration. Refusing to start.");
    process.exit(1);
  }
  riskLimits = loaded.limits;
}

const getBrokerConfig = () => buildBrokerConfigFromEnv(process.env);

function appendAuditEvents(db: any, events: AuditEvent[]) {
  db.auditEvents = db.auditEvents || [];
  db.auditEvents.push(...events);
  productionStore.appendAuditEvents(events);
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireAdminCommand(req: express.Request, res: express.Response, next: express.NextFunction) {
  const expectedToken = process.env.ADMIN_API_TOKEN;
  if (!expectedToken) {
    res.status(503).json({
      error: "Admin command routes are disabled until ADMIN_API_TOKEN is configured.",
    });
    return;
  }
  const providedToken = req.header("x-admin-token") || "";
  if (!tokensMatch(providedToken, expectedToken)) {
    res.status(401).json({ error: "Unauthorized command request." });
    return;
  }
  next();
}

async function executeTradeIntent(input: {
  db: any;
  config: AppConfig;
  request: TradeRequest;
  maxNotional?: number;
}) {
  const brokerConfig = getBrokerConfig();
  const portfolio = await getAlpacaPortfolio(brokerConfig);
  const portfolioAssessment = assessPortfolio({
    account: portfolio,
    positions: portfolio.positions || [],
    openOrders: await getAlpacaOpenOrders(brokerConfig),
    source: brokerConfig.configured ? "alpaca" : "local_simulated_snapshot",
  });
  const previousBreaker = productionStore.latestBreakerState<{ peakEquity: number | null }>();
  const breakerState = evaluateBreaker({
    equity: portfolio.equity,
    // Simulated portfolios have no prior-close equity; treating equity as last_equity
    // zeroes the daily-loss check offline. A REAL broker account must supply last_equity —
    // no fallback when brokerConfig.configured is true.
    lastEquity: brokerConfig.configured ? portfolio.last_equity : (portfolio.last_equity ?? portfolio.equity),
    previousPeakEquity: previousBreaker?.peakEquity ?? null,
    baselineEquity: riskLimits.baselineEquity,
    limits: {
      maxDailyLossPercent: riskLimits.maxDailyLossPercent,
      maxDrawdownFromPeakPercent: riskLimits.maxDrawdownFromPeakPercent,
      maxDrawdownFromBaselinePercent: riskLimits.maxDrawdownFromBaselinePercent,
    },
  });
  productionStore.saveBreakerState(breakerState);
  const exitPlan = createExitPlan({
    symbol: input.request.symbol,
    side: input.request.side,
    entryPrice: input.request.estimatedPrice,
    stopLossPercent: input.config.system?.stopLossPercent,
    takeProfitPercent: input.config.system?.targetProfitPercent,
  });
  const riskDecision = reviewRisk({
    intent: {
      id: `intent-${Date.now()}`,
      symbol: input.request.symbol,
      side: input.request.side,
      qty: input.request.qty,
      notional: input.request.qty * input.request.estimatedPrice,
      estimatedPrice: input.request.estimatedPrice,
      sizingReason: "Server order path intent.",
      capsApplied: input.maxNotional ? ["max_notional_route_limit"] : [],
    },
    brokerConfig,
    portfolio: portfolioAssessment,
    exitPlan,
    breaker: { status: breakerState.status },
    metrics: {
      dailyLoss: (() => {
        // Same fallback rule as the breaker input above: a REAL broker must supply
        // last_equity (missing -> NaN -> reviewRisk fails closed); the simulated
        // portfolio treats equity as prior close (daily loss 0).
        const lastEquityForDaily = brokerConfig.configured
          ? Number(portfolio.last_equity)
          : Number(portfolio.last_equity ?? portfolio.equity);
        return breakerState.metrics.equity !== null
          ? breakerState.metrics.equity - lastEquityForDaily
          : Number.NaN;
      })(),
      dailyTradeCount: (input.db.trades || []).filter((trade: any) => String(trade.timestamp || "").startsWith(new Date().toISOString().slice(0, 10))).length,
      openPositionCount: portfolioAssessment.positions.length,
    },
    limits: {
      maxDailyLoss: riskLimits.maxDailyLoss,
      maxDailyTradeCount: riskLimits.maxDailyTradeCount,
      maxOpenPositions: riskLimits.maxOpenPositions,
      minBuyingPower: riskLimits.minBuyingPower,
    },
  });
  const result = await submitTradeThroughPipeline({
    request: input.request,
    brokerConfig,
    riskDecision,
    exitPlan,
    brokerSubmit: () => placeAlpacaOrder(brokerConfig, input.request.symbol, riskDecision.adjustedQty || input.request.qty, input.request.side),
  });
  appendAuditEvents(input.db, result.auditEvents);
  productionStore.saveTradeIntent(result.trade);
  if (result.trade.riskDecision) productionStore.saveRiskDecision(result.trade.id, result.trade.riskDecision);
  if (result.trade.exitPlan) productionStore.saveExitPlan(result.trade.id, result.trade.exitPlan);
  return result.trade;
}

function defaultDB() {
  return {
    config: {
      alpaca: { apiKeyId: "", secretKey: "", paper: true },
      notion: { token: "", databaseId: "" },
      telegram: { botToken: "", chatId: "", enabled: false },
      google: { spreadsheetId: "", enabled: false },
      system: {
        autoTrading: false,
        runIntervalMins: 15,
        maxPositionSizePercent: 10,
        stopLossPercent: 5,
        targetProfitPercent: 15,
      },
    },
    analyses: [],
    trades: [],
    syncLogs: [],
    auditEvents: [],
    simulatedPortfolio: {
      cash: "100000.00",
      buying_power: "100000.00",
      portfolio_value: "100000.00",
      equity: "100000.00",
      long_market_value: "0.00",
      daytrade_count: 0,
      positions: [],
    },
  };
}

// Cache values or helper functions to read and write db
function readDB() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      // Ensure directory exists
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
      return defaultDB();
    }
    const data = fs.readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(data);
    return { ...defaultDB(), ...parsed, config: { ...defaultDB().config, ...(parsed.config || {}) } };
  } catch (error) {
    console.error("Error reading database:", error);
    return defaultDB();
  }
}

function writeDB(data: any) {
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    // Atomic Write Sequence: write to temporary file first then rename atomically
    const tempPath = DB_PATH + ".tmp";
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tempPath, DB_PATH);
  } catch (error) {
    console.error("Critical: Error writing database atomically:", error);
    // Safe fallback to direct write to prevent data loss
    try {
      fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf8");
    } catch (fallbackError) {
      console.error("Emergency fallback write database failed:", fallbackError);
    }
  }
}

// Global Claude client. Constructing without a key throws; both call sites
// run inside try/catch blocks that fall back to simulated analysis.
const getClaudeClient = () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("No ANTHROPIC_API_KEY environment variable found. Claude calls will fail.");
  }
  return new Anthropic({ apiKey });
};

const claudeText = (response: Anthropic.Message): string =>
  response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

/* ==========================================================
   INTEGRATIONS IMPLEMENTATION
   ========================================================== */

// 1. Alpaca Integration Helper
async function getAlpacaPortfolio(brokerConfig: BrokerConfig = getBrokerConfig()) {
  if (!brokerConfig.configured) {
    // If not configured, retrieve our realistic simulated portfolio
    const db = readDB();
    return db.simulatedPortfolio || { cash: "100000.00", portfolio_value: "100000.00", positions: [] };
  }

  const headers = {
    "APCA-API-KEY-ID": brokerConfig.apiKey || "",
    "APCA-API-SECRET-KEY": brokerConfig.secretKey || "",
    "Content-Type": "application/json",
  };

  try {
    const acctRes = await fetch(`${brokerConfig.baseUrl}/account`, { headers });
    if (!acctRes.ok) throw new Error(`Alpaca Accounts API responded with ${acctRes.status}`);
    const account = await acctRes.json();

    const posRes = await fetch(`${brokerConfig.baseUrl}/positions`, { headers });
    const positions = posRes.ok ? await posRes.json() : [];

    return {
      cash: account.cash,
      buying_power: account.buying_power,
      portfolio_value: account.portfolio_value,
      equity: account.equity,
      last_equity: account.last_equity,
      long_market_value: account.long_market_value,
      daytrade_count: account.daytrade_count,
      positions: positions.map((p: any) => ({
        symbol: p.symbol,
        qty: p.qty,
        market_value: p.market_value,
        cost_basis: p.cost_basis,
        unrealized_pl: p.unrealized_pl,
        unrealized_plpc: (parseFloat(p.unrealized_pl) / parseFloat(p.cost_basis)).toFixed(4),
        current_price: p.current_price,
        avg_entry_price: p.avg_entry_price,
      })),
    };
  } catch (err: any) {
    console.error("Alpaca connection error:", err.message);
    throw err;
  }
}

async function getAlpacaOpenOrders(brokerConfig: BrokerConfig = getBrokerConfig()) {
  if (!brokerConfig.configured) return [];
  const headers = {
    "APCA-API-KEY-ID": brokerConfig.apiKey || "",
    "APCA-API-SECRET-KEY": brokerConfig.secretKey || "",
    "Content-Type": "application/json",
  };
  const res = await fetch(`${brokerConfig.baseUrl}/orders?status=open`, { headers });
  if (!res.ok) return [];
  const orders = await res.json();
  return (Array.isArray(orders) ? orders : []).map((order: any) => ({
    id: order.id,
    symbol: order.symbol,
    side: order.side,
    qty: order.qty,
    notional: order.notional,
    status: order.status,
  }));
}

async function placeAlpacaOrder(brokerConfig: BrokerConfig, symbol: string, qty: number, side: "buy" | "sell") {
  if (!brokerConfig.configured) {
    return { id: "dry-run-" + Date.now(), qty: String(qty), status: "accepted" };
  }

  if (brokerConfig.tradingMode === "live" && !brokerConfig.liveTradingEnabled) {
    throw new Error("Live trading is blocked unless LIVE_TRADING_ENABLED=true.");
  }

  const headers = {
    "APCA-API-KEY-ID": brokerConfig.apiKey || "",
    "APCA-API-SECRET-KEY": brokerConfig.secretKey || "",
    "Content-Type": "application/json",
  };

  const orderRes = await fetch(`${brokerConfig.baseUrl}/orders`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      symbol,
      qty: String(qty),
      side,
      type: "market",
      time_in_force: "day",
    }),
  });
  if (!orderRes.ok) {
    const errTxt = await orderRes.text();
    throw new Error(`Alpaca order rejected: ${errTxt}`);
  }
  return await orderRes.json();
}

// 2. Telegram Notification Helper
async function sendTelegramAlert(config: AppConfig["telegram"], message: string) {
  if (!config || !config.enabled || !config.botToken || !config.chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: message,
        parse_mode: "HTML",
      }),
    });
    return res.ok;
  } catch (err) {
    console.error("Telegram alert failed:", err);
    return false;
  }
}

const pendingTelegramConfirmations = new Map<string, ConfirmationToken>();

async function sendTelegramBotMessage(chatId: string, message: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
    });
    return res.ok;
  } catch (err) {
    console.error("Telegram bot message failed:", err);
    return false;
  }
}

async function handleTelegramCommand(update: any) {
  const message = update.message;
  const text = String(message?.text || "").trim();
  const chatId = String(message?.chat?.id || "");
  const userId = String(message?.from?.id || "");
  if (!text || !chatId || !userId) return;

  const command = text.split(/\s+/)[0];
  const roles = parseTelegramAdminRoles(process.env.TELEGRAM_ADMIN_ROLES);
  const auth = authorizeTelegramCommand({ userId, command, roles });

  const outbound: string[] = [];
  let needsReadOnlyReply = false;

  const release = await dbMutex.acquire();
  try {
    const db = readDB();
    const auditEvent: AuditEvent = {
      id: `tg-${update.update_id || Date.now()}`,
      timestamp: new Date().toISOString(),
      type: "telegram",
      actor: userId,
      message: `Telegram command ${command} ${auth.allowed ? "accepted" : "rejected"}`,
      details: { command, chatId, auth },
    };
    appendAuditEvents(db, [auditEvent]);

    if (!auth.allowed) {
      outbound.push(`Rejected: ${auth.reason || "unauthorized"}.`);
    } else if (command === "/confirm") {
      const tokenValue = text.split(/\s+/)[1];
      const token = pendingTelegramConfirmations.get(tokenValue);
      if (!token) {
        outbound.push("Confirmation rejected: unknown token.");
      } else {
        const consumed = consumeConfirmationToken({ token, userId, action: token.action });
        if (!consumed.accepted) {
          outbound.push(`Confirmation rejected: ${consumed.reason}.`);
        } else {
          pendingTelegramConfirmations.delete(tokenValue);
          outbound.push(`Confirmed action: ${token.action}. Submit through the admin API to execute.`);
        }
      }
    } else if (command === "/close_all") {
      const token = createConfirmationToken({ userId, action: "close_all" });
      pendingTelegramConfirmations.set(token.token, token);
      outbound.push(`Close-all requires confirmation. Reply: /confirm ${token.token}`);
    } else if (command === "/pause" || command === "/block_buys") {
      db.config.system.autoTrading = false;
      outbound.push("Auto trading paused. New buys are blocked.");
    } else if (command === "/resume") {
      db.config.system.autoTrading = true;
      outbound.push("Auto trading resumed subject to risk checks.");
    } else {
      needsReadOnlyReply = true;
    }

    writeDB(db);
  } finally {
    release();
  }

  if (needsReadOnlyReply) {
    // Read-only replies may hit the broker; never do this while holding the db lock.
    const portfolio = command === "/positions" ? await getAlpacaPortfolio().catch(() => null) : null;
    const reply = {
      "/status": "Quantpaca online. Broker writes require pipeline approval.",
      "/health": `Broker configured: ${getBrokerConfig().configured}; mode: ${getBrokerConfig().tradingMode}; live enabled: ${getBrokerConfig().liveTradingEnabled}.`,
      "/positions": portfolio ? JSON.stringify(portfolio.positions || []).slice(0, 3500) : "Positions unavailable.",
      "/orders": JSON.stringify(await getAlpacaOpenOrders().catch(() => [])).slice(0, 3500),
      "/trades": JSON.stringify(productionStore.listTradeIntents(10)).slice(0, 3500),
      "/sync": "Sync command accepted. Use admin API with ADMIN_API_TOKEN for execution.",
      "/dry_run": "Dry-run path available through reviewed signals, sizing, risk, and audit endpoints.",
      "/risk": JSON.stringify(productionStore.listRiskDecisions(10)).slice(0, 3500),
      "/regime": JSON.stringify(productionStore.latestRegimeAssessment() || detectRegime({})).slice(0, 3500),
    }[command] || "Command recognized.";
    outbound.push(reply);
  }

  for (const reply of outbound) {
    await sendTelegramBotMessage(chatId, reply);
  }
}

function startTelegramRuntime() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  let offset = 0;
  setInterval(async () => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=10&offset=${offset}`);
      if (!res.ok) return;
      const data = await res.json();
      for (const update of data.result || []) {
        offset = Math.max(offset, Number(update.update_id) + 1);
        await handleTelegramCommand(update);
      }
    } catch (err) {
      console.error("Telegram polling failed:", err);
    }
  }, 5000);
}

// 3. Google Sheets Export Helper
async function appendTradeToSheets(config: AppConfig["google"], authHeader: string | null, trade: Trade) {
  if (!config || !config.enabled || !config.spreadsheetId || !authHeader) return false;
  try {
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${config.spreadsheetId}/values/A1:I1:append?valueInputOption=USER_ENTERED`,
      {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          values: [[
            trade.timestamp,
            trade.id,
            trade.symbol,
            trade.side.toUpperCase(),
            trade.qty,
            trade.price || "MARKET",
            trade.qty * trade.price || "N/A",
            trade.status.toUpperCase(),
            trade.reasoning
          ]],
        }),
      }
    );
    return res.ok;
  } catch (err) {
    console.error("Google Sheets save error:", err);
    return false;
  }
}

// 4. Notion Document Logger
async function saveToNotionDatabase(config: AppConfig["notion"], analysis: StockAnalysis) {
  if (!config || !config.token || !config.databaseId) return false;
  try {
    const res = await fetch(`https://api.notion.com/v1/pages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parent: { database_id: config.databaseId },
        properties: {
          Ticker: { title: [{ text: { content: analysis.symbol } }] },
          Source: { select: { name: analysis.source.toUpperCase() } },
          Title: { rich_text: [{ text: { content: analysis.sourceTitle } }] },
          GrowthScore: { number: analysis.growthScore },
          SentimentScore: { number: analysis.sentimentScore },
          RiskProfile: { select: { name: analysis.riskProfile } },
          Decision: { select: { name: analysis.decision } },
          WhipsawAssessment: { rich_text: [{ text: { content: analysis.whipsawCheck } }] },
          Reasoning: { rich_text: [{ text: { content: analysis.reasoning } }] },
          Date: { date: { start: analysis.timestamp } },
        },
      }),
    });
    return res.ok;
  } catch (err) {
    console.error("Notion save error:", err);
    return false;
  }
}


/* ==========================================================
   REST API API ENDPOINTS
   ========================================================== */

// Config Endpoints
app.get("/api/config", (req, res) => {
  const db = readDB();
  res.json(redactConfigForClient(db.config));
});

app.post("/api/config", requireAdminCommand, async (req, res) => {
  const release = await dbMutex.acquire();
  try {
    const db = readDB();
    db.config = stripPersistedSecrets({ ...db.config, ...req.body });
    writeDB(db);
    res.json({ success: true, config: redactConfigForClient(db.config) });
  } catch (error) {
    console.error("Config update failed:", error);
    res.status(500).json({ error: "Failed to update configuration." });
  } finally {
    release();
  }
});

// Logs, Trades, Analyses
app.get("/api/analyses", (req, res) => {
  const db = readDB();
  res.json(db.analyses || []);
});

app.get("/api/trades", (req, res) => {
  const db = readDB();
  res.json(db.trades || []);
});

app.get("/api/logs", (req, res) => {
  const db = readDB();
  res.json(db.syncLogs || []);
});

app.get("/api/audit", (req, res) => {
  const db = readDB();
  const persisted = productionStore.listAuditEvents();
  res.json(persisted.length ? persisted : (db.auditEvents || []));
});

app.get("/api/regime/latest", (req, res) => {
  const latest = productionStore.latestRegimeAssessment();
  if (latest) {
    res.json(latest);
    return;
  }
  const conservative = detectRegime({});
  productionStore.saveRegimeAssessment(conservative);
  res.json(conservative);
});

app.get("/api/breaker/latest", (req, res) => {
  res.json(productionStore.latestBreakerState() || { status: "ok", reasons: ["no_evaluation_yet"], asOf: null });
});

app.get("/api/portfolio/assessment", async (req, res) => {
  try {
    const portfolio = await getAlpacaPortfolio();
    const assessment = assessPortfolio({
      account: portfolio,
      positions: portfolio.positions || [],
      openOrders: await getAlpacaOpenOrders(),
      source: getBrokerConfig().configured ? "alpaca" : "local_simulated_snapshot",
    });
    res.json(assessment);
  } catch (err: any) {
    res.status(502).json({ error: "Portfolio assessment failed", details: err.message });
  }
});

app.get("/api/signals/reviewed", (req, res) => {
  const db = readDB();
  const persisted = productionStore.listReviewedSignals();
  if (persisted.length) {
    res.json(persisted);
    return;
  }
  res.json((db.analyses || []).map((analysis: StockAnalysis) => ({
    id: analysis.id,
    symbol: analysis.symbol,
    source: analysis.source,
    sourceTimestamp: analysis.timestamp,
    freshnessStatus: "unknown",
    confidenceScore: Math.max(0, Math.min(100, Math.round((analysis.growthScore + Math.max(analysis.sentimentScore, 0)) / 2))),
    classification: analysis.decision === "BUY" ? "bullish" : analysis.decision === "SELL" ? "bearish" : "neutral",
    thesisSummary: analysis.reasoning,
    invalidationConditions: analysis.whipsawCheck,
    evidence: analysis.sourceTitle,
  })));
});

app.get("/api/trade-intents", (req, res) => {
  const db = readDB();
  const persisted = productionStore.listTradeIntents();
  if (persisted.length) {
    res.json(persisted);
    return;
  }
  res.json((db.trades || []).map((trade: any) => ({
    id: trade.id,
    symbol: trade.symbol,
    side: trade.side,
    qty: trade.qty,
    notional: Number(trade.qty) * Number(trade.price),
    estimatedPrice: trade.price,
    status: trade.status,
    source: trade.source || "legacy",
    reasoning: trade.reasoning,
    timestamp: trade.timestamp,
  })));
});

app.get("/api/risk-decisions", (req, res) => {
  const db = readDB();
  const persisted = productionStore.listRiskDecisions();
  if (persisted.length) {
    res.json(persisted);
    return;
  }
  res.json((db.trades || []).filter((trade: any) => trade.riskDecision).map((trade: any) => ({
    tradeId: trade.id,
    symbol: trade.symbol,
    ...trade.riskDecision,
  })));
});

app.get("/api/exit-plans", (req, res) => {
  const db = readDB();
  const persisted = productionStore.listExitPlans();
  if (persisted.length) {
    res.json(persisted);
    return;
  }
  res.json((db.trades || []).filter((trade: any) => trade.exitPlan).map((trade: any) => ({
    tradeId: trade.id,
    symbol: trade.symbol,
    ...trade.exitPlan,
  })));
});

app.get("/api/reconciliation/latest", (req, res) => {
  const latest = productionStore.latestReconciliationReport();
  if (latest) {
    res.json(latest);
    return;
  }
  res.json({ id: "reconciliation-not-run", timestamp: new Date().toISOString(), status: "matched", mismatches: [] });
});

app.post("/api/reconciliation/run", requireAdminCommand, async (req, res) => {
  try {
    const portfolio = await getAlpacaPortfolio();
    const report = reconcileBrokerState({
      localTrades: productionStore.listTradeIntents().map((trade: any) => ({
        id: trade.id,
        brokerOrderId: trade.brokerOrderId,
        symbol: trade.symbol,
        qty: trade.qty,
        side: trade.side,
        status: trade.status,
      })),
      brokerOrders: await getAlpacaOpenOrders(),
      brokerPositions: portfolio.positions || [],
      account: portfolio,
    });
    productionStore.saveReconciliationReport(report);
    res.json(report);
  } catch (err: any) {
    res.status(502).json({ error: "Reconciliation failed", details: err.message });
  }
});

app.get("/api/telegram/status", (req, res) => {
  const roles = parseTelegramAdminRoles(process.env.TELEGRAM_ADMIN_ROLES);
  res.json({
    configured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    adminsConfigured: Object.keys(roles).length,
    mode: process.env.TELEGRAM_RUNTIME || "long_polling_ready",
    commands: ["/status", "/health", "/positions", "/orders", "/trades", "/sync", "/dry_run", "/pause", "/resume", "/block_buys", "/close_all", "/risk", "/regime"],
  });
});

app.get("/api/health", async (req, res) => {
  const broker = getBrokerConfig();
  const health = {
    ok: true,
    timestamp: new Date().toISOString(),
    broker: {
      configured: broker.configured,
      tradingMode: broker.tradingMode,
      liveTradingEnabled: broker.liveTradingEnabled,
      baseUrl: broker.baseUrl,
      reachable: false,
      error: undefined as string | undefined,
    },
  };
  if (broker.configured) {
    try {
      await getAlpacaPortfolio(broker);
      health.broker.reachable = true;
    } catch (err: any) {
      health.ok = false;
      health.broker.error = err.message;
    }
  }
  res.status(health.ok ? 200 : 502).json(health);
});

app.get("/api/portfolio", async (req, res) => {
  try {
    const portfolio = await getAlpacaPortfolio();
    res.json(portfolio);
  } catch (err: any) {
    console.error("Error fetching portfolio:", err);
    res.status(500).json({ error: "Failed to retrieve portfolio details", details: err.message });
  }
});

// Core Integration execution cycle
app.post("/api/sync", requireAdminCommand, async (req, res) => {
  const release = await dbMutex.acquire();
  try {
    const db = readDB();
    const authHeader = req.headers.authorization || null;

    const logs: SyncLog[] = [];
    const results: any[] = [];

    const timestamp = new Date().toISOString();
    const logId = () => "l-" + Math.random().toString(36).substr(2, 9);

    // Initialize helper to write log lines
    const addLog = (type: SyncLog["type"], msg: string, details?: string) => {
      const sl: SyncLog = { id: logId(), timestamp: new Date().toISOString(), type, message: msg, details };
      db.syncLogs.unshift(sl);
      logs.push(sl);
    };

    const currentConfig: AppConfig = db.config;

    addLog("sync", "Starting automation loop & thesis scanner...");

    // ==========================================================
    // MODULE 1: OUTBOX RESILIENT SYNCHRONIZER QUEUE Retrying Failed Integrations
    // ==========================================================
    const hasGoogle = currentConfig.google && currentConfig.google.enabled && currentConfig.google.spreadsheetId;
    const hasNotion = currentConfig.notion && currentConfig.notion.token && currentConfig.notion.databaseId;
    const hasTelegram = currentConfig.telegram && currentConfig.telegram.enabled && currentConfig.telegram.botToken && currentConfig.telegram.chatId;

    const pendingTrades = (db.trades || []).filter((tr: any) =>
      (hasGoogle && authHeader && !tr.exportedSheets) ||
      (hasNotion && !tr.loggedNotion) ||
      (hasTelegram && !tr.notifiedTelegram)
    );

    if (pendingTrades.length > 0) {
      addLog("sync", `Outbox Synchronizer found ${pendingTrades.length} trades with pending integrations. Retrying...`);
      for (const tr of pendingTrades) {
        try {
          if (!tr.exportedSheets && hasGoogle && authHeader) {
            tr.exportedSheets = await appendTradeToSheets(currentConfig.google, authHeader, tr);
            if (tr.exportedSheets) {
              addLog("sync", `Outbox Sync Success: Exported trade ${tr.id} (${tr.symbol}) to Google Sheets.`);
            }
          }
          if (!tr.loggedNotion && hasNotion) {
            const mockAnalysis: StockAnalysis = {
              id: "fake-" + tr.id,
              symbol: tr.symbol,
              source: "email",
              sourceTitle: "Outbox Queue Document Recovery",
              sourceContent: tr.reasoning,
              growthScore: 75,
              sentimentScore: 60,
              riskProfile: "Medium",
              reasoning: tr.reasoning,
              whipsawCheck: "Bypassed on sync recovery.",
              decision: tr.side.toUpperCase() as any,
              timestamp: tr.timestamp,
            };
            tr.loggedNotion = await saveToNotionDatabase(currentConfig.notion, mockAnalysis);
            if (tr.loggedNotion) {
              addLog("sync", `Outbox Sync Success: Logged trade ${tr.id} (${tr.symbol}) to Notion.`);
            }
          }
          if (!tr.notifiedTelegram && hasTelegram) {
            const tgMsg = `🔄 <b>Delayed Outbox Sync recovery event filled</b>\n<b>Ticker:</b> ${tr.symbol}\n<b>Side:</b> ${tr.side.toUpperCase()}\n<b>Price:</b> $${tr.price}`;
            tr.notifiedTelegram = await sendTelegramAlert(currentConfig.telegram, tgMsg);
            if (tr.notifiedTelegram) {
              addLog("sync", `Outbox Sync Success: Dispatched delayed Telegram warning for trade ${tr.id} (${tr.symbol}).`);
            }
          }
        } catch (queueErr: any) {
          console.error("Failed handling outbox element retry:", queueErr.message);
        }
      }
    }

    // ==========================================================
    // MODULE 2: ACTIVE PORTFOLIO RISK CONTROLLER (AUTOMATED STOP LOSS)
    // ==========================================================
    if (currentConfig.system && currentConfig.system.autoTrading) {
      addLog("sync", "Active risk evaluator: Checking portfolio stop-loss limits...");
      try {
        const portfolio = await getAlpacaPortfolio();
        const stopPercent = currentConfig.system.stopLossPercent || 5.0; // percentage trigger
        
        for (const pos of (portfolio.positions || [])) {
          const unrealizedLossPercent = parseFloat(pos.unrealized_plpc) * 100;
          
          if (unrealizedLossPercent <= -stopPercent) {
            addLog("trade", `PROTECTIVE BOUND REACHED: Position in ${pos.symbol} is at ${unrealizedLossPercent.toFixed(2)}% loss (Limit: -${stopPercent}%). Exercising Stop Loss sell execution!`);
            
            const sellQty = Math.floor(parseFloat(pos.qty));
            if (sellQty > 0) {
              const liquidationTrade = await executeTradeIntent({
                db,
                config: currentConfig,
                request: {
                  source: "stop_loss",
                  symbol: pos.symbol,
                  qty: sellQty,
                  estimatedPrice: parseFloat(pos.current_price) || 0,
                  side: "sell",
                  reasoning: `Automatic stop-loss protection executed. Loss of ${unrealizedLossPercent.toFixed(2)}% reached the threshold of -${stopPercent}%. Position was automatically liquidated.`,
                },
              });
              Object.assign(liquidationTrade, {
                symbol: pos.symbol,
                qty: sellQty,
                price: parseFloat(pos.current_price) || 50,
                side: "sell",
              });
              
              const tgAlertMsg = `🚨 <b>STOP LOSS EXECUTION WARNING</b>\n<b>Ticker:</b> ${pos.symbol}\n<b>Trigger Loss:</b> ${unrealizedLossPercent.toFixed(2)}%\n<b>Limit Threshold:</b> -${stopPercent}%\nAutomatically liquidated ${sellQty} shares to shield capital assets from further dropdowns.`;
              liquidationTrade.notifiedTelegram = await sendTelegramAlert(currentConfig.telegram, tgAlertMsg);
              liquidationTrade.exportedSheets = await appendTradeToSheets(currentConfig.google, authHeader, liquidationTrade);
              liquidationTrade.loggedNotion = await saveToNotionDatabase(currentConfig.notion, {
                id: "an-" + Math.random().toString(36).substr(2, 9),
                symbol: pos.symbol,
                source: "email",
                sourceTitle: "Protective Capital Liquidation",
                sourceContent: "Loss threshold exceeded",
                growthScore: 0,
                sentimentScore: -100,
                riskProfile: "High",
                reasoning: liquidationTrade.reasoning,
                whipsawCheck: "Stop Limit breach verified, trend reversal detected.",
                decision: "SELL",
                timestamp: liquidationTrade.timestamp
              });
              
              db.trades.unshift(liquidationTrade);
              
              // Clean local simulated portfolio if offline mode
              if (!getBrokerConfig().configured && liquidationTrade.status !== "BrokerFailed" && liquidationTrade.status !== "RiskRejected") {
                db.simulatedPortfolio.positions = (db.simulatedPortfolio.positions || []).filter((p: any) => p.symbol !== pos.symbol);
                const fundBack = sellQty * (parseFloat(pos.current_price) || 50);
                db.simulatedPortfolio.cash = String(parseFloat(db.simulatedPortfolio.cash) + fundBack);
                db.simulatedPortfolio.long_market_value = String(parseFloat(db.simulatedPortfolio.long_market_value) - fundBack);
              }
              
              addLog("trade", `Liquidated ${sellQty} shares of ${pos.symbol} due to stop loss limit hit.`);
            }
          }
        }
      } catch (riskManagerErr: any) {
        addLog("error", "Portfolio risk evaluator hit error", riskManagerErr.message);
      }
    }

    // Variable to store Gmail messages
    let emailsToScan: EmailScanTarget[] = [];

  if (authHeader) {
    addLog("sync", "Attempting to retrieve messages with active Gmail OAuth token...");
    try {
      // Query messages from charlie-from-ziptrader@ghost.io
      const gmailQuery = "from:charlie-from-ziptrader@ghost.io";
      const gmailRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(gmailQuery)}&maxResults=5`,
        { headers: { Authorization: authHeader } }
      );

      if (gmailRes.ok) {
        const gmailData = await gmailRes.json();
        const messages = gmailData.messages || [];
        addLog("sync", `Successfully listed ${messages.length} messages from ZipTrader of ghost.io.`);

        for (const msg of messages) {
          const detailRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
            { headers: { Authorization: authHeader } }
          );
          if (detailRes.ok) {
            const detailData = await detailRes.json();
            const extraction = extractEmailScanTarget(detailData);
            if (extraction.ok === false) {
              // Fail-closed: no real send time could be recovered for this message.
              // Never fabricate "now" -- skip it rather than let an undated thesis
              // sail through the freshness check.
              addLog("error", `Skipping Gmail message ${msg.id}: ${extraction.reason}`);
              continue;
            }
            if (extraction.bodyDegraded) {
              addLog("sync", `Body extraction degraded for Gmail message ${msg.id}; using snippet fallback.`);
            }
            emailsToScan.push(extraction.target);
          }
        }
      } else {
        const errTxt = await gmailRes.text();
        addLog("error", "Gmail API failed. Operating with offline simulation database.", errTxt);
      }
    } catch (err: any) {
      addLog("error", "Gmail sync connection error.", err.message);
    }
  } else {
    addLog("sync", "No authorization token detected. Simulating recent Gmail Inbox scan for @ghost.io...");
  }

  // If no live emails scanned, add high quality simulated one for demonstration.
  // This is simulated demo content, not a real Gmail message, so there is no real
  // send time to capture -- "now" is the honest timestamp for freshly-generated
  // demo data. (Task 3 removes this hardcoded fallback entirely.)
  if (emailsToScan.length === 0) {
    emailsToScan.push({
      source: "email",
      title: "ZipTrader: Why MARA and Clean Energy are pulling back — Pullback Accumulation",
      content: "MARA shares slid 10% on market Bitcoin volatility. Fundamentals remain stellar. Is it a trend reversal or simple whipsaw volatility? Our analysis points to macro liquidation. Fundamentals validated by steady hash rates.",
      sourceTimestamp: new Date().toISOString(),
    });
  }

  // 2. Fetch YouTube News & Sentiment using Claude web search
  let youtubeSentiment = "No recent video found in search.";
  try {
    addLog("sync", "Querying Claude web search for recent ZipTrader YouTube video sentiment...");
    const anthropic = getClaudeClient();
    const queryRes = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      tools: [{ type: "web_search_20260209", name: "web_search" }],
      messages: [
        {
          role: "user",
          content:
            "Find recent YouTube video titles and market opinions from the 'ZipTrader' channel in 2026. What stocks is he discussing and what is his current sentiment?",
        },
      ],
    });
    youtubeSentiment = claudeText(queryRes) || "ZipTrader channel continues to emphasize accumulation patterns for PLTR and TSLA following volatility.";
    addLog("sentiment", "ZipTrader YouTube Sentinel scan completed successfully.", youtubeSentiment.substring(0, 300) + "...");
  } catch (err: any) {
    console.error("Claude web search error:", err);
    youtubeSentiment = "ZipTrader channel sentiment: Bullish on growth tech pullbacks, emphasizing MARA and PLTR accumulation.";
    addLog("sentiment", "YouTube sentiment simulated using default quantitative engine.");
  }

  // 3. Process each scanned thesis with Claude
  // The YouTube target keeps a "now" timestamp deliberately: youtubeSentiment is
  // the output of a web search that just completed above, not an ingested
  // document with its own real send time to recover.
  const scanTargets = [
    ...emailsToScan,
    { source: "youtube", title: "ZipTrader Channel Feed Analyzed", content: youtubeSentiment, sourceTimestamp: new Date().toISOString() }
  ];

  const parsedAnalyses: StockAnalysis[] = [];

  for (const target of scanTargets) {
    try {
      addLog("sync", `Analyzing thesis with Claude: "${target.title.substring(0, 45)}..."`);
      const anthropic = getClaudeClient();

      // Ask Claude for strict quantitative evaluation; the JSON schema below is
      // enforced by the API (structured outputs), not just requested in the prompt.
      const response = await anthropic.messages.create({
        model: "claude-opus-4-8",
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        messages: [
          {
            role: "user",
            content: `Analyze the following stock newsletter or trading commentary from ZipTrader.
Source Type: ${target.source}
Title: ${target.title}
Content: ${target.content}

You must extract the stock ticker symbol mentioned (like PLTR, MARA, TSLA, NVDA), assess growth potential score (0 to 100), market sentiment score (-100 to 100), and define a risk profile ('Low' | 'Medium' | 'High').
Crucially, when the stock goes down for any reason, assess whether it is a support level 'whipsaw' because of the overall market volatility OR a genuine 'trend reversal' before deciding to act. Validate the fundamentals and the core thesis.
Set a decision: 'BUY' (if sentiment is very bullish & whipsaw check passes), 'SELL' (if trend reversal is verified or target stop loss hit), 'HOLD', or 'NONE' (if no clear ticker discussed).

For "reasoning", write a concise human sentence explaining the fundamental thesis validation. For "whipsawCheck", give a definitive explanation of whether the current pull-back is a whipsaw or genuine trend reversal. If no clear ticker is discussed, set "symbol" to "UNKNOWN".`,
          },
        ],
        output_config: {
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                symbol: { type: "string" },
                growthScore: { type: "integer" },
                sentimentScore: { type: "integer" },
                riskProfile: { type: "string", enum: ["Low", "Medium", "High"] },
                reasoning: { type: "string" },
                whipsawCheck: { type: "string" },
                decision: { type: "string", enum: ["BUY", "SELL", "HOLD", "NONE"] },
              },
              required: ["symbol", "growthScore", "sentimentScore", "riskProfile", "reasoning", "whipsawCheck", "decision"],
              additionalProperties: false,
            },
          },
        },
      });

      const text = claudeText(response) || "{}";
      const parsed = JSON.parse(text);

      if (parsed.symbol && parsed.symbol !== "UNKNOWN" && parsed.symbol !== "THE_STOCK_TICKER") {
        const item: StockAnalysis = {
          id: "an-" + Math.random().toString(36).substr(2, 9),
          symbol: parsed.symbol.toUpperCase(),
          source: target.source as any,
          sourceTitle: target.title,
          sourceContent: target.content,
          growthScore: parsed.growthScore,
          sentimentScore: parsed.sentimentScore,
          riskProfile: parsed.riskProfile as any,
          reasoning: parsed.reasoning,
          whipsawCheck: parsed.whipsawCheck,
          decision: parsed.decision as any,
          // Real source timestamp (Gmail internalDate/Date header for email, or
          // "now" for the just-completed YouTube web search) -- not "now" for
          // every thesis regardless of actual age. This is what lets the signal
          // engine's freshness check (maxAgeHours) do anything at all.
          timestamp: target.sourceTimestamp,
        };

        const rawSignal = createRawSignal({
          source: target.source === "youtube" ? "youtube" : "email",
          sourceId: `${target.source}:${target.title}`,
          sourceTimestamp: item.timestamp,
          symbol: item.symbol,
          thesis: `${item.reasoning} ${item.whipsawCheck}`,
          url: target.source === "youtube" ? "youtube://ziptrader" : "gmail://ziptrader",
          aiConfidence: Math.max(0, Math.min(100, Math.round((item.growthScore + Math.max(item.sentimentScore, 0)) / 2))),
        });
        const reviewedSignal = reviewAndPersistSignal(productionStore, rawSignal);
        if (reviewedSignal.status === "rejected") {
          addLog("error", `Signal rejected for ${item.symbol}: ${reviewedSignal.rejectionReason}`);
          continue;
        }

        db.analyses.unshift(item);
        parsedAnalyses.push(item);
        results.push(item);

        addLog("sentiment", `Analyzed ${item.symbol}: Growth ${item.growthScore}, Sentiment ${item.sentimentScore}%. Decision: ${item.decision}`);

        // 4. Automated orders placing based on Decision and Risk checks
        if (currentConfig.system.autoTrading && (item.decision === "BUY" || item.decision === "SELL")) {
          addLog("sync", `Risk Engine Evaluation for ticker ${item.symbol}...`);
          
          // Verify current position size limit
          const portfolio = await getAlpacaPortfolio();
          const currentShares = portfolio.positions.find((p: any) => p.symbol === item.symbol);
          const parsedPortfolioValue = Number(portfolio.portfolio_value);
          if (!Number.isFinite(parsedPortfolioValue) || parsedPortfolioValue <= 0) {
            addLog("error", `Order skipped for ${item.symbol}. Portfolio value is not a finite number; failing closed.`);
            continue;
          }
          const maxPositionValue = parsedPortfolioValue * (currentConfig.system.maxPositionSizePercent / 100);

          let price = 0;
          try {
            // Get current price if possible
            const brokerConfig = getBrokerConfig();
            if (brokerConfig.configured) {
              // Market data lives on data.alpaca.markets, not the trading host.
              const dataBaseUrl = process.env.ALPACA_DATA_URL || "https://data.alpaca.markets";
              const latestTrade = await fetch(`${dataBaseUrl}/v2/stocks/${item.symbol}/trades/latest`, {
                headers: {
                  "APCA-API-KEY-ID": brokerConfig.apiKey || "",
                  "APCA-API-SECRET-KEY": brokerConfig.secretKey || "",
                },
              });
              if (latestTrade.ok) {
                const body = await latestTrade.json();
                price = Number(body.trade?.p || 0);
              }
            } else {
              const simulatedPos = (portfolio.positions || []).find((p: any) => p.symbol === item.symbol);
              price = Number(simulatedPos?.current_price || 0);
            }
          } catch (e) {
            addLog("error", `Price lookup failed for ${item.symbol}: ${e instanceof Error ? e.message : String(e)}`);
          }

          if (!price || !Number.isFinite(price) || price <= 0) {
            addLog("error", `Order skipped for ${item.symbol}. No deterministic market price was available.`);
            continue;
          }

          if (item.decision === "BUY") {
            const portfolioAssessment = assessPortfolio({
              account: portfolio,
              positions: portfolio.positions || [],
              openOrders: await getAlpacaOpenOrders(),
              source: getBrokerConfig().configured ? "alpaca" : "local_simulated_snapshot",
            });
            const regime = productionStore.latestRegimeAssessment() || detectRegime({});
            const stopLossPercent = Number(currentConfig.system.stopLossPercent);
            if (!Number.isFinite(stopLossPercent) || stopLossPercent <= 0) {
              addLog("error", `Order skipped for ${item.symbol}. stopLossPercent is not a positive finite number.`);
              continue;
            }
            const sized = sizeTradeIntent({
              reviewedSignal,
              regime,
              portfolio: portfolioAssessment,
              side: "buy",
              estimatedPrice: price,
              stopLossPrice: price * (1 - stopLossPercent / 100),
              limits: {
                maxSinglePositionPercent: currentConfig.system.maxPositionSizePercent,
                maxPortfolioExposurePercent: 100,
                maxNotionalPerTrade: maxPositionValue,
                minBuyingPowerAfterTrade: riskLimits.minBuyingPower,
              },
            });

            if (sized.qty < 1) {
              addLog("error", `Order skipped for ${item.symbol}. Sizing produced no executable quantity (${sized.sizingReason}; caps: ${sized.capsApplied.join(", ")}).`);
            } else {
              const qty = sized.qty;
              addLog("sync", `Submitting buy intent for ${qty} shares of ${item.symbol} at approx $${price} through safety pipeline...`);
              const newTrade = await executeTradeIntent({
                db,
                config: currentConfig,
                request: {
                  source: "automation",
                  symbol: item.symbol,
                  qty,
                  estimatedPrice: price,
                  side: "buy",
                  reasoning: `ZipTrader thesis validated. Whipsaw check: ${item.whipsawCheck}. Fundamentals: ${item.reasoning}`,
                },
                maxNotional: maxPositionValue,
              });

              // Notify channels
              const tgMsg = `🚨 <b>ZipTrader Automation: BUY INTENT ${newTrade.status}</b>\n<b>Ticker:</b> ${newTrade.symbol}\n<b>Quantity:</b> ${newTrade.qty}\n<b>Price:</b> $${newTrade.price}\n<b>Thesis Log:</b> ${newTrade.reasoning}`;
              newTrade.notifiedTelegram = await sendTelegramAlert(currentConfig.telegram, tgMsg);

              // Log to Sheet
              newTrade.exportedSheets = await appendTradeToSheets(currentConfig.google, authHeader, newTrade);

              // Log to Notion
              newTrade.loggedNotion = await saveToNotionDatabase(currentConfig.notion, item);

              db.trades.unshift(newTrade);

              // Update simulation list
              if (!getBrokerConfig().configured && newTrade.status !== "BrokerFailed" && newTrade.status !== "RiskRejected") {
                const currentSim = db.simulatedPortfolio;
                const existingPos = currentSim.positions.find((p: any) => p.symbol === item.symbol);
                if (existingPos) {
                  const oldQty = parseInt(existingPos.qty);
                  const oldBasis = parseFloat(existingPos.cost_basis);
                  const newQty = oldQty + qty;
                  const newBasis = oldBasis + (qty * price);
                  existingPos.qty = String(newQty);
                  existingPos.cost_basis = String(newBasis);
                  existingPos.current_price = String(price);
                  existingPos.market_value = String(newQty * price);
                } else {
                  currentSim.positions.push({
                    symbol: item.symbol,
                    qty: String(qty),
                    market_value: String(qty * price),
                    cost_basis: String(qty * price),
                    unrealized_pl: "0.00",
                    unrealized_plpc: "0.0000",
                    current_price: String(price),
                    avg_entry_price: String(price)
                  });
                }
                currentSim.cash = String(parseFloat(currentSim.cash) - (qty * price));
                currentSim.long_market_value = String(parseFloat(currentSim.long_market_value) + (qty * price));
              }

              addLog("trade", `Submitted BUY ${qty} shares of ${item.symbol}. State: ${newTrade.status}. Telegram: ${newTrade.notifiedTelegram ? 'Sent' : 'Disabled'}, Sheets: ${newTrade.exportedSheets ? 'Appended' : 'Disabled'}, Notion: ${newTrade.loggedNotion ? 'Saved' : 'Disabled'}`);
            }
          } else if (item.decision === "SELL" && currentShares && parseInt(currentShares.qty) > 0) {
            const qty = parseInt(currentShares.qty);
            addLog("sync", `Submitting sell recommendation intent to close position of ${qty} shares for ${item.symbol}...`);
            const newTrade = await executeTradeIntent({
              db,
              config: currentConfig,
              request: {
                source: "automation",
                symbol: item.symbol,
                qty,
                estimatedPrice: price,
                side: "sell",
                reasoning: `Trend reversal warning assessed or stop loss margin hit. Closing positions.`,
              },
            });

            const tgMsg = `🚨 <b>ZipTrader Automation: SELL INTENT ${newTrade.status}</b>\n<b>Ticker:</b> ${newTrade.symbol}\n<b>Quantity:</b> ${newTrade.qty}\n<b>Price:</b> $${newTrade.price}\n<b>Reasoning:</b> ${newTrade.reasoning}`;
            newTrade.notifiedTelegram = await sendTelegramAlert(currentConfig.telegram, tgMsg);
            newTrade.exportedSheets = await appendTradeToSheets(currentConfig.google, authHeader, newTrade);
            newTrade.loggedNotion = await saveToNotionDatabase(currentConfig.notion, item);

            db.trades.unshift(newTrade);

            if (!getBrokerConfig().configured && newTrade.status !== "BrokerFailed" && newTrade.status !== "RiskRejected") {
              const currentSim = db.simulatedPortfolio;
              currentSim.positions = currentSim.positions.filter((p: any) => p.symbol !== item.symbol);
              currentSim.cash = String(parseFloat(currentSim.cash) + (qty * price));
              currentSim.long_market_value = String(parseFloat(currentSim.long_market_value) - (qty * price));
            }

            addLog("trade", `Submitted SELL ${qty} shares of ${item.symbol}. State: ${newTrade.status}. Telegram: ${newTrade.notifiedTelegram ? 'Sent' : 'Disabled'}`);
          }
        }
      }
    } catch (err: any) {
      console.error("Failed to parse analysis target:", err);
      addLog("error", `Failed checking thesis for target: "${target.title}"`, err.message);
    }
  }

  addLog("sync", "ZipTrader portfolio optimization cycle completed.");
  writeDB(db);
  res.json({ success: true, analyses: parsedAnalyses, logs });
  } catch (err: any) {
    console.error("Critical error in /api/sync:", err);
    res.status(500).json({ error: "Sync failed", details: err.message });
  } finally {
    release();
  }
});

// Manual Override trade actions API
app.post("/api/override/trade", requireAdminCommand, async (req, res) => {
  const release = await dbMutex.acquire();
  try {
    const { symbol, qty, side, price } = req.body;
    const db = readDB();
    const authHeader = req.headers.authorization || null;

    const currentConfig: AppConfig = db.config;
    const timestamp = new Date().toISOString();

    const addLog = (type: SyncLog["type"], msg: string, details?: string) => {
      db.syncLogs.unshift({ id: "l-" + Math.random().toString(36).substr(2, 9), timestamp, type, message: msg, details });
    };

    addLog("override", `Manual Override Triggered: Place market order: ${side.toUpperCase()} ${qty} ${symbol}`);

    const tradeVal = await executeTradeIntent({
      db,
      config: currentConfig,
      request: {
        source: "manual",
        symbol,
        qty: Number(qty),
        estimatedPrice: Number(price),
        side,
        reasoning: "Manual trader override dispatched from dashboard control deck.",
        actor: "ui",
      },
    });

    // Dispatch notifications
    const tgMsg = `🚨 <b>MANUAL OVERRIDE ${tradeVal.status}</b>\n<b>Ticker:</b> ${tradeVal.symbol}\n<b>Side:</b> ${tradeVal.side.toUpperCase()}\n<b>Qty:</b> ${tradeVal.qty}\n<b>Price:</b> $${tradeVal.price}`;
    tradeVal.notifiedTelegram = await sendTelegramAlert(currentConfig.telegram, tgMsg);
    tradeVal.exportedSheets = await appendTradeToSheets(currentConfig.google, authHeader, tradeVal);

    db.trades.unshift(tradeVal);

    if (!getBrokerConfig().configured && tradeVal.status !== "BrokerFailed" && tradeVal.status !== "RiskRejected") {
      const currentSim = db.simulatedPortfolio;
      const existingPos = currentSim.positions.find((p: any) => p.symbol === symbol);
      const sharesCost = parseFloat(String(qty)) * parseFloat(String(price));

      if (side === "buy") {
        if (existingPos) {
          const oq = parseInt(existingPos.qty);
          const oc = parseFloat(existingPos.cost_basis);
          existingPos.qty = String(oq + qty);
          existingPos.cost_basis = String(oc + sharesCost);
          existingPos.market_value = String((oq + qty) * price);
        } else {
          currentSim.positions.push({
            symbol,
            qty: String(qty),
            market_value: String(sharesCost),
            cost_basis: String(sharesCost),
            unrealized_pl: "0.00",
            unrealized_plpc: "0.0000",
            current_price: String(price),
            avg_entry_price: String(price)
          });
        }
        currentSim.cash = String(parseFloat(currentSim.cash) - sharesCost);
        currentSim.long_market_value = String(parseFloat(currentSim.long_market_value) + sharesCost);
      } else {
        if (existingPos) {
          const oq = parseInt(existingPos.qty);
          const remainder = oq - qty;
          if (remainder <= 0) {
            currentSim.positions = currentSim.positions.filter((p: any) => p.symbol !== symbol);
          } else {
            existingPos.qty = String(remainder);
            existingPos.market_value = String(remainder * price);
          }
          currentSim.cash = String(parseFloat(currentSim.cash) + sharesCost);
          currentSim.long_market_value = String(parseFloat(currentSim.long_market_value) - sharesCost);
        }
      }
    }

    writeDB(db);
    res.json({ success: true, trade: tradeVal });
  } catch (err: any) {
    console.error("Critical error in /api/override/trade:", err);
    res.status(500).json({ error: "Manual trade override failed", details: err.message });
  } finally {
    release();
  }
});

// Urgent close-out control
app.post("/api/override/close-all", requireAdminCommand, async (req, res) => {
  const release = await dbMutex.acquire();
  try {
    const db = readDB();
    const timestamp = new Date().toISOString();
    const config = db.config;

    db.syncLogs.unshift({
      id: "l-" + Math.random().toString(36).substr(2, 9),
      timestamp,
      type: "override",
      message: "EMERGENCY OVERRIDE Dispatched: Close out all paper portfolio positions immediately."
    });

    const portfolio = await getAlpacaPortfolio();

    for (const pos of portfolio.positions) {
      const currentPrice = parseFloat(pos.current_price);
      if (!currentPrice || !Number.isFinite(currentPrice)) {
        db.syncLogs.unshift({
          id: "l-" + Math.random().toString(36).substr(2, 9),
          timestamp,
          type: "error",
          message: `Emergency close skipped for ${pos.symbol}; no deterministic current price was available.`,
        });
        continue;
      }
      const emergencyTrade = await executeTradeIntent({
        db,
        config,
        request: {
          source: "emergency",
          symbol: pos.symbol,
          qty: parseInt(pos.qty),
          estimatedPrice: currentPrice,
          side: "sell",
          reasoning: "Emergency override action triggered from administrative dashboard.",
          actor: "ui",
        },
      });
      db.trades.unshift(emergencyTrade);
    }

    if (!getBrokerConfig().configured) {
      const totalPosValue = parseFloat(db.simulatedPortfolio.long_market_value) || 0;
      db.simulatedPortfolio.cash = String(parseFloat(db.simulatedPortfolio.cash) + totalPosValue);
      db.simulatedPortfolio.long_market_value = "0.00";
      db.simulatedPortfolio.positions = [];
    }

    // Send panic telegram broadcast
    await sendTelegramAlert(config.telegram, "🚨 <b>Portfolio Panic Trigger: EMERGENCY CLOSE DISPATCHED.</b> All open paper positions have been sold to secure liquidated capital reserves.");

    writeDB(db);
    res.json({ success: true, message: "Emergency portfolio liquidate sequence executed successfully." });
  } catch (err: any) {
    console.error("Critical error in /api/override/close-all:", err);
    res.status(500).json({ error: "Emergency close out failed", details: err.message });
  } finally {
    release();
  }
});


// Dev support or vite mounting
async function run() {
  const startupIssues = validateStartupEnv(process.env);
  for (const issue of startupIssues) {
    const log = issue.level === "fatal" ? console.error : console.warn;
    log(`[startup:${issue.level}] ${issue.message}`);
  }
  if (startupIssues.some((issue) => issue.level === "fatal")) {
    console.error("[startup] Fatal configuration issues found. Refusing to start.");
    process.exit(1);
  }

  const distPath = path.join(process.cwd(), "dist");

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const httpServer = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server starting on port ${PORT}`);
    startTelegramRuntime();
  });

  installProcessGuards({
    log: (message, error) => (error === undefined ? console.error(message) : console.error(message, error)),
    exit: (code) => process.exit(code),
    closeServer: (onClosed) => httpServer.close(onClosed),
  });
}

export { app, dbMutex, handleTelegramCommand, readDB };

if (process.env.NODE_ENV !== "test") {
  run();
}
