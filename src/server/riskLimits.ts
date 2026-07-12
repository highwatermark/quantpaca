import { FiniteNumber, parseFiniteNumber } from "./numericSafety";

export interface RiskLimits {
  maxDailyLoss: FiniteNumber;
  maxDailyTradeCount: FiniteNumber;
  maxOpenPositions: FiniteNumber;
  minBuyingPower: FiniteNumber;
  maxDailyLossPercent: FiniteNumber;
  maxDrawdownFromPeakPercent: FiniteNumber;
  maxDrawdownFromBaselinePercent: FiniteNumber;
  baselineEquity: FiniteNumber | null;
  maxPortfolioExposurePercent: FiniteNumber;
}

type RequiredPositiveKey = Exclude<keyof RiskLimits, "baselineEquity">;

const REQUIRED_POSITIVE: Array<[RequiredPositiveKey, string, string]> = [
  ["maxDailyLoss", "QUANTPACA_MAX_DAILY_LOSS", "500"],
  ["maxDailyTradeCount", "QUANTPACA_MAX_DAILY_TRADES", "10"],
  ["maxOpenPositions", "QUANTPACA_MAX_OPEN_POSITIONS", "10"],
  ["minBuyingPower", "QUANTPACA_MIN_BUYING_POWER", "100"],
  ["maxDailyLossPercent", "QUANTPACA_MAX_DAILY_LOSS_PERCENT", "3"],
  ["maxDrawdownFromPeakPercent", "QUANTPACA_MAX_DRAWDOWN_FROM_PEAK_PERCENT", "10"],
  ["maxDrawdownFromBaselinePercent", "QUANTPACA_MAX_DRAWDOWN_FROM_BASELINE_PERCENT", "15"],
];

export function loadRiskLimits(
  env: NodeJS.ProcessEnv,
): { ok: true; limits: RiskLimits } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const limits = {} as RiskLimits;

  for (const [key, envName, fallback] of REQUIRED_POSITIVE) {
    const raw = env[envName] ?? fallback;
    const parsed = parseFiniteNumber(raw, envName);
    if (!parsed.ok || parsed.value <= 0) {
      errors.push(`${envName}="${String(raw)}" must be a positive finite number.`);
      continue;
    }
    limits[key] = parsed.value;
  }

  // Portfolio-level exposure cap: bounded to (0, 100] since it is a percent-of-equity
  // ceiling on aggregate long exposure, unlike the other REQUIRED_POSITIVE limits above
  // which have no natural upper bound.
  const rawMaxPortfolioExposurePercent = env.QUANTPACA_MAX_PORTFOLIO_EXPOSURE_PERCENT ?? "60";
  const parsedMaxPortfolioExposurePercent = parseFiniteNumber(
    rawMaxPortfolioExposurePercent,
    "QUANTPACA_MAX_PORTFOLIO_EXPOSURE_PERCENT",
  );
  if (
    !parsedMaxPortfolioExposurePercent.ok ||
    parsedMaxPortfolioExposurePercent.value <= 0 ||
    parsedMaxPortfolioExposurePercent.value > 100
  ) {
    errors.push(
      `QUANTPACA_MAX_PORTFOLIO_EXPOSURE_PERCENT="${String(rawMaxPortfolioExposurePercent)}" must be a finite number in (0, 100].`,
    );
  } else {
    limits.maxPortfolioExposurePercent = parsedMaxPortfolioExposurePercent.value;
  }

  // Optional: when unset, the baseline-drawdown breaker check is skipped (conservative
  // mode is enforced by the daily-loss and peak-drawdown checks, which never skip).
  const rawBaseline = env.QUANTPACA_BASELINE_EQUITY;
  if (rawBaseline === undefined || rawBaseline === "") {
    limits.baselineEquity = null;
  } else {
    const parsed = parseFiniteNumber(rawBaseline, "QUANTPACA_BASELINE_EQUITY");
    if (!parsed.ok || parsed.value <= 0) {
      errors.push(`QUANTPACA_BASELINE_EQUITY="${String(rawBaseline)}" must be a positive finite number or unset.`);
    } else {
      limits.baselineEquity = parsed.value;
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, limits };
}
