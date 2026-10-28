# apps/web

NIHO finance の画面（Next.js App Router・Tailwind 4）。画面の仕様は [`docs/design/10-settings-and-setup.md`](../../docs/design/10-settings-and-setup.md)（S2）、[`docs/design/11-transactions.md`](../../docs/design/11-transactions.md)（S3）と [`docs/design/05-ui-ux.md`](../../docs/design/05-ui-ux.md)、見た目は [`docs/design/mock/v1.html`](../../docs/design/mock/v1.html) が正です。

## ルート

| パス | 内容 |
| --- | --- |
| `/` | ホーム（S7 まで仮置き）。会社名・第 n 期・現預金の合計・やること |
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
| `/api/health` | 死活と DB の疎通、`service`（`web` / `jobs`）、`gitSha`、`iap`（IAP の署名ヘッダーの検証結果: `verified` / `missing` / `invalid` / `not-configured`。誰かは返さない） |
| `/api/jobs/backup` | POST。日次エクスポート（`backup-export`）。`NIHO_FINANCE_SERVICE=jobs` のときだけ動き、画面のサービスでは 404 |
| `/api/jobs/calendar` | POST。期限の暦の生成と通知メール（`calendar-notify`）。同上 |
| `/api/jobs/mail-check` | POST。「送信の確認」を 1 通送る（手動。`scripts/run-job.sh mail-check`）。同上 |

会社・第 1 期・勘定科目（ウィザードの 1〜3）がないとき、`/` と `/entries`・`/settings` 配下は `/setup` へ redirect します。

取引の画面（S3）は `app/(app)/entries/` にまとめています。フォーム（収入・支出 `simple-entry-form.tsx`、振替 `transfer-form.tsx`、伝票と訂正 `voucher-form.tsx`）は値を client で持ち、Server Action（`entries/actions.ts`）が `@niho-finance/db` の `postSimpleEntry` / `postVoucherEntry` / `correctJournalEntry` / `voidJournalEntryWithOpenDate` を呼びます。台帳のエラーは repository が項目名（`field`）を付けて返し、項目の下に出ます（項目に結べないものはフォームの上）。登録は Enter で送れ、「続けて登録」は種類と日付を残して金額・摘要・取引先を空にします。締めは会計期間の行の Sheet（`fiscal-years-table.tsx`）で、影響する件数を `previewFiscalYearCloseAction` で数えてから ConfirmDialog で確かめます。

## 部品

- `components/ui/`: Button / ButtonLink、Input・Select（native）・Textarea・Checkbox・FormField（`form.tsx`）、Switch、Table（グリッド。行高 40px、768px 未満は 2 段）、Sheet と ConfirmDialog（native `<dialog>`）、Toast（`useToast()`）、EmptyState、PageHeader、MoneyInput。外部の UI ライブラリは使わず、`window.confirm` / `alert` も使わない。
- `components/settings/inline.tsx`: 一覧の中の直接編集（TextCell / SelectCell / CheckboxCell と `useRowSave`）。blur・Enter・変更で保存し、行の右端に「保存中 / 保存済み / エラー（理由）」を出す。Escape で保存済みの値に戻す。
- `components/app-shell/`: 左ナビ（PC）と下タブ（スマホ）。準備中の項目は muted の非リンク。
- 色と字は `app/globals.css` のトークン（`bg-surface`、`text-muted`、`border-border` など）。
- `lib/mail/`: メール送信（`sendMail`。件名に `[NIHO finance] ` を前置、本文はプレーンテキスト）。`NIHO_FINANCE_MAIL=log` はログに出すだけ、`smtp` は送る。失敗は throw せず `{ ok: false, error }`。
- `lib/jobs/run.ts`: ジョブの共通入口（`runJob`）。`NIHO_FINANCE_SERVICE=jobs` 以外は 404、結果は `job.finished` の 1 行のログと 200 / 500（throw しない）。ジョブの書き込みの actor は `system`。

## Server Action の約束

- 読みは Server Components（`lib/data.ts` の `db()` は `connection()` で毎回描画にする）、書きは Server Actions（`app/(app)/settings/actions.ts`、`app/setup/actions.ts`）。
- 書き込みは必ず `@niho-finance/db` の repository を通す。入力は repository の Zod スキーマで検証され、監査ログに actor（`lib/actor.ts` の `actor()`）で残る。直接編集の action は行の編集できる項目だけを受け付ける（`inlinePatch`）。
- actor は IAP が付ける署名ヘッダー（`x-goog-iap-jwt-assertion`）を検証した email。`NIHO_FINANCE_ENV=prod` でヘッダーがない・検証に失敗したときは `ActorError` で書き込みを拒み、`{ ok: false, error }`（「ログイン情報を確認できませんでした…」）を返す。ローカル（IAP なし）は `NIHO_FINANCE_ACTOR`（既定 `owner`）。
- 結果は `{ ok: true, data } | { ok: false, error, fieldErrors }`（`lib/action-types.ts`）。想定内の失敗（入力・規則）は throw せず返す。`error` は「状態と戻り方」を書いた利用者向けの文。
- 書いたら `revalidatePath("/", "layout")`。ウィザードは保存してから次のステップへ redirect する。
- 金額は画面では文字列（`50,000` も `50000` も可）、サーバーで `bigint` にする。
