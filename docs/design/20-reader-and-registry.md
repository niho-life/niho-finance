# 20. 証憑の読み取りと登録番号の照合（v2 E の仕様）

Issue #18 の仕様。撮った領収書・受け取った請求書から 日付・合計・税率別の内訳・発行者・登録番号・但し書き を読み取って提案し、取引先の登録番号を国税庁の公表システム Web-API で照合する。前提は [04 §4・§5](04-integrations.md)、[03 §2.2・§2.4](03-compliance.md)、[05 §2.4](05-ui-ux.md)、[13 証憑](13-documents.md)（保存層・詳細・受信箱）、`packages/ledger/src/identifiers.ts`（登録番号と法人番号の検査）。

## 1. 方針と不変条件

- 読み取りは**提案だけ**。読み取りが書くのは `Document.extraction`（提案と検証の結果）と件数の記録だけで、証憑の項目（種別・取引年月日・金額・取引先・登録番号・メモ）も紐づけも仕訳も変えない。人が「提案を保存」したときに、選んだ項目だけを S6 の `updateDocument` で保存する。監査ログは読み取りが `document.read`、保存が `document.update` で別の行になる。
- 自動で仕訳を確定しない。取引の登録は今まで通り「この証憑から取引を登録」で人が行う。
- 読み取りの provider（鍵）がないときは、読み取りの操作（詳細の「読み取る」、受信箱の一括読み取り）を出さない。保存済みの提案は見える。ほかの機能は provider の有無に関わらず動く。
- 国税庁の照合はアプリケーション ID（オーナーが申請。審査あり）がないときは照合の操作を出さず、登録番号の形式と検査用数字の検査だけを行う（S2 から変わらない）。
- 外部へ送るのは証憑のファイル本体だけ。取引先マスタ・仕訳・他の証憑はプロンプトに入れない。国税庁へ送るのは登録番号だけ。
- 費用と回数は `external_api_usage` に 1 呼び出し 1 行で残す（§9）。金額の項目は円の整数、API の費用は 10⁻⁹ USD の整数（`cost_nano_usd`）で持ち、浮動小数を使わない。
- 監査ログの action: `document.read`（読み取り・失敗も含む）、`document.update`（提案の保存。S6 と同じ）、`partner.registry_check`（照合の結果）。

## 2. 読み取りの provider（`packages/reader`）

新しい workspace `@niho-finance/reader`。DB を持たない純粋な層と、外部 API のクライアントを持つ。

| ファイル | 内容 |
| --- | --- |
| `src/reading.ts` | 提案の型 `Reading`（§3）、JSON Schema `READING_JSON_SCHEMA`、応答の検査と正規化 `parseReading(raw)`（Zod） |
| `src/provider.ts` | `ReaderProvider` の型、読み取れる形式 `isReadableMime`、エラー `ReaderError` |
| `src/anthropic.ts` | Anthropic API の provider（`@anthropic-ai/sdk`） |
| `src/recorded.ts` | 記録済みの応答を返す provider（SHA-256 → 応答。テストと開発用） |
| `src/config.ts` | 環境変数から provider を選ぶ `readerConfig(env)` / `createReader(env)` |
| `src/pricing.ts` | モデルごとの単価と費用の計算 `costNanoUsd(model, usage)` |
| `src/validate.ts` | 検証層 `validateReading(reading, context)`（§4） |
| `src/tax-estimate.ts` | 登録状況から仕入の税区分を推定 `estimatePurchaseTaxCategory`（§6） |
| `src/match.ts` | 比較用の正規化（発行者名・税率別内訳）、ゴールドセットとの一致判定 |

### 2.1 型

```ts
interface ReaderProvider {
  readonly provider: "anthropic" | "recorded";
  readonly model: string;
  read(input: { bytes: Uint8Array; mime: string; sha256: string }): Promise<ProviderResult>;
}
interface ProviderResult {
  raw: unknown;                // JSON Schema に従う応答（未検査）
  usage: { inputTokens: number; outputTokens: number };
}
```

失敗は `ReaderError`（`code`: `unsupported_mime` / `too_large` / `refusal` / `truncated` / `invalid_output` / `api` / `not_configured` / `not_recorded`、利用者向けの `message`、課金された呼び出しなら `usage`）。拒否・切り詰め・形式違いも API は課金するので、`usage` を件数と費用に残す（§9）。`api` の文には鍵・URL・応答の本文を入れず、HTTP の状態コードだけを書く。

### 2.2 切替（環境変数）

| 変数 | 値 | 既定 |
| --- | --- | --- |
| `NIHO_FINANCE_READER_PROVIDER` | `anthropic` / `recorded` / `off` | `ANTHROPIC_API_KEY` があれば `anthropic`、なければ `off` |
| `NIHO_FINANCE_READER_MODEL` | `claude-haiku-5-5` / `claude-sonnet-5-5` | `claude-haiku-5-5`（軽量・安価）。精度が足りなければ `claude-sonnet-5-5` に切り替える |
| `ANTHROPIC_API_KEY` | Anthropic の API キー | なし。ローカルは `.env`、本番は Secret Manager から Cloud Run に結ぶ |
| `NIHO_FINANCE_READER_RECORDINGS` | `recorded` のときの記録ファイル（JSON）のパス | `packages/reader/fixtures/receipts/recorded.json` |

- 一覧にないモデル名は設定の誤りとして `off` 扱いにし、詳細の読み取り欄に「読み取りの設定が正しくありません（NIHO_FINANCE_READER_MODEL）」を出す。
- `recorded` は `NIHO_FINANCE_ENV=prod` では使わない（`off` 扱い）。開発でブラウザから流れを確かめるためのもの。
- provider はプロセスで 1 つ（S6 の保存層と同じ）。

### 2.3 Anthropic API の呼び方

- `client.messages.create`。`model` は §2.2、`max_tokens` 4096、`output_config: { effort: "medium", format: { type: "json_schema", schema: READING_JSON_SCHEMA } }`（構造化出力で JSON Schema に従わせる）。Haiku 5.5 の既定の effort は `medium` なので明示する。thinking は既定（adaptive）のまま。
- 入力: 画像（JPEG・PNG・WebP）は `image` ブロック（base64）、PDF は `document` ブロック（base64）、その後に指示の `text`。HEIC・CSV は読み取らない（`unsupported_mime`）。画像は 5 MB まで（API の上限。超えたら `too_large`「画像が大きすぎます。5 MB 以下にして撮り直すか、PDF にしてください」）。
- system は固定の指示（日本の領収書・適格請求書・適格簡易請求書の読み方。日付は取引日、合計は税込の支払額、税率ごとの対価は印字どおり税込か税抜かを `taxIncluded` で示す、読めない項目は null、推測で埋めない）。プロンプトに会社のデータを入れない。
- `stop_reason` が `refusal` なら `refusal`、`max_tokens` か `model_context_window_exceeded` なら `truncated`、それ以外で本文が JSON でなければ `invalid_output`。SDK の型つき例外（`Anthropic.APIError` の各派生。接続の失敗と時間切れは別の文）は `api` に、それ以外の SDK の例外（認証情報を解決できないなど）は `not_configured` に包む。タイムアウト 60 秒、再試行は SDK の既定（2 回）。SDK は `@anthropic-ai/sdk` 0.133.0（`output_config: { effort, format: { type: "json_schema", schema } }` を型定義で確かめた）。
- サーバー側の fallbacks（拒否時に別モデルで再実行）は付けない。領収書の読み取りで拒否はまれで、拒否されたら人が手で入れれば足りる（Haiku 5.5 にはサーバー側の fallbacks もない）。
- 費用の目安（2026-10 の単価）: Haiku 5.5 は入力 $0.10・出力 $0.50 / 100 万トークン。1 枚あたり入力 2 千・出力 1 千トークン程度で約 $0.0007（0.1 円）。Sonnet 5.5（$2 / $10）は約 $0.013（2 円）。月 100 枚なら Haiku 10 円・Sonnet 200 円程度で、月 300 円の予算（[06](06-architecture.md)）に収まる。

## 3. 提案の形（JSON Schema）

`READING_JSON_SCHEMA`（すべての object は `additionalProperties: false`、すべてのキーが `required`。null は `anyOf` で表す）。

| キー | 型 | 意味 |
| --- | --- | --- |
| `documentType` | `"receipt"` / `"invoice"` / `"other"` | 領収書・レシート / 請求書 / それ以外。種別の提案に使う（`receipt` → 領収書、`invoice` → 受領した請求書） |
| `legible` | boolean | 全体が読めたか。かすれ・切れ・ピンぼけで読めない部分があれば false |
| `issuerName` | string \| null | 発行者の名称（印字どおり） |
| `registrationNumber` | string \| null | 登録番号（印字どおり。T と 13 桁） |
| `transactionDate` | string(`date`) \| null | 取引年月日（YYYY-MM-DD）。請求書で取引日がなければ請求日 |
| `currency` | string | ISO 4217（`JPY` など） |
| `totalAmount` | integer \| null | 支払う合計（税込） |
| `rates` | array | 税率ごとの内訳。印字がなければ空 |
| `rates[].ratePercent` | `10` / `8` / `0` | 税率（8 は軽減税率） |
| `rates[].amount` | integer | その税率の対価の額（印字どおり） |
| `rates[].taxIncluded` | boolean | `amount` が税込か |
| `rates[].taxAmount` | integer \| null | その税率の消費税額（印字がなければ null） |
| `description` | string \| null | 但し書き・品目の要約（60 字まで） |

`parseReading(raw)` が Zod で検査し（負の金額・小数・安全な整数を超える金額は提案全体を `invalid_output` にする）、正規化する: 登録番号は `normalizeInvoiceRegistrationNumber`、発行者名と但し書きは前後の空白を除いて 200 字・60 字まで、日付は暦日として正しいものだけ（正しくなければ null にして検証で警告）、金額は 0 以上の整数（安全な整数の範囲）を `bigint` に。税率別の内訳には税込の額 `inclusiveAmount` を足す（税込ならそのまま、税抜なら `amount + taxAmount`、税額が null なら `exclusiveToInclusive`）。

## 4. 検証層（`validateReading`、純粋関数）

入力は正規化した `Reading` と `context`（今日、重複の候補、登録番号の照合結果）。出力は `ReadingIssue[]`（`code`・`severity`: `error` | `warning`・利用者向けの `message`・関わる項目 `field`）。1 件でもあれば「要確認」。

| code | 重さ | 条件 | 文 |
| --- | --- | --- | --- |
| `illegible` | warning | `legible` が false | 読めない部分があります。画像と見比べてください |
| `currency` | warning | `currency` が `JPY` 以外（「円」「¥」「YEN」は JPY として扱う） | 円以外の通貨です（USD）。金額は円にして入れてください（金額は提案せず、金額の検査 `total_*`・`rates_*`・`rate_tax` も出さない） |
| `date_missing` | warning | 日付がない・暦日でない | 取引年月日を読み取れませんでした |
| `date_future` | warning | 日付 > 今日 | 取引年月日が未来です（2062/11/07）。読み違いがないか確かめてください |
| `date_old` | warning | 日付 < 今日の 2 年前 | 取引年月日が 2 年以上前です。読み違いがないか確かめてください |
| `total_missing` | warning | 合計がない | 合計を読み取れませんでした |
| `total_range` | warning | 合計が 0 か 1 億円を超える | 合計が 0 円か、1 億円を超えています |
| `rates_missing` | warning | 合計があり、内訳が空 | 税率ごとの内訳がありません（適格請求書の記載事項） |
| `rates_sum` | warning | Σ 税込の額 ≠ 合計 | 税率ごとの内訳の合計（3,980 円）が合計（3,930 円）と合いません |
| `rate_tax` | warning | 税額が印字され、計算した額と 1 円を超えて違う（税込: `inclusiveTaxAmount`、税抜: `exclusiveTaxAmount`。端数処理の違いは 1 円まで許す） | 10% の消費税額（120 円）が対価から計算した額（100 円）と合いません |
| `registration_format` | error | 登録番号が T＋13 桁でない | 登録番号の形式が違います（T と 13 桁）。読み違いか、番号の誤りです |
| `registration_check_digit` | error | 検査用数字が合わない（`isValidInvoiceRegistrationNumber`） | 登録番号の検査用数字が合いません。読み違いか、番号の誤りです |
| `registration_not_found` | warning | 照合で見つからない | 国税庁の公表サイトにこの登録番号がありません |
| `registration_inactive` | warning | 取引年月日に登録されていない（登録前・失効後・取消後） | 取引年月日（2026/11/07）にはこの番号は登録されていません（登録 2027/04/01）。日付がなければ「この番号は登録されていません（取消 2025/03/31）」 |
| `duplicate` | warning | 同じ発行者（登録番号か名前の一致）・日付・合計の証憑が他にある（無効を除く） | 同じ発行者・日付・金額の証憑があります（receipt-1107.jpg） |

- `error` の項目は「提案を保存」で選べない（`updateDocument` が拒否するものを出さない）。
- 照合の結果がない（アプリケーション ID がない・失敗した）ときは `registration_*` の照合系は出さず、形式と検査用数字だけを検査する。照合の失敗そのものは提案の欄に「国税庁の照合はできませんでした（理由）」と出す（要確認にはしない）。
- 重複の候補は DB 層が探す（§7 `findReadingDuplicates`）: 取引年月日と金額が同じで、登録番号が同じか、取引先名（マスタの名前・自由入力）の正規化（空白・全角半角・法人格の除去）が一致する、無効でない他の証憑。保存済みの項目に加えて、他の証憑の読み取り結果（日付・合計・円・発行者・登録番号）とも照らす（保存する前の受信箱で同じ領収書を 2 回撮ったものを拾うため）。

## 5. 提案の保存までの流れ

1. 詳細の「読み取る」→ Server Action `readDocumentAction(id)` → `apps/web/lib/reader/read-document.ts` の `readDocument(id)`:
   - 証憑を読み込む（無効は拒否、形式が読めないものは拒否）→ 保存層 `read(storageKey)` → `provider.read` → `parseReading` → 照合（§8。アプリケーション ID があり、登録番号が正しい形式なら。取引年月日の登録状況）→ 重複の候補 → `validateReading` → `recordDocumentReading`。
   - 失敗（API・拒否・形式）も `recordDocumentReading` に `status: "failed"` で残す（費用が発生しうるため件数に数え、一括読み取りで同じ証憑を何度も読まない）。
2. `recordDocumentReading(db, { documentId, extraction, usage }, { actor })`（1 トランザクション）: `document.extraction` を書き、`external_api_usage` に 1 行、監査ログ `document.read`（after: provider・model・状態・提案の要約・検証の code の一覧）。証憑の他の列は変えない。
3. 詳細は提案の欄を出す（§10.1）。項目ごとにチェックがあり、既定は「今の値が空で、提案があり、error がない項目」。今の値と違う提案はチェックなしで並べて見せる。
4. 「提案を保存」→ `applyDocumentReadingAction(id, fields)` → `applyDocumentReading(db, { documentId, fields }, { actor })`: DB の `extraction` から（クライアントの値は使わない）選んだ項目の値を作り、同じトランザクションで `updateDocument` を呼ぶ（`document.update`）。取引先は §5.1 で決める。提案がない・`error` の項目・無効の証憑は拒否。
5. すべての提案が今の値と同じなら欄に「提案はすべて保存済みです」。読み取り直すと `extraction` は上書きされ（前の提案は `document.read` の監査ログに残る）、また 3 から。

### 5.1 取引先の当てはめ

提案の発行者を取引先マスタに当てる（`matchReadingPartner`）: ① 登録番号が同じ有効な取引先、② 名前（正規化）が同じ有効な取引先、③ なければ自由入力の取引先名（発行者名）。①② は「取引先: 架空クラウド株式会社（登録番号が一致）」のように理由を添える。

### 5.2 但し書き

`description` は証憑のメモに提案する（メモが空のときだけ既定でチェック）。

## 6. 取引日時点の登録状況と経過措置への接続

- 照合の結果は「取引日時点の登録状況」として扱う: 公表情報の登録年月日 ≤ 取引年月日 < 失効年月日・取消年月日 なら `registered`、それ以外（登録前・失効後・取消後・見つからない）は `not_registered`、照合していなければ `unknown`。
- 証憑: 読み取りのときの照合結果（番号・公表名・登録年月日・失効/取消年月日・取引年月日時点の状況・照合日時）を `extraction.registry` に保存する。
- 取引先: 照合の結果を列に保存する（§8.2）。`partnerRegistrationAt(partner, date)` が任意の取引日の状況を返す。
- 推定: `estimatePurchaseTaxCategory(ratePercent, status)` が、`registered` なら `purchase_10` / `purchase_8r`、`not_registered` なら `purchase_10_ni` / `purchase_8r_ni`（経過措置。控除割合は `TaxRateRule` が取引日で決める: 2026-10-01〜2028-09-30 は 70%）、`unknown` か税率 0 なら推定しない。提案の欄の税率別の内訳に「推定の税区分」として出す（例「課税仕入 10%（インボイスなし・控除 70%）」）。帳簿のみで控除できる特例（3 万円未満の公共交通機関など、[03 §2.4](03-compliance.md)）は推定しない。
- 取引の登録フォーム（S3）と明細の推定（S5）への接続は §13 の引き継ぎ。

## 7. DB 層

### 7.1 schema（列の追加とテーブル 1 つ）

- `partner`: `invoice_registration_name text?`（公表名）、`invoice_registered_on date?`（登録年月日）、`invoice_registration_ended_on date?`（失効年月日・取消年月日の早い方）。既存の `invoice_registration_status`（`unknown` / `verified` 登録あり / `not_found` 未登録 / `revoked` 失効・取消）と `invoice_registration_checked_at` と合わせて使う。番号が変わると S2 の `updatePartner` が状態を `unknown` に戻すので、`unknown` のとき 3 列は読まない（古い値が残っても使わない）。
- `external_api_usage`（新規。追記のみ。`audit_log` と同じく UPDATE / DELETE / TRUNCATE をトリガで拒否し、service・outcome の値と数の非負を CHECK）: `id`、`at`、`service`（`reader` | `registry`）、`provider`（`anthropic` / `recorded` / `nta` / `fixture`）、`model?`、`document_id?`（FK → document）、`outcome`（`ok` / `failed`）、`error?`、`request_count`（既定 1）、`item_count`（照合した番号の数など）、`input_tokens`、`output_tokens`、`cost_nano_usd bigint`、`actor`。索引は `(service, at)`。
- `document.extraction`（既存の JSON 列）の形（version 1）:

```ts
{
  version: 1,
  status: "proposed" | "failed",
  readAt: string,              // ISO 8601
  provider: string, model: string,
  reading: StoredReading | null,   // §3 を JSON にしたもの（金額は 10 進の文字列）
  issues: ReadingIssue[],
  registry: StoredRegistry | null, // §6。found: false は公表されていない番号
  registryError: string | null,
  error: string | null,            // status = failed のとき
}
```

### 7.2 `packages/db/src/reading.ts`

| 関数 | 内容 |
| --- | --- |
| `performDocumentReading(db, { reader, readFile, registry, today }, { documentId }, { actor })` | §5.1 の一連。外部の呼び出しはトランザクションの外 |
| `recordDocumentReading(db, input, { actor })` | §5.2。無効の証憑は拒否。失敗した読み取りも reader の行を 1 行残す（トークン 0 でも） |
| `getDocumentReading(db, documentId)` | `extraction` を検査して型つきで返す（形が古い・壊れていれば `null`） |
| `applyDocumentReading(db, { documentId, fields }, { actor })` | §5.4 |
| `buildReadingProposal(db, documentId)` | 詳細の提案の欄の行（項目・提案値・今の値・既定のチェック・選べるか・取引先の当てはめ）、税率別の内訳と推定、推定に使った登録状況 `registrationStatus` |
| `findReadingDuplicates(db, { documentId, txnDate, amount, registrationNumber, issuerName })` | §4 の重複の候補 |
| `listUnreadInboxDocuments(db, { limit })` | 受信箱のうち、読める形式で `extraction` がない証憑（保存日時の古い順） |
| `countUnreadInboxDocuments(db)` | 同じ条件の件数 |
| `loadReadingStates(db, ids)` | 一覧の状態の欄の「提案あり / 要確認 / 読み取れず」 |
| `summarizeApiUsage(db, { service, from, to })` | 件数・成功・失敗・トークン・費用の合計（`from <= at < to`。`api-usage.ts`） |
| `recordApiUsage(db, row)` | 1 行足す（照合のジョブも使う。`api-usage.ts`） |

### 7.3 `packages/db/src/registry-check.ts`

| 関数 | 内容 |
| --- | --- |
| `checkPartnerRegistrations(db, lookup, { actor, partnerIds?, now? })` | 有効で、正しい形式の登録番号を持つ取引先（`partnerIds` があればそれだけ）を 10 件ずつ照合し、5 列を更新する。変わった取引先だけ `partner.registry_check`（before / after: 状態・公表名・登録年月日・終了日・照合日時）。照合日時だけ変わる取引先は、監査ログを 1 回分にまとめる（entity `partner`・entityId なし・after に件数）。`external_api_usage` に要求の回数と番号の数。戻り値は件数の内訳と失敗 |
| `partnerRegistrationAt(partner, date)` | §6 |
| `registrationStatusLabel(partner)` | 「登録あり（2023/10/01〜）」（終了日が先にあれば「〜2026/12/31」まで）「未登録」「登録終了（2025/03/31）」「未照合」。取引先は失効と取消を区別する列を持たないので「登録終了」とする |

`lookup` は §8 のクライアント（テストはフィクスチャ）。照合の間に登録番号が変わった・無効にされた取引先は、結果がその取引先のものではないので書き換えない。

## 8. 国税庁 Web-API（`packages/importers/src/nta/`）

### 8.1 呼び方

- 登録番号指定: `GET https://web-api.invoice-kohyo.nta.go.jp/1/num?id=<アプリケーション ID>&number=T…,T…&type=21&history=1`。1 回に最大 10 件（カンマ区切り）。`type=21` は JSON、`history=1` で登録・失効・取消の履歴も返る（取引日時点の状況を手元で判定できるので、日付指定の `/1/valid` は使わない）。
- 応答（リソース定義書 1.5 版）: ヘッダ `lastUpdateDate`・`count`・`divideNumber`・`divideSize`、明細 `announcement[]` の `sequenceNumber`・`registratedNumber`・`process`（01 新規 / 02 変更 / 03 失効 / 04 取消）・`kind`（1 個人 / 2 法人）・`latest`（1 最新）・`registrationDate`・`updateDate`・`disposalDate`（取消年月日）・`expireDate`（失効年月日）・`name`・`kana`・`tradeName` ほか。値はすべて文字列、空は `""`。見つからない番号は `announcement` に出ない。
- `parseNtaResponse(json)` → 番号ごとの `NtaRegistration { number, name, kind, registeredOn, endedOn, endReason: "expired" | "revoked" | null, lastUpdateDate }`（履歴のうち `latest = "1"` を正とし、失効・取消の年月日は履歴全体から最も新しいもの。終了日が最新の登録日より前なら登録し直したものとして終了なし）。`statusAt(registration | null, date)` が §6 の判定。
- `createNtaClient({ applicationId, fetch?, minIntervalMs = 1000, cacheTtlMs = 24h, now? })` → `lookup(numbers)`: 重複を除き、正しい形式の番号だけを 10 件ずつ順に要求する。要求の間は 1 秒以上空ける（数値のレート制限は公表されていないため低頻度にする）。結果は番号ごとにプロセス内で 24 時間キャッシュする。戻り値は `{ registrations: Map<number, NtaRegistration | null>, requestCount, failures }`。
- 失敗: 2xx 以外・JSON でない・ネットワークの失敗は `NtaApiError`（利用者向けの文「国税庁の公表サイトに接続できませんでした（HTTP 503）」。URL にアプリケーション ID が入るので、文にもログにも URL を出さない）。その 10 件は `failures` に入れ、続きは要求する。再試行はしない（月次のジョブがまた回る）。
- `createFixtureNtaLookup(registrations)`: 架空の公表情報で答える（テストと開発用。`NIHO_FINANCE_NTA_MODE=fixture`、本番では使わない）。

### 8.2 設定

| 変数 | 内容 |
| --- | --- |
| `NIHO_FINANCE_NTA_APPLICATION_ID` | アプリケーション ID（13 桁）。ローカルは `.env`、本番は Secret Manager から結ぶ。なければ照合の操作を出さない |
| `NIHO_FINANCE_NTA_MODE` | `fixture` で架空の公表情報を使う（`NIHO_FINANCE_ENV=prod` では無視。開発で ID と両方あるときは fixture が優先） |

- 利用規約: アプリケーション ID の届出が要る。公表情報の保存（自社の取引先の状況と日付だけを持つ）は [04 §9](04-integrations.md) の要確認に残す。

## 9. 件数と費用

- 読み取り 1 回 = `external_api_usage` 1 行（`service = reader`。トークンと `cost_nano_usd`）。照合はクライアントの 1 回の `lookup` = 1 行（`service = registry`、`request_count` = 要求の回数、`item_count` = 番号の数、費用 0）。
- 単価（`pricing.ts`、10⁻⁹ USD / トークン）: `claude-haiku-5-5` 入力 100・出力 500、`claude-sonnet-5-5` 入力 2,000・出力 10,000。単価が変わったら表を直す（記録済みの行は当時の費用のまま）。
- 画面: 証憑の一覧（受信箱）の一括読み取りの行に「今月の読み取り 12 件 · 約 $0.01」（muted）。取引先の照合の行に「最後の照合 2026/11/01」。

## 10. 画面

### 10.1 詳細 `/documents/[id]` の「読み取り」

右の列の「項目」の上に節「読み取り」を足す（S6 の詳細への追記）。

| 状態 | 出すもの |
| --- | --- |
| provider なし・提案なし | 何も出さない |
| 読めない形式（CSV・HEIC） | provider があるときだけ「この形式は読み取れません（画像は JPEG・PNG・WebP、または PDF）」 |
| 提案なし | 「日付・金額・発行者・登録番号を読み取り、提案として入れます」と「読み取る」（secondary・sm） |
| 読み取り中 | ボタンが「読み取り中…」で押せない |
| 失敗 | 「読み取れませんでした（理由）」と「読み取り直す」 |
| 提案あり | §下の表、要確認の一覧、「提案を保存」（primary・sm。チェックが 0 なら押せない）と「読み取り直す」（ghost・sm。provider があるときだけ） |
| 無効の証憑 | 提案があれば読み取り専用で出す（操作なし） |

- 見出しの右に「2026/11/07 10:15 · claude-haiku-5-5」（muted）。
- 提案の表（PC は 3 列、スマホは 2 段）: [チェック] 項目名 · 提案値 · 今の値（違うときだけ「今: …」muted）。項目: 種別・取引年月日・金額（円）・取引先・登録番号・メモ。
- 税率別の内訳（読み取り専用）: 税率 · 対価（税込） · 消費税 · 推定の税区分。
- 登録番号の照合: 「登録あり · 架空クラウド株式会社 · 2023/10/01〜」「取引年月日には未登録（経過措置: インボイスなし 70%）」「照合していません（アプリケーション ID の設定後）」。
- 要確認: 警告ごとに 1 行（`text-danger`。赤は警告だけ）。
- 保存したらトースト「提案を保存しました」、項目の欄は保存した値で描き直す。

### 10.2 受信箱の一括読み取り `/documents`

- 受信箱のタブで、provider があり、読み取っていない証憑が 1 件以上あるとき、アップロードの下に 1 行: 「読み取っていない証憑 n 件」と「まとめて読み取る」（secondary・sm）。押すと ConfirmDialog「n 件を読み取ります（1 件あたり約 0.1 円）」（モデルの単価から）→ client が 1 件ずつ `readDocumentAction` を呼び、行に「読み取り中 3 / 12」と「止める」。1 回に 20 件まで（費用と待ち時間の上限）。終わったらトースト「12 件を読み取りました（要確認 3 件）」と一覧の更新。
- 一覧の状態の欄（S6 の `statusText`）の後ろに「· 提案あり」「· 要確認」「· 読み取れず」を足す（`DocumentsTable` に任意の `readingStates` を渡す追記。既定の挙動は変えない）。
- その下に「今月の読み取り n 件 · 約 $x」（muted）。

### 10.3 設定 › 取引先 `/settings/partners`

- 列「照合」を 登録番号 の右に足す（PC）。値は `registrationStatusLabel` と照合日（muted・小）。スマホは Sheet に「照合」の行。
- 検索フォームの右に「照合する」（secondary・sm。アプリケーション ID があるときだけ）→ 有効な取引先の正しい登録番号をすべて照合（ConfirmDialog「n 件の登録番号を国税庁の公表サイトで照合します」）。トースト「12 件を照合しました（登録あり 10 · 未登録 1 · 登録終了 1）」、失敗があれば「1 件は照合できませんでした（理由）」。
- 表の下の注記: アプリケーション ID があるとき「登録番号は形式と検査用数字を確かめ、国税庁の公表サイトで照合します（毎月 1 日に再照合）」、ないとき「登録番号は形式と検査用数字を確かめます。国税庁の公表サイトとの照合は、アプリケーション ID を設定すると使えます」。

## 11. 月次の再照合ジョブ `POST /api/jobs/registry-check`

- [06](06-architecture.md) の `invoice-registry-verify`。認証は S4 の `verifyJobRequest`（Cloud Scheduler の OIDC。ローカルは `NIHO_FINANCE_JOB_TOKEN`）。Cloud Scheduler は毎月 1 日 06:30 JST（S8 が作る）。
- `checkPartnerRegistrations`（全件）を actor = ジョブの principal で回し、200 で `{ ok: true, checked, registered, notRegistered, ended, failed, errors }`。アプリケーション ID がなければ 200 で `{ ok: false, error: "国税庁の照合が設定されていません" }`。照合の失敗も 200（再試行の嵐を避ける。12 §5 と同じ）。認証の失敗は 401 / 403 / 503。`GET` は 405。
- ハンドラ本体は `apps/web/lib/registry/job.ts`（依存を注入してテストする。`lib/jobs/stripe-sync.ts` と同じ形）。

## 12. テスト

- `packages/reader`（単体）:
  - ゴールドセット: 架空の領収書 10 枚（`fixtures/receipts/r01`〜`r10`。画像 7 枚・PDF 3 枚。発行者・登録番号はすべて架空で、登録番号は 9 の並びを基にした検査用数字の正しい番号）と正解 `expected.json`、記録済みの応答 `recorded.json`。日付・合計・税率別の内訳が 8 枚以上一致し、一致しない分はすべて `validateReading` が警告を出すこと。
  - 記録済みの応答は、鍵が入るまでは正解に 2 枚の読み違い（合計の数字の読み違い・8% の内訳の読み違い）を加えて作った合成のもの。鍵が入ったら `npm -w @niho-finance/reader run record` が実 API で `recorded.json` を取り直し、`npm -w @niho-finance/reader run eval` がモデルごとの一致率を出す（Haiku で 8 枚に届かなければ Sonnet に切り替える判断に使う）。
  - `parseReading`（null・型違い・不正な日付・負の金額・大きすぎる金額）、`validateReading` の各 code、`estimatePurchaseTaxCategory`、`costNanoUsd`、`readerConfig`（鍵なし → off、prod で recorded → off、未知のモデル → 設定の誤り）、Anthropic provider の要求の形（SDK をモックしてブロックの種類・`output_config`・拒否・切り詰め・形式違い）。
- `packages/importers`（単体）: `parseNtaResponse`（新規・失効・取消・履歴・見つからない）、`statusAt` の境界（登録日当日・失効日当日）、`createNtaClient` の 10 件ずつの分割・間隔・キャッシュ・失敗の扱い・URL の形（fetch をモック）。
- `packages/db`（`reading.db.test.ts`・`registry-check.db.test.ts`）: 読み取りが項目を変えず `document.read` だけを残すこと、保存で `document.update` が別に残り選んだ項目だけ変わること、error の項目と無効の証憑の拒否、取引先の当てはめ、重複の候補、未読の受信箱、件数の記録、照合で 5 列と監査ログ、検査用数字の誤りの番号は照合しないこと、取引日時点の状況。
- `apps/web`（単体）: ジョブのハンドラ（認証の失敗・未設定・成功・失敗でも 200）。

## 13. 他レーンに渡すもの

- S8（#9）: Secret Manager に `ANTHROPIC_API_KEY` と `NIHO_FINANCE_NTA_APPLICATION_ID` を作り Cloud Run に結ぶ。Cloud Scheduler `registry-check`（毎月 1 日 06:30 JST、OIDC、`POST /api/jobs/registry-check`）。
- S5（#6）の推定: 取引先の既定の税区分が `purchase_10` / `purchase_8r` で、`partnerRegistrationAt(partner, 取引日)` が `not_registered` なら `_ni` に置き換えると経過措置の税区分になる。`suggest.ts` は S5 の所有なので、#6 にコメントで頼む。
- S3（#4）の取引の登録: 「この証憑から取引を登録」に推定の税区分を渡す引数（`tax=`）を足す場合は S3 のフォームへの追記として頼む。

## 14. 受け入れ条件

Issue #18 の条件に加えて:

- `npm run check`・`test:db`・`next build` が通る。
- 1280px と 320px で、詳細の読み取りの欄・受信箱の一括読み取り・取引先の照合の列が操作でき、横スクロールが出ない。
- 鍵もアプリケーション ID もない状態で、詳細・受信箱・取引先に読み取りと照合の操作が出ず、アップロード・紐づけ・項目の変更が今まで通り動く。
