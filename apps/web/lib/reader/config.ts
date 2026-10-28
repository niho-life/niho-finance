import { loadRootEnv } from "@niho-finance/db";
import { createNtaLookupFromEnv, ntaConfig, type NtaLookup } from "@niho-finance/importers";
import {
  createReader,
  readerConfig,
  type ReaderModel,
  type ReaderProvider,
} from "@niho-finance/reader";

/**
 * The reading provider and the registry lookup of this process (20-reader §2.2・§8.2), chosen by
 * the environment. Screens get only whether each is on and with what model; the API key and the
 * application ID stay in the packages and are never returned or logged from here.
 */

export interface ReaderStatus {
  /** A provider reads documents (読み取る・まとめて読み取る are shown). */
  enabled: boolean;
  /** The configured model, while enabled. */
  model: ReaderModel | null;
  /** A wrong setting, shown in the detail's 読み取り (the variable's name, never its value). */
  invalidReason: string | null;
}

export interface NtaStatus {
  /** 照合する is shown and readings look up the registration number. */
  enabled: boolean;
}

const globalForReader = globalThis as typeof globalThis & {
  __nihoFinanceReader?: ReaderProvider;
  __nihoFinanceNtaLookup?: NtaLookup;
};

export function readerStatus(): ReaderStatus {
  loadRootEnv();
  const config = readerConfig(process.env);
  if (config.status === "on") return { enabled: true, model: config.model, invalidReason: null };
  if (config.status === "invalid") {
    return { enabled: false, model: null, invalidReason: config.reason };
  }
  return { enabled: false, model: null, invalidReason: null };
}

/**
 * The provider, one per process (like the document storage); `null` when reading is off or
 * misconfigured. A recorded provider whose file cannot be read throws its `ReaderError`.
 */
export function getReader(): ReaderProvider | null {
  const cached = globalForReader.__nihoFinanceReader;
  if (cached) return cached;
  loadRootEnv();
  const reader = createReader(process.env);
  if (reader) globalForReader.__nihoFinanceReader = reader;
  return reader;
}

export function ntaStatus(): NtaStatus {
  loadRootEnv();
  return { enabled: ntaConfig(process.env).status === "on" };
}

/**
 * The registry lookup, one per process so that its 24-hour cache of answers and its interval
 * between requests hold across requests; `null` without the application ID.
 */
export function getNtaLookup(): NtaLookup | null {
  const cached = globalForReader.__nihoFinanceNtaLookup;
  if (cached) return cached;
  loadRootEnv();
  const lookup = createNtaLookupFromEnv(process.env);
  if (lookup) globalForReader.__nihoFinanceNtaLookup = lookup;
  return lookup;
}
