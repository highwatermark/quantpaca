import { AlpacaAccount, AlpacaPosition } from "../types";
import { ReconciliationReport } from "./domainTypes";

type LocalTrade = {
  id: string;
  brokerOrderId?: string;
  symbol: string;
  qty: number;
  side: "buy" | "sell";
  status: string;
};

type BrokerOrder = {
  id: string;
  symbol: string;
  qty: string;
  side: "buy" | "sell";
  status: string;
};

export function reconcileBrokerState(input: {
  localTrades: LocalTrade[];
  brokerOrders: BrokerOrder[];
  brokerPositions: AlpacaPosition[];
  account: AlpacaAccount;
}): ReconciliationReport {
  const mismatches: ReconciliationReport["mismatches"] = [];
  const brokerOrdersById = new Map(input.brokerOrders.map((order) => [order.id, order]));

  for (const trade of input.localTrades) {
    if (!trade.brokerOrderId && isBrokerSubmittedState(trade.status)) {
      mismatches.push({ type: "missing_broker_order", localId: trade.id, symbol: trade.symbol, expected: trade.status, actual: "none" });
      continue;
    }
    if (!trade.brokerOrderId) continue;
    const brokerOrder = brokerOrdersById.get(trade.brokerOrderId);
    if (!brokerOrder) {
      mismatches.push({ type: "missing_broker_order", localId: trade.id, brokerId: trade.brokerOrderId, symbol: trade.symbol });
      continue;
    }
    const localTerminal = normalizeStatus(trade.status);
    const brokerTerminal = normalizeStatus(brokerOrder.status);
    if (localTerminal !== brokerTerminal) {
      mismatches.push({
        type: "order_status",
        localId: trade.id,
        brokerId: brokerOrder.id,
        symbol: trade.symbol,
        expected: localTerminal,
        actual: brokerTerminal,
      });
    }
  }

  return {
    id: `rec-${Date.now()}`,
    timestamp: new Date().toISOString(),
    status: mismatches.length ? "mismatch" : "matched",
    mismatches,
    account: input.account,
  };
}

function isBrokerSubmittedState(status: string) {
  return ["BrokerSubmitted", "Accepted", "PartiallyFilled", "Filled"].includes(status);
}

function normalizeStatus(status: string) {
  const lower = status.toLowerCase();
  if (lower === "filled") return "filled";
  if (lower === "accepted" || lower === "new" || lower === "pending_new") return "accepted";
  if (lower === "partially_filled") return "partially_filled";
  if (lower === "rejected") return "rejected";
  if (lower === "brokerfailed") return "failed";
  return lower;
}
