import { parseFiniteNumber } from "./numericSafety";

export interface CooldownConfig {
  // Hours a symbol stays in cooldown after a trade intent reaches the broker
  // (submitted/accepted/filled) or fails at the broker (rejected/BrokerFailed/
  // UnknownBrokerState). 0 is an explicit escape hatch that disables cooldown
  // entirely (documented for tests/operators); negative or non-finite values
  // are a fatal config error rather than a silent default.
  symbolCooldownHours: number;
}

const ENV_NAME = "QUANTPACA_SYMBOL_COOLDOWN_HOURS";
const DEFAULT_HOURS = "24";

export function loadCooldownConfig(
  env: NodeJS.ProcessEnv,
): { ok: true; config: CooldownConfig } | { ok: false; errors: string[] } {
  const raw = env[ENV_NAME] ?? DEFAULT_HOURS;
  const parsed = parseFiniteNumber(raw, ENV_NAME);
  if (!parsed.ok || parsed.value < 0) {
    return {
      ok: false,
      errors: [`${ENV_NAME}="${String(raw)}" must be a non-negative finite number (0 disables cooldown).`],
    };
  }
  return { ok: true, config: { symbolCooldownHours: parsed.value } };
}
