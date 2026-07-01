import { createHash } from "node:crypto";
import { RawSignal, ReviewedSignal, SignalSource } from "./domainTypes";
import { validateSymbol } from "./tradingSafety";

type RawSignalInput = {
  source: SignalSource;
  sourceId: string;
  sourceTimestamp: string;
  symbol: string;
  thesis: string;
  url?: string;
  aiConfidence?: number;
};

type ReviewOptions = {
  now?: Date;
  maxAgeHours?: number;
  seenKeys?: Set<string>;
};

export function createRawSignal(input: RawSignalInput): RawSignal {
  const thesis = String(input.thesis || "").trim();
  return {
    id: `raw-${hash([input.source, input.sourceId, input.symbol, input.sourceTimestamp, thesis].join("|")).slice(0, 12)}`,
    source: input.source,
    sourceId: String(input.sourceId || "").trim(),
    sourceTimestamp: input.sourceTimestamp,
    symbol: String(input.symbol || "").trim().toUpperCase(),
    thesis,
    normalizedThesisHash: hash(normalizeThesis(thesis)),
    url: input.url,
    aiConfidence: input.aiConfidence,
  };
}

export function reviewSignals(rawSignals: RawSignal[], options: ReviewOptions = {}): ReviewedSignal[] {
  const seenKeys = options.seenKeys || new Set<string>();
  return rawSignals.map((signal) => reviewSignal(signal, { ...options, seenKeys }));
}

export function reviewSignal(rawSignal: RawSignal, options: ReviewOptions = {}): ReviewedSignal {
  const now = options.now || new Date();
  const maxAgeHours = options.maxAgeHours || 72;
  const symbolValidation = validateSymbol(rawSignal.symbol);
  const duplicateKey = [rawSignal.source, rawSignal.sourceId, symbolValidation.normalized || rawSignal.symbol, rawSignal.normalizedThesisHash].join("|");
  const sourceTime = Date.parse(rawSignal.sourceTimestamp);
  const ageHours = Number.isFinite(sourceTime) ? (now.getTime() - sourceTime) / 36e5 : Infinity;
  const confidenceScore = normalizeConfidence(rawSignal);
  const base: ReviewedSignal = {
    id: `rs-${hash(rawSignal.id).slice(0, 12)}`,
    rawSignalId: rawSignal.id,
    symbol: symbolValidation.normalized || rawSignal.symbol,
    source: rawSignal.source,
    sourceTimestamp: rawSignal.sourceTimestamp,
    freshnessStatus: ageHours <= maxAgeHours ? "fresh" : "stale",
    confidenceScore,
    classification: classify(rawSignal.thesis),
    thesisSummary: summarize(rawSignal.thesis),
    invalidationConditions: buildInvalidationConditions(rawSignal.thesis),
    evidence: rawSignal.url ? [rawSignal.url] : [],
    status: "accepted",
  };

  if (!symbolValidation.valid || !rawSignal.sourceId || !rawSignal.thesis) {
    return reject(base, "malformed");
  }
  if (rawSignal.source === "gemini" && (!Number.isFinite(rawSignal.aiConfidence) || rawSignal.aiConfidence! < 0 || rawSignal.aiConfidence! > 100)) {
    return reject(base, "unsupported");
  }
  if (ageHours > maxAgeHours) {
    return reject(base, "stale");
  }
  if (options.seenKeys?.has(duplicateKey)) {
    return reject(base, "duplicate");
  }
  if (confidenceScore < 35) {
    return reject(base, "low_confidence");
  }

  options.seenKeys?.add(duplicateKey);
  return base;
}

function reject(signal: ReviewedSignal, reason: ReviewedSignal["rejectionReason"]): ReviewedSignal {
  return { ...signal, status: "rejected", rejectionReason: reason };
}

function normalizeConfidence(signal: RawSignal) {
  if (Number.isFinite(signal.aiConfidence)) return Math.max(0, Math.min(100, Number(signal.aiConfidence)));
  const words = signal.thesis.split(/\s+/).filter(Boolean).length;
  return Math.max(0, Math.min(100, 40 + words * 3));
}

function classify(thesis: string): ReviewedSignal["classification"] {
  const normalized = thesis.toLowerCase();
  if (/\b(sell|bearish|breakdown|reversal|weak|risk|short)\b/.test(normalized)) return "bearish";
  if (/\b(buy|bullish|growth|accelerat|strong|accumulat|breakout)\b/.test(normalized)) return "bullish";
  return "neutral";
}

function buildInvalidationConditions(thesis: string) {
  const lower = thesis.toLowerCase();
  if (lower.includes("support")) return ["Break below cited support or thesis catalyst fails."];
  if (lower.includes("growth")) return ["Growth thesis decelerates or market regime blocks new buys."];
  return ["Source thesis invalidated or market regime shifts to close-only."];
}

function summarize(thesis: string) {
  return thesis.length > 240 ? `${thesis.slice(0, 237)}...` : thesis;
}

function normalizeThesis(thesis: string) {
  return thesis.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
