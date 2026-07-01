export type FiniteNumber = number & { readonly __brand: "FiniteNumber" };

export type ParsedFiniteNumber =
  | { ok: true; value: FiniteNumber }
  | { ok: false; fieldName: string };

export function parseFiniteNumber(value: unknown, fieldName: string): ParsedFiniteNumber {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  return Number.isFinite(n)
    ? { ok: true, value: n as FiniteNumber }
    : { ok: false, fieldName };
}
