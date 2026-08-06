import { Customer, GoogleAdsApi, enums } from "google-ads-api";

import { normalizeCustomerId, type Config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Raised for problems we can explain to the caller (bad customer ID, missing
 * configuration, a rejected GAQL query). Distinguished from unexpected errors
 * so tool handlers can surface the message without leaking internals.
 */
export class GoogleAdsToolError extends Error {
  readonly details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = "GoogleAdsToolError";
    this.details = details;
  }
}

/** A GAQL row as returned by the client: nested objects keyed by resource. */
export type AdsRow = Record<string, unknown>;

export class GoogleAdsClient {
  private readonly api: GoogleAdsApi;
  private readonly customers = new Map<string, Customer>();

  private constructor(
    api: GoogleAdsApi,
    private readonly refreshToken: string,
    private readonly loginCustomerId: string | undefined,
  ) {
    this.api = api;
  }

  /**
   * Builds a client from configuration, or throws a message that tells the
   * operator exactly which variable is missing. Called lazily per tool
   * invocation so the server still boots (and serves /auth) without a token.
   */
  static fromConfig(config: Config): GoogleAdsClient {
    const missing: string[] = [];
    if (!config.google.developerToken) missing.push("GOOGLE_ADS_DEVELOPER_TOKEN");
    if (!config.google.refreshToken) missing.push("GOOGLE_ADS_REFRESH_TOKEN");

    if (missing.length > 0) {
      throw new GoogleAdsToolError(
        `Google Ads API is not configured. Missing environment variable(s): ${missing.join(", ")}.`,
        missing.includes("GOOGLE_ADS_REFRESH_TOKEN")
          ? ["Visit GET /auth?token=<MCP_AUTH_TOKEN> on this server to complete consent and mint a refresh token."]
          : [],
      );
    }

    const api = new GoogleAdsApi({
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      developer_token: config.google.developerToken!,
    });

    return new GoogleAdsClient(api, config.google.refreshToken!, config.google.loginCustomerId);
  }

  /** The manager account ID requests are made through, if configured. */
  get defaultManagerId(): string | undefined {
    return this.loginCustomerId;
  }

  /** Accounts the authorized user can reach directly, as digit-only IDs. */
  async listAccessibleCustomerIds(): Promise<string[]> {
    const response = await this.api.listAccessibleCustomers(this.refreshToken);
    return (response.resource_names ?? []).map((name) => name.split("/").pop() ?? name);
  }

  /** Cached per-customer handle; constructing one is cheap but not free. */
  customer(customerId: string): Customer {
    const id = assertCustomerId(customerId);
    const cached = this.customers.get(id);
    if (cached) return cached;

    const customer = this.api.Customer({
      customer_id: id,
      refresh_token: this.refreshToken,
      ...(this.loginCustomerId ? { login_customer_id: this.loginCustomerId } : {}),
    });

    this.customers.set(id, customer);
    return customer;
  }

  /**
   * Runs a GAQL query. Queries are always assembled in this codebase from
   * validated inputs — no caller-supplied GAQL is ever executed.
   */
  async query(customerId: string, gaql: string): Promise<AdsRow[]> {
    const id = assertCustomerId(customerId);
    logger.debug("Running GAQL query", { customerId: id, gaql });

    try {
      const rows = await this.customer(id).query<AdsRow[]>(gaql);
      logger.debug("GAQL query returned", { customerId: id, rows: rows.length });
      return rows;
    } catch (error) {
      throw toToolError(error);
    }
  }
}

/** Validates and normalises a customer ID, e.g. "123-456-7890" → "1234567890". */
export function assertCustomerId(value: string): string {
  const id = normalizeCustomerId(value);
  if (id.length < 7 || id.length > 12) {
    throw new GoogleAdsToolError(
      `Invalid customer ID "${value}". Expected a 10-digit Google Ads customer ID, with or without dashes.`,
    );
  }
  return id;
}

interface GoogleAdsFailureLike {
  errors?: Array<{
    message?: string | null;
    error_code?: Record<string, unknown> | null;
    location?: unknown;
  }>;
}

function isFailureLike(value: unknown): value is GoogleAdsFailureLike {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as GoogleAdsFailureLike).errors)
  );
}

/**
 * Turns whatever the Ads client threw into a message a human can act on.
 * GoogleAdsFailure carries a list of typed errors; everything else is passed
 * through with its message only.
 */
export function toToolError(error: unknown): GoogleAdsToolError {
  if (error instanceof GoogleAdsToolError) return error;

  if (isFailureLike(error)) {
    const details = (error.errors ?? []).map((entry) => {
      const code = entry.error_code
        ? Object.entries(entry.error_code)
            .filter(([, v]) => v !== null && v !== undefined)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(",")
        : "";
      const message = entry.message ?? "Unknown error";
      return code ? `${message} (${code})` : message;
    });

    return new GoogleAdsToolError(
      "The Google Ads API rejected the request.",
      details.length > 0 ? details : ["No error details were returned."],
    );
  }

  if (error instanceof Error) {
    return new GoogleAdsToolError(`Google Ads API request failed: ${error.message}`);
  }

  return new GoogleAdsToolError(`Google Ads API request failed: ${String(error)}`);
}

/**
 * Google Ads returns enums as integers. Map them back to their string names so
 * responses are self-describing rather than a wall of magic numbers.
 */
export function enumName(
  enumMap: Record<string | number, string | number>,
  value: unknown,
): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "number") return undefined;
  const name = enumMap[value];
  return typeof name === "string" ? name : undefined;
}

export { enums };
