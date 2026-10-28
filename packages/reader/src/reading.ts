import {
  exclusiveToInclusive,
  isCalendarDate,
  normalizeInvoiceRegistrationNumber,
  type CalendarDate,
  type Money,
} from "@niho-finance/ledger";
import { z } from "zod";
import { ReaderError } from "./provider";

/**
 * The proposal read from a document (20-reader §3): the JSON Schema the model answers with, and
 * `parseReading`, which checks the answer and normalizes it into a `Reading`.
 */

export const DOCUMENT_TYPE_GUESSES = ["receipt", "invoice", "other"] as const;
export type DocumentTypeGuess = (typeof DOCUMENT_TYPE_GUESSES)[number];

/** 10% standard, 8% reduced, 0% (out of scope or exempt as printed). */
export const READING_RATE_PERCENTS = [10, 8, 0] as const;
export type ReadingRatePercent = (typeof READING_RATE_PERCENTS)[number];

export const ISSUER_NAME_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 60;

export interface ReadingRate {
  ratePercent: ReadingRatePercent;
  /** The consideration for the rate as printed. */
  amount: Money;
  /** Whether `amount` includes the tax. */
  taxIncluded: boolean;
  /** The tax for the rate as printed, `null` when not printed. */
  taxAmount: Money | null;
  /** `amount` with the tax: as is, `amount + taxAmount`, or computed when the tax is not printed. */
  inclusiveAmount: Money;
}

export interface Reading {
  documentType: DocumentTypeGuess;
  legible: boolean;
  issuerName: string | null;
  /** Normalized (half-width digits, no separators); may still be malformed — see `validateReading`. */
  registrationNumber: string | null;
  registrationNumberAsPrinted: string | null;
  /** `null` when missing or not a calendar date. */
  transactionDate: CalendarDate | null;
  /** The date string the model returned, kept when it is not a calendar date. */
  transactionDateAsPrinted: string | null;
  /** ISO 4217, upper case. */
  currency: string;
  /** The amount paid, tax included. */
  totalAmount: Money | null;
  rates: ReadingRate[];
  description: string | null;
}

const nullable = <T extends Record<string, unknown>>(schema: T) => ({
  anyOf: [schema, { type: "null" }],
});

/**
 * Structured output schema (20-reader §3). Every object is closed and every key required; `null`
 * is an `anyOf` branch. Constraints structured outputs do not accept (minimum, maxLength) are left
 * to `parseReading`.
 */
export const READING_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "documentType",
    "legible",
    "issuerName",
    "registrationNumber",
    "transactionDate",
    "currency",
    "totalAmount",
    "rates",
    "description",
  ],
  properties: {
    documentType: {
      type: "string",
      enum: [...DOCUMENT_TYPE_GUESSES],
      description: "receipt: 領収書・レシート、invoice: 請求書、other: それ以外",
    },
    legible: {
      type: "boolean",
      description: "全体が読めたか。かすれ・切れ・ピンぼけで読めない部分があれば false",
    },
    issuerName: {
      ...nullable({ type: "string" }),
      description: "発行者の名称（印字どおり）",
    },
    registrationNumber: {
      ...nullable({ type: "string" }),
      description: "登録番号（印字どおり。T と 13 桁）",
    },
    transactionDate: {
      ...nullable({ type: "string", format: "date" }),
      description: "取引年月日（YYYY-MM-DD）。請求書で取引日がなければ請求日",
    },
    currency: { type: "string", description: "ISO 4217 の通貨コード（JPY など）" },
    totalAmount: {
      ...nullable({ type: "integer" }),
      description: "支払う合計（税込）",
    },
    rates: {
      type: "array",
      description: "税率ごとの内訳。印字がなければ空",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ratePercent", "amount", "taxIncluded", "taxAmount"],
        properties: {
          ratePercent: {
            type: "integer",
            enum: [...READING_RATE_PERCENTS],
            description: "税率（8 は軽減税率）",
          },
          amount: { type: "integer", description: "その税率の対価の額（印字どおり）" },
          taxIncluded: { type: "boolean", description: "amount が税込か" },
          taxAmount: {
            ...nullable({ type: "integer" }),
            description: "その税率の消費税額（印字がなければ null）",
          },
        },
      },
    },
    description: {
      ...nullable({ type: "string" }),
      description: "但し書き・品目の要約（60 字まで）",
    },
  },
} as const;

/** A whole, non-negative yen amount within the safe integer range. */
const yenSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .transform((value) => BigInt(value));

const rawRateSchema = z.object({
  ratePercent: z.union([z.literal(10), z.literal(8), z.literal(0)]),
  amount: yenSchema,
  taxIncluded: z.boolean(),
  taxAmount: yenSchema.nullable(),
});

const rawReadingSchema = z.object({
  documentType: z.enum(DOCUMENT_TYPE_GUESSES),
  legible: z.boolean(),
  issuerName: z.string().nullable(),
  registrationNumber: z.string().nullable(),
  transactionDate: z.string().nullable(),
  currency: z.string(),
  totalAmount: yenSchema.nullable(),
  rates: z.array(rawRateSchema),
  description: z.string().nullable(),
});

/** Trimmed, cut to `max` characters (code points); empty → `null`. */
function cleanText(value: string | null, max: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const chars = Array.from(trimmed);
  return chars.length > max ? chars.slice(0, max).join("") : trimmed;
}

const YEN_ALIASES = new Set(["JPY", "YEN", "円", "¥", "￥"]);

function normalizeCurrency(value: string): string {
  const upper = value.trim().normalize("NFKC").toUpperCase();
  if (upper === "" || YEN_ALIASES.has(upper)) return "JPY";
  return upper.slice(0, 16);
}

/** The tax-inclusive amount of a rate line (§3). */
export function inclusiveAmountOf(rate: {
  ratePercent: ReadingRatePercent;
  amount: Money;
  taxIncluded: boolean;
  taxAmount: Money | null;
}): Money {
  if (rate.taxIncluded) return rate.amount;
  if (rate.taxAmount !== null) return rate.amount + rate.taxAmount;
  return exclusiveToInclusive(rate.amount, rate.ratePercent);
}

/**
 * Checks the provider's answer and normalizes it (§3). A shape the schema does not allow — a
 * missing key, a wrong type, a negative or fractional amount — is `ReaderError("invalid_output")`;
 * a date that is not a calendar date becomes `null` (the validation warns).
 */
export function parseReading(raw: unknown): Reading {
  const parsed = rawReadingSchema.safeParse(raw);
  if (!parsed.success) throw new ReaderError("invalid_output");
  const value = parsed.data;

  const registrationAsPrinted = cleanText(value.registrationNumber, ISSUER_NAME_MAX_LENGTH);
  const registrationNumber =
    registrationAsPrinted === null
      ? null
      : normalizeInvoiceRegistrationNumber(registrationAsPrinted.normalize("NFKC"));
  const dateAsPrinted = cleanText(value.transactionDate, ISSUER_NAME_MAX_LENGTH);
  const transactionDate =
    dateAsPrinted !== null && isCalendarDate(dateAsPrinted) ? dateAsPrinted : null;

  return {
    documentType: value.documentType,
    legible: value.legible,
    issuerName: cleanText(value.issuerName, ISSUER_NAME_MAX_LENGTH),
    registrationNumber: registrationNumber === "" ? null : registrationNumber,
    registrationNumberAsPrinted: registrationAsPrinted,
    transactionDate,
    transactionDateAsPrinted: dateAsPrinted,
    currency: normalizeCurrency(value.currency),
    totalAmount: value.totalAmount,
    rates: value.rates.map((rate) => ({ ...rate, inclusiveAmount: inclusiveAmountOf(rate) })),
    description: cleanText(value.description, DESCRIPTION_MAX_LENGTH),
  };
}

/** A rate line as JSON: amounts as decimal strings. */
export interface StoredReadingRate {
  ratePercent: ReadingRatePercent;
  amount: string;
  taxIncluded: boolean;
  taxAmount: string | null;
  inclusiveAmount: string;
}

/** `Reading` as JSON for `document.extraction.reading` (20-reader §7.1): `bigint` → decimal string. */
export interface StoredReading {
  documentType: DocumentTypeGuess;
  legible: boolean;
  issuerName: string | null;
  registrationNumber: string | null;
  registrationNumberAsPrinted: string | null;
  transactionDate: CalendarDate | null;
  transactionDateAsPrinted: string | null;
  currency: string;
  totalAmount: string | null;
  rates: StoredReadingRate[];
  description: string | null;
}

export function toStoredReading(reading: Reading): StoredReading {
  return {
    documentType: reading.documentType,
    legible: reading.legible,
    issuerName: reading.issuerName,
    registrationNumber: reading.registrationNumber,
    registrationNumberAsPrinted: reading.registrationNumberAsPrinted,
    transactionDate: reading.transactionDate,
    transactionDateAsPrinted: reading.transactionDateAsPrinted,
    currency: reading.currency,
    totalAmount: reading.totalAmount === null ? null : reading.totalAmount.toString(),
    rates: reading.rates.map((rate) => ({
      ratePercent: rate.ratePercent,
      amount: rate.amount.toString(),
      taxIncluded: rate.taxIncluded,
      taxAmount: rate.taxAmount === null ? null : rate.taxAmount.toString(),
      inclusiveAmount: rate.inclusiveAmount.toString(),
    })),
    description: reading.description,
  };
}

const storedYenSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .transform((value) => BigInt(value));

const storedReadingSchema = z.object({
  documentType: z.enum(DOCUMENT_TYPE_GUESSES),
  legible: z.boolean(),
  issuerName: z.string().nullable(),
  registrationNumber: z.string().nullable(),
  registrationNumberAsPrinted: z.string().nullable(),
  transactionDate: z
    .string()
    .refine((value) => isCalendarDate(value))
    .nullable(),
  transactionDateAsPrinted: z.string().nullable(),
  currency: z.string(),
  totalAmount: storedYenSchema.nullable(),
  rates: z.array(
    z.object({
      ratePercent: z.union([z.literal(10), z.literal(8), z.literal(0)]),
      amount: storedYenSchema,
      taxIncluded: z.boolean(),
      taxAmount: storedYenSchema.nullable(),
      inclusiveAmount: storedYenSchema,
    }),
  ),
  description: z.string().nullable(),
});

/** Back from JSON; `null` when the value is not a stored reading (old or broken). */
export function fromStoredReading(json: unknown): Reading | null {
  const parsed = storedReadingSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
