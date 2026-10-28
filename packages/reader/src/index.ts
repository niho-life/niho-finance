/**
 * @niho-finance/reader — reads receipts and invoices into proposals (20-reader): the provider,
 * the answer's schema and normalization, the validation layer and the costs. No database; the db
 * package stores what this returns.
 */
export {
  assertReadable,
  isReadableMime,
  MAX_IMAGE_BYTES,
  READABLE_MIMES,
  READER_ERROR_CODES,
  READER_ERROR_MESSAGES,
  ReaderError,
  type ProviderInput,
  type ProviderResult,
  type ProviderUsage,
  type ReadableMime,
  type ReaderErrorCode,
  type ReaderProvider,
} from "./provider";
export {
  DESCRIPTION_MAX_LENGTH,
  DOCUMENT_TYPE_GUESSES,
  fromStoredReading,
  inclusiveAmountOf,
  ISSUER_NAME_MAX_LENGTH,
  parseReading,
  READING_JSON_SCHEMA,
  READING_RATE_PERCENTS,
  toStoredReading,
  type DocumentTypeGuess,
  type Reading,
  type ReadingRate,
  type ReadingRatePercent,
  type StoredReading,
  type StoredReadingRate,
} from "./reading";
export {
  createAnthropicReader,
  READER_MAX_TOKENS,
  READER_SYSTEM_PROMPT,
  READER_TIMEOUT_MS,
} from "./anthropic";
export {
  createRecordedReader,
  loadRecordingFile,
  parseRecordingFile,
  type RecordedResponse,
  type RecordingFile,
} from "./recorded";
export {
  createReader,
  DEFAULT_READER_MODEL,
  defaultRecordingsPath,
  isReaderModel,
  READER_MODELS,
  readerConfig,
  type ReaderConfig,
  type ReaderModel,
} from "./config";
export {
  costNanoUsd,
  ESTIMATED_TOKENS_PER_DOCUMENT,
  estimatedCostPerDocumentNanoUsd,
  formatUsd,
  READER_PRICES,
  readingCostNanoUsd,
  type TokenPrice,
} from "./pricing";
export {
  READING_ISSUE_CODES,
  READING_TAX_TOLERANCE,
  READING_TOTAL_LIMIT,
  validateReading,
  type ReadingIssue,
  type ReadingIssueCode,
  type ReadingIssueField,
  type ReadingRegistry,
  type ReadingValidationContext,
} from "./validate";
export {
  estimatePurchaseTaxCategory,
  type EstimatedPurchaseTaxCategory,
  type RegistrationStatusAtDate,
} from "./tax-estimate";
export {
  compareWithExpected,
  normalizeIssuerName,
  sameRates,
  type ReadingComparison,
} from "./match";
