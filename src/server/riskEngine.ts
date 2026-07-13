import { BrokerConfig, ExitPlan, RiskDecision, validateSymbol } from "./tradingSafety";
import { PortfolioAssessment, SizedTradeIntent } from "./domainTypes";
import { parseFiniteNumber } from "./numericSafety";

// PDT (pattern day trader) guard (docs/GO_LIVE_PLAN.md Phase 2.1, "PDT guard"):
// FINRA/Alpaca restrict a margin account under $25k equity to 3 day trades in
// a rolling 5-business-day window; a 4th trips a PDT flag/restriction on the
// account. See the check below (near the daily-trade-count check) for why a
// BUY -- not a SELL -- is the conservative point to intervene.
export const PDT_EQUITY_MIN = 25_000;
export const PDT_MAX_DAY_TRADES = 3;

type RiskInput = {
  intent: SizedTradeIntent;
  brokerConfig: BrokerConfig;
  portfolio: PortfolioAssessment;
  exitPlan?: ExitPlan;
  breaker: {
    status: "ok" | "block_new_buys" | "close_only";
  };
  metrics: {
    dailyLoss: number;
    dailyTradeCount: number;
    openPositionCount: number;
    // Broker-reported account equity and PDT day-trade count (Phase 2 Task 3).
    // Named distinctly from dailyTradeCount above -- that's this system's own
    // count of trades it placed today; these two are Alpaca's account-level
    // PDT bookkeeping, threaded straight from the account snapshot.
    accountEquity: number;
    dayTradeCount: number;
  };
  limits: {
    maxDailyLoss: number;
    maxDailyTradeCount: number;
    maxOpenPositions: number;
    minBuyingPower: number;
    cooldownSymbols?: string[];
    // Phase 2 Task 11 (docs/GO_LIVE_PLAN.md Phase 2.4, cross-source
    // confirmation): additive input, same shape/style as cooldownSymbols
    // above -- symbols whose bullish signal this cycle conflicted with a
    // bearish signal from another source within the confirmation window
    // (crossSourceConfirmation.ts). Checked as its own independent gate
    // below; does not alter any existing check's semantics.
    crossSourceConflictSymbols?: string[];
  };
};

// Phase 2 final review, finding C2: the three reviewRisk gates that can
// reject a SELL (daily loss, daily trade count, buying-power reserve --
// every other gate below is either buy-only by construction, e.g. the
// breaker/PDT/cooldown/cross-source checks, or effectively unreachable for a
// sell of an already-open position, e.g. symbol/exit-plan validity,
// open-position-count's hasPosition escape). Factored out of reviewRisk's
// body (called from there below, not duplicated) so a caller that needs to
// know "would a SELL be rejected right now" -- server.ts's sell call sites,
// which must decide this BEFORE canceling a position's live bracket legs, or
// a cancel-then-reject sequence leaves the position naked -- can ask the
// exact same question reviewRisk itself answers, with zero forked math.
// Each function mirrors exactly one of reviewRisk's existing inline checks;
// splitting them (rather than one combined "sell preflight" function) keeps
// reviewRisk's own call order/short-circuit-reason precedence byte-for-byte
// unchanged -- this refactor must not alter riskEngine gate semantics.
export function checkDailyLossGate(dailyLoss: number | undefined, maxDailyLoss: number): { rejected: boolean; reason?: string } {
  if (dailyLoss !== undefined && dailyLoss <= -Math.abs(maxDailyLoss)) {
    return { rejected: true, reason: "Maximum daily loss reached." };
  }
  return { rejected: false };
}

export function checkDailyTradeCountGate(dailyTradeCount: number, maxDailyTradeCount: number): { rejected: boolean; reason?: string } {
  if (dailyTradeCount >= maxDailyTradeCount) {
    return { rejected: true, reason: "Maximum daily trade count reached." };
  }
  return { rejected: false };
}

export function checkBuyingPowerGate(buyingPower: number, notional: number, minBuyingPower: number): { rejected: boolean; reason?: string } {
  if (buyingPower - notional < minBuyingPower) {
    return { rejected: true, reason: "Insufficient buying power after required reserve." };
  }
  return { rejected: false };
}

export type SellFatalGateInput = {
  dailyLoss?: number;
  dailyTradeCount: number;
  buyingPower: number;
  notional: number;
  limits: { maxDailyLoss: number; maxDailyTradeCount: number; minBuyingPower: number };
};

// Runs the three sell-applicable gates above, in the SAME order reviewRisk
// evaluates them (daily loss -> daily trade count -> buying power), returning
// the first rejection. This is the pre-flight entry point server.ts's sell
// call sites use before canceling bracket legs -- see the module doc comment
// above.
export function evaluateSellFatalRiskGates(input: SellFatalGateInput): { rejected: boolean; reason?: string } {
  const dailyLossCheck = checkDailyLossGate(input.dailyLoss, input.limits.maxDailyLoss);
  if (dailyLossCheck.rejected) return dailyLossCheck;
  const tradeCountCheck = checkDailyTradeCountGate(input.dailyTradeCount, input.limits.maxDailyTradeCount);
  if (tradeCountCheck.rejected) return tradeCountCheck;
  const buyingPowerCheck = checkBuyingPowerGate(input.buyingPower, input.notional, input.limits.minBuyingPower);
  if (buyingPowerCheck.rejected) return buyingPowerCheck;
  return { rejected: false };
}

export function reviewRisk(input: RiskInput): RiskDecision {
  // Fail-closed numeric boundary: every number used in a comparison below must
  // parse as finite here first. An unparsable value rejects the trade — it never
  // silently disables the guardrail it feeds (see docs/LOOP_ARCHITECTURE.md,
  // "Numeric Fail-Closed Policy").
  const numericFields: Array<[unknown, string]> = [
    [input.intent.qty, "intent.qty"],
    [input.intent.notional, "intent.notional"],
    [input.intent.estimatedPrice, "intent.estimatedPrice"],
    [input.portfolio.buyingPower, "portfolio.buyingPower"],
    [input.metrics.dailyLoss, "metrics.dailyLoss"],
    [input.metrics.dailyTradeCount, "metrics.dailyTradeCount"],
    [input.metrics.openPositionCount, "metrics.openPositionCount"],
    [input.metrics.accountEquity, "metrics.accountEquity"],
    [input.metrics.dayTradeCount, "metrics.dayTradeCount"],
    [input.limits.maxDailyLoss, "limits.maxDailyLoss"],
    [input.limits.maxDailyTradeCount, "limits.maxDailyTradeCount"],
    [input.limits.maxOpenPositions, "limits.maxOpenPositions"],
    [input.limits.minBuyingPower, "limits.minBuyingPower"],
  ];
  const parsed = new Map<string, number>();
  for (const [value, fieldName] of numericFields) {
    const result = parseFiniteNumber(value, fieldName);
    if (!result.ok) {
      // metrics.dailyLoss is REQUIRED for buys but OPTIONAL for sells: the
      // daily-loss cap limits NEW risk, and a sell reduces risk, so an
      // unavailable figure must not block flattening a position (e.g. a
      // stop-loss sell or Emergency Close All) when broker data is degraded.
      // Fail closed only for buys; for sells, mark it unavailable and skip
      // just the daily-loss comparison below (every other check still runs).
      if (fieldName === "metrics.dailyLoss" && input.intent.side === "sell") {
        continue;
      }
      // Same asymmetry for the two PDT inputs (Phase 2 Task 3): the PDT rule
      // only ever gates a BUY (see the check below), so an unavailable/
      // unparsable equity or day-trade count must not block a SELL -- it is
      // simply never consulted for one.
      if ((fieldName === "metrics.accountEquity" || fieldName === "metrics.dayTradeCount") && input.intent.side === "sell") {
        continue;
      }
      return { status: "rejected", reason: `Risk input "${fieldName}" is not a finite number; failing closed.` };
    }
    parsed.set(fieldName, result.value);
  }
  const num = (fieldName: string): number => parsed.get(fieldName)!;

  if (input.intent.side === "buy" && input.breaker.status !== "ok") {
    return { status: "rejected", reason: `Portfolio drawdown breaker is ${input.breaker.status}; new buys are blocked.` };
  }

  const symbol = validateSymbol(input.intent.symbol);
  if (!symbol.valid) return { status: "rejected", reason: symbol.reason || "Invalid symbol." };
  if (input.brokerConfig.tradingMode === "live" && !input.brokerConfig.liveTradingEnabled) {
    return { status: "rejected", reason: "Live trading is blocked unless LIVE_TRADING_ENABLED=true." };
  }
  if (!input.exitPlan) return { status: "rejected", reason: "No order may be submitted without an exit plan." };
  if (num("intent.qty") <= 0 || num("intent.notional") <= 0) {
    return { status: "rejected", reason: "Sized trade intent has no executable quantity." };
  }
  const dailyLossCheck = checkDailyLossGate(
    parsed.has("metrics.dailyLoss") ? num("metrics.dailyLoss") : undefined,
    num("limits.maxDailyLoss"),
  );
  if (dailyLossCheck.rejected) return { status: "rejected", reason: dailyLossCheck.reason! };
  const tradeCountCheck = checkDailyTradeCountGate(num("metrics.dailyTradeCount"), num("limits.maxDailyTradeCount"));
  if (tradeCountCheck.rejected) return { status: "rejected", reason: tradeCountCheck.reason! };
  // PDT guard (Phase 2 Task 3): a BUY is what OPENS the possibility of a
  // same-day SELL becoming the 4th day trade, so intervening on the BUY side
  // is the conservative, simple enforcement point. SELLs are never blocked by
  // this guard (see the fail-closed skip above) -- an exit that happens to be
  // a day trade beats a margin call/PDT lockout, and Alpaca's own broker-side
  // rejection is the final arbiter for an exit.
  if (
    input.intent.side === "buy" &&
    num("metrics.accountEquity") < PDT_EQUITY_MIN &&
    num("metrics.dayTradeCount") >= PDT_MAX_DAY_TRADES
  ) {
    return {
      status: "rejected",
      reason: `PDT guard: ${num("metrics.dayTradeCount")} day trades used, equity below $25k`,
    };
  }
  if (num("metrics.openPositionCount") >= num("limits.maxOpenPositions") && !hasPosition(input.portfolio, input.intent.symbol)) {
    return { status: "rejected", reason: "Maximum open positions reached." };
  }
  const buyingPowerCheck = checkBuyingPowerGate(num("portfolio.buyingPower"), num("intent.notional"), num("limits.minBuyingPower"));
  if (buyingPowerCheck.rejected) return { status: "rejected", reason: buyingPowerCheck.reason! };
  if (input.portfolio.openOrders.some((order) => order.symbol === input.intent.symbol && order.side === input.intent.side && !isTerminal(order.status))) {
    return { status: "rejected", reason: "Duplicate open order protection triggered." };
  }
  if (input.limits.cooldownSymbols?.includes(input.intent.symbol)) {
    return { status: "requires_human_approval", reason: "Symbol is in cooldown after a rejected or failed trade." };
  }
  // Phase 2 Task 11: additive gate, same requires_human_approval shape as the
  // cooldown check just above -- a conflict never auto-resolves.
  if (input.limits.crossSourceConflictSymbols?.includes(input.intent.symbol)) {
    return { status: "requires_human_approval", reason: "Symbol has a conflicting cross-source signal (another source disagrees) within the confirmation window." };
  }
  return { status: "approved", reason: "Centralized risk checks passed." };
}

function hasPosition(portfolio: PortfolioAssessment, symbol: string) {
  return portfolio.positions.some((position) => position.symbol === symbol && Number(position.qty) > 0);
}

function isTerminal(status: string) {
  return ["filled", "canceled", "cancelled", "expired", "rejected"].includes(status.toLowerCase());
}
