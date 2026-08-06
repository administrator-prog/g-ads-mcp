/**
 * Normalisation helpers for Google Ads API responses.
 *
 * Two things make raw rows awkward for an LLM to reason about: int64 fields
 * arrive as strings (or Long objects), and money is expressed in micros. These
 * helpers produce plain numbers in currency units, rounded sensibly.
 */

const MICROS_PER_UNIT = 1_000_000;

interface LongLike {
  low: number;
  high: number;
  unsigned?: boolean;
  toNumber?: () => number;
}

function isLongLike(value: unknown): value is LongLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as LongLike).low === "number" &&
    typeof (value as LongLike).high === "number"
  );
}

/** Coerces an int64/double/string field to a number, or undefined if absent. */
export function num(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (isLongLike(value)) {
    if (typeof value.toNumber === "function") return value.toNumber();
    return value.high * 2 ** 32 + (value.low >>> 0);
  }
  if (typeof value === "bigint") return Number(value);
  return undefined;
}

/** Converts a micros field to currency units, rounded to cents. */
export function fromMicros(value: unknown): number | undefined {
  const raw = num(value);
  if (raw === undefined) return undefined;
  return round(raw / MICROS_PER_UNIT, 2);
}

export function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export interface PerformanceMetrics {
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  conversions_value: number;
  ctr_percent: number;
  average_cpc: number;
  cost_per_conversion: number | null;
  conversion_rate_percent: number;
  value_per_cost_roas: number | null;
}

/** The metric fields every performance query selects, in GAQL form. */
export const METRIC_FIELDS = [
  "metrics.impressions",
  "metrics.clicks",
  "metrics.cost_micros",
  "metrics.conversions",
  "metrics.conversions_value",
] as const;

/**
 * Builds a consistent metric block from a row's `metrics` object. Derived
 * ratios are computed here rather than selected from the API so they stay
 * coherent with the raw counters in the same response.
 */
export function performanceMetrics(metrics: unknown): PerformanceMetrics {
  const source = (metrics ?? {}) as Record<string, unknown>;

  const impressions = num(source.impressions) ?? 0;
  const clicks = num(source.clicks) ?? 0;
  const cost = fromMicros(source.cost_micros) ?? 0;
  const conversions = round(num(source.conversions) ?? 0, 2);
  const conversionsValue = round(num(source.conversions_value) ?? 0, 2);

  return {
    impressions,
    clicks,
    cost,
    conversions,
    conversions_value: conversionsValue,
    ctr_percent: impressions > 0 ? round((clicks / impressions) * 100, 2) : 0,
    average_cpc: clicks > 0 ? round(cost / clicks, 2) : 0,
    cost_per_conversion: conversions > 0 ? round(cost / conversions, 2) : null,
    conversion_rate_percent: clicks > 0 ? round((conversions / clicks) * 100, 2) : 0,
    value_per_cost_roas: cost > 0 ? round(conversionsValue / cost, 2) : null,
  };
}

/** Sums a set of per-row metric blocks into a single totals block. */
export function sumMetrics(rows: PerformanceMetrics[]): PerformanceMetrics {
  const totals = rows.reduce(
    (acc, row) => ({
      impressions: acc.impressions + row.impressions,
      clicks: acc.clicks + row.clicks,
      cost: acc.cost + row.cost,
      conversions: acc.conversions + row.conversions,
      conversions_value: acc.conversions_value + row.conversions_value,
    }),
    { impressions: 0, clicks: 0, cost: 0, conversions: 0, conversions_value: 0 },
  );

  return performanceMetrics({
    impressions: totals.impressions,
    clicks: totals.clicks,
    cost_micros: Math.round(totals.cost * MICROS_PER_UNIT),
    conversions: totals.conversions,
    conversions_value: totals.conversions_value,
  });
}

/** Drops undefined/null entries so responses stay compact and unambiguous. */
export function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined && entry !== null) result[key] = entry;
  }
  return result as Partial<T>;
}
