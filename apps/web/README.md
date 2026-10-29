# apps/web

NIHO finance の画面（Next.js App Router・Tailwind 4）。画面の仕様は [`docs/design/10-settings-and-setup.md`](../../docs/design/10-settings-and-setup.md)（S2）、[`docs/design/11-transactions.md`](../../docs/design/11-transactions.md)（S3）、[`docs/design/13-documents.md`](../../docs/design/13-documents.md)（S6）と [`docs/design/05-ui-ux.md`](../../docs/design/05-ui-ux.md)、見た目は [`docs/design/mock/v1.html`](../../docs/design/mock/v1.html) が正です。

## ルート

| パス | 内容 |
| --- | --- |
| `/` | ホーム。現預金（口座ごとの残高を含む）・やること・損益（`?pl=month / year` で今月と今期を切り替え。既定は今月。セグメント別の利益）・資金繰り（90 日）（[14 §9](../../docs/design/14-reports.md)） |
| `/setup` | 初期化ウィザード。`?step=company / fiscal-year / accounts / wallets / opening / done`。進捗は DB から導出し、`/setup` は続きのステップを開く |
| `/entries` | 取引（仕訳帳）。絞り込みは URL の `from` `to` `account` `partner` `segment` `tag` `status` `q` `page`（日付がなければ今期） |
| `/entries/new` | 取引の登録。`?type=income / expense / transfer / voucher`（既定は支出） |
| `/entries/[id]` | 取引の詳細（状態の帯・行・訂正・取消・履歴）。`?list=` に一覧の条件を持ち、戻るで絞り込みを保つ |
| `/entries/[id]/correct` | 訂正（伝票のフォームを元の仕訳で埋める）。取消済み・反対仕訳・決算済みの期は詳細へ戻す |
| `/documents` | 証憑（受信箱 / すべて / 無効）。保存（PC はドロップゾーン、スマホは撮影と選ぶ）・検索は URL の `tab` `from` `to` `amountMin` `amountMax` `partner` `kind` `q` `page`・索引簿の書き出し |
| `/documents/[id]` | 証憑の詳細（プレビュー・項目の直接編集・紐づけ・候補・無効化・差し替え・履歴・この証憑から取引を登録） |
| `/more` | スマホの「その他」（証憑・取引・明細の取込・期限・請求・給与・設定） |
| `/settings` | 設定の索引 |
| `/settings/company` | 事業所 |
| `/settings/fiscal-years` | 会計期間（次の期を作る・締め） |
| `/settings/audit-log` | 監査ログ（対象・期間で絞り込み、読むだけ） |
| `/settings/documents-policy` | 証憑の規程（施行日・責任者の保存、全文の表示と印刷） |
| `/settings/accounts` | 勘定科目（一覧の中で直接編集・補助科目はシート） |
| `/settings/tax-categories` | 税区分と税率規則（追加と有効 / 無効だけ） |
| `/settings/wallets` | 口座（追加・編集はシート） |
| `/settings/partners` | 取引先（検索・直接編集） |
| `/settings/segments` | セグメント |
| `/settings/memo-tags` | タグ |
| `/imports` | 明細の取込（取り込める口座と取込の履歴。Stripe はその場で同期） |
| `/imports/csv` | CSV の取込（ファイル → プレビュー → 取込）。`?wallet=` で口座を選んで開く |
| `/imports/<batchId>` | 取込の結果（新規 / 重複 / 失敗・失敗行・警告） |
| `/imports/wallets/<walletId>` | 取込の設定（CSV の取込形式と汎用の列対応、Stripe の接続） |
| `/settings/export` | 書き出しとバックアップ（freee・弥生・beancount・証憑一式・バックアップ・最近の書き出し） |
| `/settings/export/download` | 上の書き出し（GET の route handler。`kind=freee / yayoi / beancount / documents / backup`） |
| `/reports` | 報告。`/reports/trial-balance` へ redirect |
| `/reports/trial-balance` ・ `monthly` ・ `segments` ・ `cash` ・ `journal` ・ `ledger` | 試算表・月次推移・セグメント損益・現預金・仕訳帳・総勘定元帳。条件は検索パラメータ（`fy` `period` `from` `to` `segment`、仕訳帳は `status` `page`、総勘定元帳は `account` `sub`） |
| `/reports/export` | 報告の CSV / PDF（GET の route handler。`report` `format` と上の条件） |
| `/calendar` | 期限（会計期間ごとの一覧・完了にする / 未完了に戻す。[24](../../docs/design/24-calendar.md)） |
| `/api/documents/*` | 証憑の API（`prepare` / `complete` / `upload`〔ローカル保存の受け口〕/ `[id]/file` / `index.csv`。13 §7） |
| `/api/health` | 死活と DB の疎通、`service`（`web` / `jobs`）、`gitSha`、`iap`（IAP の署名ヘッダーの検証結果: `verified` / `missing` / `invalid` / `not-configured`。誰かは返さない） |
| `/api/jobs/backup` | POST。日次エクスポート（`backup-export`）。`NIHO_FINANCE_SERVICE=jobs` のときだけ動き、画面のサービスでは 404 |
| `/api/jobs/calendar` | POST。期限の暦の生成と通知メール（`calendar-notify`）。同上 |
| `/api/jobs/mail-check` | POST。「送信の確認」を 1 通送る（手動。`scripts/run-job.sh mail-check`）。同上 |
| `/api/jobs/stripe-sync` | Stripe の同期のジョブ（`POST` だけ。12-imports §4.4）。同上。同期の失敗でも 200 を返し、結果は `job.finished` のログに残る |

会社・第 1 期・勘定科目（ウィザードの 1〜3）がないとき、`/` と `/entries`・`/documents`・`/settings` 配下は `/setup` へ redirect します。

取引の画面（S3）は `app/(app)/entries/` にまとめています。フォーム（収入・支出 `simple-entry-form.tsx`、振替 `transfer-form.tsx`、伝票と訂正 `voucher-form.tsx`）は値を client で持ち、Server Action（`entries/actions.ts`）が `@niho-finance/db` の `postSimpleEntry` / `postVoucherEntry` / `correctJournalEntry` / `voidJournalEntryWithOpenDate` を呼びます。台帳のエラーは repository が項目名（`field`）を付けて返し、項目の下に出ます（項目に結べないものはフォームの上）。登録は Enter で送れ、「続けて登録」は種類と日付を残して金額・摘要・取引先を空にします。締めは会計期間の行の Sheet（`fiscal-years-table.tsx`）で、影響する件数を `previewFiscalYearCloseAction` で数えてから ConfirmDialog で確かめます。

証憑の画面（S6）は `app/(app)/documents/` にまとめています。保存は `lib/documents/upload-client.ts` が client で SHA-256 を計算し、`/api/documents/prepare`（同じファイルなら送らず既存を返す）→ 送信先へ `PUT` → `/api/documents/complete`（サーバーが大きさ・SHA-256・先頭バイトを確かめて登録）の順に 1 ファイルずつ進めます。`_components/uploader.tsx` は PC のドロップゾーンとスマホの「撮影」（`capture`）「選ぶ」を持ち、`link` を渡すと同じトランザクションで紐づけます（取引の詳細の「証憑を追加」が使う）。詳細の項目は設定の一覧と同じ直接編集（`useRowSave`）で、無効化・紐づけ・外すは Server Action（`documents/actions.ts`）が `@niho-finance/db` の `updateDocument` / `voidDocument` / `linkDocument` / `unlinkDocument` を呼びます。「この証憑から取引を登録」は `/entries/new?type=expense&date&amount&partner&document` を開き、支出 / 収入のフォームが初期値にして、登録後に証憑を紐づけます。設定 › 証憑の規程の文面の正は `lib/documents/policy.ts` です。

## 部品

- `components/ui/`: Button / ButtonLink、Input・Select（native）・Textarea・Checkbox・FormField（`form.tsx`）、Switch、Table（グリッド。行高 40px、768px 未満は 2 段）、Sheet と ConfirmDialog（native `<dialog>`）、Toast（`useToast()`）、EmptyState、PageHeader、MoneyInput。外部の UI ライブラリは使わず、`window.confirm` / `alert` も使わない。
- `components/settings/inline.tsx`: 一覧の中の直接編集（TextCell / SelectCell / CheckboxCell と `useRowSave`）。blur・Enter・変更で保存し、行の右端に「保存中 / 保存済み / エラー（理由）」を出す。Escape で保存済みの値に戻す。
- `components/app-shell/`: 左ナビ（PC。768〜1023px は細い列）と下タブ（スマホ）。群と並びの正は `nav-items.ts` で、10 §1 の表と単体テストで照合する。
- 色と字は `app/globals.css` のトークン（`bg-surface`、`text-muted`、`border-border` など）。
- `lib/mail/`: メール送信（`sendMail`。件名に `[NIHO finance] ` を前置、本文はプレーンテキスト）。`NIHO_FINANCE_MAIL=log` はログに出すだけ、`smtp` は送る。失敗は throw せず `{ ok: false, error }`。
- `lib/jobs/run.ts`: ジョブの共通入口（`runJob`）。`NIHO_FINANCE_SERVICE=jobs` 以外は 404、結果は `job.finished` の 1 行のログと 200 / 500（throw しない）。ジョブの書き込みの actor は `system`。

## Server Action の約束

- 読みは Server Components（`lib/data.ts` の `db()` は `connection()` で毎回描画にする）、書きは Server Actions（`app/(app)/settings/actions.ts`、`app/setup/actions.ts`）。
- 書き込みは必ず `@niho-finance/db` の repository を通す。入力は repository の Zod スキーマで検証され、監査ログに actor（`lib/actor.ts` の `actor()`）で残る。直接編集の action は行の編集できる項目だけを受け付ける（`inlinePatch`）。
- actor は IAP が付ける署名ヘッダー（`x-goog-iap-jwt-assertion`）を検証した email。`NIHO_FINANCE_ENV=prod` でヘッダーがない・検証に失敗したときは `ActorError` で書き込みを拒み、`{ ok: false, error }`（「ログイン情報を確認できませんでした…」）を返す。ローカル（IAP なし）は `NIHO_FINANCE_ACTOR`（既定 `owner@example.com` = seed の管理者。設定 › 利用者 に登録したメールでないと画面が開かない）。
- 結果は `{ ok: true, data } | { ok: false, error, fieldErrors }`（`lib/action-types.ts`）。想定内の失敗（入力・規則）は throw せず返す。`error` は「状態と戻り方」を書いた利用者向けの文。
- 書いたら `revalidatePath("/", "layout")`。ウィザードは保存してから次のステップへ redirect する。
- 金額は画面では文字列（`50,000` も `50000` も可）、サーバーで `bigint` にする。

## 報告と PDF

- 報告（[`docs/design/14-reports.md`](../../docs/design/14-reports.md)）は `@niho-finance/reports` の純粋関数で毎回導出します。`app/(app)/reports/_lib/` が検索パラメータの解釈・リンク・CSV の行、`_components/` が殻（条件のフォーム・タブ）・表・横棒・折れ線、`_pdf/` が各タブの PDF です。仕訳の詳細 `/entries/[id]` へのリンクは `_lib/links.ts` の `ENTRY_DETAIL_READY` で有効にします（S3 の merge 後）。
- 書き出し（`/reports/export`・`/settings/export/download`）は GET の route handler で、すべて監査ログに `export.download` を残します。ダウンロードのリンクは `next/link` でなく `<a>` にします（先読みで書き出しが記録されないように）。
- `lib/pdf/` は PDF の共通の基盤です。`registerFonts()`（Noto Sans JP 400 / 700。`fonts/README.md`）、`ReportDocument`（A4 の縦 / 横、上に会社名・題名・期間、下に出力日時と「n / N ページ」）、`PdfTable` / `PdfRow` / `PdfCell`、`renderPdf(element)` と `pdfResponse` / `csvResponse` / `zipResponse`（`download.ts`、ASCII と UTF-8 のファイル名）。決算書・請求書・給与の PDF もこれを使い、フォントを重ねて登録しません。日本語の改行は `font.ts` の `japaneseLineBreaks`（文字の間で改行し、ハイフンを足さず、簡単な禁則）。
