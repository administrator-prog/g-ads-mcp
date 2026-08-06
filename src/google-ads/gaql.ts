import { z } from "zod";

import { GoogleAdsToolError } from "./client.js";

/**
 * Predefined GAQL date-range constants. Restricting callers to this list (plus
 * an explicit start/end pair) keeps every query literal-free.
 */
export const DATE_RANGES = [
  "TODAY",
  "YESTERDAY",
  "LAST_7_DAYS",
  "LAST_14_DAYS",
  "LAST_30_DAYS",
  "THIS_WEEK_SUN_TODAY",
  "THIS_WEEK_MON_TODAY",
  "LAST_WEEK_SUN_SAT",
  "LAST_WEEK_MON_SUN",
  "LAST_BUSINESS_WEEK",
  "THIS_MONTH",
  "LAST_MONTH",
] as const;

export type DateRange = (typeof DATE_RANGES)[number];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const dateRangeShape = {
  date_range: z
    .enum(DATE_RANGES)
    .default("LAST_30_DAYS")
    .describe("Predefined reporting window. Ignored when start_date and end_date are supplied."),
  start_date: z
    .string()
    .regex(ISO_DATE, "start_date must be YYYY-MM-DD")
    .optional()
    .describe("Inclusive start date (YYYY-MM-DD). Must be paired with end_date."),
  end_date: z
    .string()
    .regex(ISO_DATE, "end_date must be YYYY-MM-DD")
    .optional()
    .describe("Inclusive end date (YYYY-MM-DD). Must be paired with start_date."),
};

export interface DateRangeInput {
  date_range?: DateRange;
  start_date?: string | undefined;
  end_date?: string | undefined;
}

/** Renders the `segments.date` predicate for a validated date-range input. */
export function dateCondition(input: DateRangeInput): string {
  const { start_date: start, end_date: end } = input;

  if (start || end) {
    if (!start || !end) {
      throw new GoogleAdsToolError("start_date and end_date must be provided together.");
    }
    if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) {
      throw new GoogleAdsToolError("start_date and end_date must use the YYYY-MM-DD format.");
    }
    if (start > end) {
      throw new GoogleAdsToolError(`start_date (${start}) must not be after end_date (${end}).`);
    }
    return `segments.date BETWEEN '${start}' AND '${end}'`;
  }

  return `segments.date DURING ${input.date_range ?? "LAST_30_DAYS"}`;
}

/** Human-readable description of the window, echoed back in tool responses. */
export function describeDateRange(input: DateRangeInput): string {
  if (input.start_date && input.end_date) {
    return `${input.start_date} to ${input.end_date}`;
  }
  return input.date_range ?? "LAST_30_DAYS";
}

/** Assembles a SELECT statement from already-validated fragments. */
export function buildQuery(parts: {
  select: string[];
  from: string;
  where?: Array<string | undefined>;
  orderBy?: string;
  limit?: number;
}): string {
  const conditions = (parts.where ?? []).filter(
    (condition): condition is string => typeof condition === "string" && condition.length > 0,
  );

  const segments = [`SELECT ${parts.select.join(", ")}`, `FROM ${parts.from}`];
  if (conditions.length > 0) segments.push(`WHERE ${conditions.join(" AND ")}`);
  if (parts.orderBy) segments.push(`ORDER BY ${parts.orderBy}`);
  if (parts.limit !== undefined) segments.push(`LIMIT ${Math.trunc(parts.limit)}`);

  return segments.join(" ");
}

/**
 * Renders a GAQL `IN (...)` list from an allow-listed set of enum names.
 * Values are checked against `allowed` so nothing unvalidated reaches a query.
 */
export function enumInClause(
  field: string,
  values: readonly string[] | undefined,
  allowed: readonly string[],
): string | undefined {
  if (!values || values.length === 0) return undefined;

  const invalid = values.filter((value) => !allowed.includes(value));
  if (invalid.length > 0) {
    throw new GoogleAdsToolError(
      `Unsupported value(s) for ${field}: ${invalid.join(", ")}. Allowed: ${allowed.join(", ")}.`,
    );
  }

  const unique = [...new Set(values)];
  return unique.length === 1
    ? `${field} = '${unique[0]}'`
    : `${field} IN (${unique.map((value) => `'${value}'`).join(", ")})`;
}
