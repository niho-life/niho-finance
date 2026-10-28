# apps/web

NIHO finance の画面（Next.js App Router・Tailwind 4）。画面の仕様は [`docs/design/10-settings-and-setup.md`](../../docs/design/10-settings-and-setup.md)（S2）、[`docs/design/11-transactions.md`](../../docs/design/11-transactions.md)（S3）と [`docs/design/05-ui-ux.md`](../../docs/design/05-ui-ux.md)、見た目は [`docs/design/mock/v1.html`](../../docs/design/mock/v1.html) が正です。

## ルート

| パス | 内容 |
| --- | --- |
| `/` | ホーム。現預金と口座・今月と今期の損益（セグメント別の利益）・やること（[14 §9](../../docs/design/14-reports.md)） |
| `/setup` | 初期化ウィザード。`?step=company / fiscal-year / accounts / wallets / opening / done`。進捗は DB から導出し、`/setup` は続きのステップを開く |
| `/entries` | 取引（仕訳帳）。絞り込みは URL の `from` `to` `account` `partner` `segment` `tag` `status` `q` `page`（日付がなければ今期） |
| `/entries/new` | 取引の登録。`?type=income / expense / transfer / voucher`（既定は支出） |
| `/entries/[id]` | 取引の詳細（状態の帯・行・訂正・取消・履歴）。`?list=` に一覧の条件を持ち、戻るで絞り込みを保つ |
| `/entries/[id]/correct` | 訂正（伝票のフォームを元の仕訳で埋める）。取消済み・反対仕訳・決算済みの期は詳細へ戻す |
| `/more` | スマホの「その他」（取引・設定） |
| `/settings` | 設定の索引 |
| `/settings/company` | 事業所 |
| `/settings/fiscal-years` | 会計期間（次の期を作る・締め） |
| `/settings/audit-log` | 監査ログ（対象・期間で絞り込み、読むだけ） |
| `/settings/accounts` | 勘定科目（一覧の中で直接編集・補助科目はシート） |
| `/settings/tax-categories` | 税区分と税率規則（追加と有効 / 無効だけ） |
| `/settings/wallets` | 口座（追加・編集はシート） |
| `/settings/partners` | 取引先（検索・直接編集） |
| `/settings/segments` | セグメント |
| `/settings/memo-tags` | タグ |
| `/settings/export` | 書き出しとバックアップ（freee・弥生・beancount・証憑一式・バックアップ・最近の書き出し） |
| `/settings/export/download` | 上の書き出し（GET の route handler。`kind=freee / yayoi / beancount / documents / backup`） |
| `/reports` | 報告。`/reports/trial-balance` へ redirect |
| `/reports/trial-balance` ・ `monthly` ・ `segments` ・ `cash` ・ `journal` ・ `ledger` | 試算表・月次推移・セグメント損益・現預金・仕訳帳・総勘定元帳。条件は検索パラメータ（`fy` `period` `from` `to` `segment`、仕訳帳は `status` `page`、総勘定元帳は `account` `sub`） |
| `/reports/export` | 報告の CSV / PDF（GET の route handler。`report` `format` と上の条件） |
| `/api/health` | 死活と DB の疎通 |

会社・第 1 期・勘定科目（ウィザードの 1〜3）がないとき、`/` と `/entries`・`/settings` 配下は `/setup` へ redirect します。

取引の画面（S3）は `app/(app)/entries/` にまとめています。フォーム（収入・支出 `simple-entry-form.tsx`、振替 `transfer-form.tsx`、伝票と訂正 `voucher-form.tsx`）は値を client で持ち、Server Action（`entries/actions.ts`）が `@niho-finance/db` の `postSimpleEntry` / `postVoucherEntry` / `correctJournalEntry` / `voidJournalEntryWithOpenDate` を呼びます。台帳のエラーは repository が項目名（`field`）を付けて返し、項目の下に出ます（項目に結べないものはフォームの上）。登録は Enter で送れ、「続けて登録」は種類と日付を残して金額・摘要・取引先を空にします。締めは会計期間の行の Sheet（`fiscal-years-table.tsx`）で、影響する件数を `previewFiscalYearCloseAction` で数えてから ConfirmDialog で確かめます。

## 部品

- `components/ui/`: Button / ButtonLink、Input・Select（native）・Textarea・Checkbox・FormField（`form.tsx`）、Switch、Table（グリッド。行高 40px、768px 未満は 2 段）、Sheet と ConfirmDialog（native `<dialog>`）、Toast（`useToast()`）、EmptyState、PageHeader、MoneyInput。外部の UI ライブラリは使わず、`window.confirm` / `alert` も使わない。
- `components/settings/inline.tsx`: 一覧の中の直接編集（TextCell / SelectCell / CheckboxCell と `useRowSave`）。blur・Enter・変更で保存し、行の右端に「保存中 / 保存済み / エラー（理由）」を出す。Escape で保存済みの値に戻す。
- `components/app-shell/`: 左ナビ（PC）と下タブ（スマホ）。準備中の項目は muted の非リンク。
- 色と字は `app/globals.css` のトークン（`bg-surface`、`text-muted`、`border-border` など）。

## Server Action の約束

- 読みは Server Components（`lib/data.ts` の `db()` は `connection()` で毎回描画にする）、書きは Server Actions（`app/(app)/settings/actions.ts`、`app/setup/actions.ts`）。
- 書き込みは必ず `@niho-finance/db` の repository を通す。入力は repository の Zod スキーマで検証され、監査ログに `NIHO_FINANCE_ACTOR`（既定 `owner`）で残る。直接編集の action は行の編集できる項目だけを受け付ける（`inlinePatch`）。
- 結果は `{ ok: true, data } | { ok: false, error, fieldErrors }`（`lib/action-types.ts`）。想定内の失敗（入力・規則）は throw せず返す。`error` は「状態と戻り方」を書いた利用者向けの文。
- 書いたら `revalidatePath("/", "layout")`。ウィザードは保存してから次のステップへ redirect する。
- 金額は画面では文字列（`50,000` も `50000` も可）、サーバーで `bigint` にする。

## 報告と PDF

- 報告（[`docs/design/14-reports.md`](../../docs/design/14-reports.md)）は `@niho-finance/reports` の純粋関数で毎回導出します。`app/(app)/reports/_lib/` が検索パラメータの解釈・リンク・CSV の行、`_components/` が殻（条件のフォーム・タブ）・表・横棒・折れ線、`_pdf/` が各タブの PDF です。仕訳の詳細 `/entries/[id]` へのリンクは `_lib/links.ts` の `ENTRY_DETAIL_READY` で有効にします（S3 の merge 後）。
- 書き出し（`/reports/export`・`/settings/export/download`）は GET の route handler で、すべて監査ログに `export.download` を残します。ダウンロードのリンクは `next/link` でなく `<a>` にします（先読みで書き出しが記録されないように）。
- `lib/pdf/` は PDF の共通の基盤です。`registerFonts()`（Noto Sans JP 400 / 700。`fonts/README.md`）、`ReportDocument`（A4 の縦 / 横、上に会社名・題名・期間、下に出力日時と「n / N ページ」）、`PdfTable` / `PdfRow` / `PdfCell`、`renderPdf(element)` と `pdfResponse` / `csvResponse` / `zipResponse`（`download.ts`、ASCII と UTF-8 のファイル名）。決算書・請求書・給与の PDF もこれを使い、フォントを重ねて登録しません。日本語の改行は `font.ts` の `japaneseLineBreaks`（文字の間で改行し、ハイフンを足さず、簡単な禁則）。
