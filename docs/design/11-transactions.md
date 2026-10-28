# 11. 取引（S3 の画面仕様）

[05 画面と体験](05-ui-ux.md) §2.3 の詳細。S3（Issue #4）で作る「取引」の画面（一覧・新規・詳細・訂正・取消）、設定の「締め」と「監査ログ」、それらを支える台帳の操作を定めます。明細（S5）、証憑（S6）、報告（S7）、決算（v2: `FiscalYear.status` の `closing` / `closed` と決算振替）、ルール・定期取引は範囲外です。

## 1. 台帳の操作と不変条件

S1 の `postJournalEntry` / `voidJournalEntry`（`packages/db/src/journal.ts`）の上に、訂正と締めを足します。

- **登録**: 連番の採番・行の挿入・監査ログを 1 トランザクション（S1）。日付は開いている会計期間の中で、かつ `lockedThrough` より後。
- **取消** `voidJournalEntry(id, { reason })`: 反対仕訳（`kind = reversal`、借方と貸方を入れ替えた同じ行）を作り、元の仕訳を `voided` にする。反対仕訳の日付は元の日付。元の日付が締め済み（`lockedThrough` 以前）なら、開いている最初の日付（`firstOpenDate`）。理由は必須。取消済みと反対仕訳はどちらも台帳に残り、連番も消費する。反対仕訳そのものと取消済みの仕訳は取消できない。
- **訂正** `correctJournalEntry(id, { reason, replacement })`: 1 トランザクションで「取消（反対仕訳）→ 新しい仕訳の登録 → 元の仕訳の `replacedById` に新しい仕訳を結ぶ」。新しい仕訳の `kind` は入力どおり（既定は元と同じ）、`sourceKind` は `manual`。日付は入力どおりで、締め済みの日付は拒否する（画面は `firstOpenDate` を初期値にする）。監査ログは取消の 2 行（反対仕訳の登録・取消）に加えて `journal_entry.correct`（`before: { replacedById: null }`, `after: { replacedById }`、理由つき）を残す。訂正後の仕訳は普通の仕訳で、さらに訂正・取消できる。
- **締め** `closeFiscalYearThrough(fiscalYearId, { lockedThrough, reason })`: `FiscalYear.lockedThrough` を月末日（または期の終了日）に進める。`null` にして戻すこともできる（戻すときは理由必須）。期の行をロックし、日付が期の範囲内の月末日であることを確かめ、影響する仕訳（新旧の `lockedThrough` の間の日付）の件数を返す。監査ログは `fiscal_year.close` / `fiscal_year.reopen`（`before` / `after` に日付、理由）。`status = closed` の期は変えられない。
- 締め以前の日付の登録・取消・訂正は台帳が拒否する（`PERIOD_LOCKED`。S1 の検証）。画面はそのエラーを「2026/12/31 までは締めています。登録するには 設定 › 会計期間 で締めを戻してください」の形で出す。
- **消費税**（[02 §3](02-accounting-rules.md)）: フォームの金額はすべて税込で入れる。
  - 税込経理（免税の期を含む）: 行の `amount` は税込、`taxAmount` は内税額（税込 × 率 ÷ (100 + 率)、切り捨て）。税の行は作らない。
  - 税抜経理: 行の `amount` は税抜（税込 − 内税額）、`taxAmount` は内税額。収入なら 仮受消費税（2310）、支出なら 仮払消費税（1400）の行を自動で足す（税区分 `na`、`taxAmount` 0）。
  - 税率は `resolveTaxRule(税区分, 日付)` で引く。規則がない課税の税区分は登録を拒否する（「税区分 … の税率が 2026/11/02 に設定されていません。設定 › 税区分 で足してください」）。
- S2 の積み残し: 税抜経理の期の開始仕訳（`opening.ts`）で課税仕入の行を拒否していたのを、同じ分割で仮払消費税の行を足す形にする。

## 2. ルートと殻

| ルート | 画面 |
| --- | --- |
| `/entries` | 一覧（仕訳帳） |
| `/entries/new?type=income\|expense\|transfer\|voucher` | 新規（収入 / 支出 / 振替 / 伝票） |
| `/entries/[id]` | 詳細 |
| `/entries/[id]/correct` | 訂正 |
| `/settings/fiscal-years` | 会計期間に「締め」を足す |
| `/settings/audit-log` | 監査ログ |
| `/more` | スマホの「その他」（取引 / 設定 への入口） |

- 左ナビの「取引」を `/entries` に有効化する。スマホの下タブ「その他」は `/more` に向け、`/more` は 取引・設定 の 2 行（将来ここに増える）。
- ホームの「やること」に、開いている期の「今月の取引 n 件」は出さない（S7 で損益と一緒に作る）。ホーム下部の案内文を「取引は登録できます。明細・報告は準備中です」に直す。
- 設定の索引に「監査ログ」を足す（「証憑の規程」の下）。

## 3. 一覧 `/entries`

- PageHeader: 題名「取引」、meta に「第 n 期」。右に 4 つのボタン: 収入 / 支出 / 振替（secondary・sm）、伝票（ghost・sm）。いずれも `/entries/new?type=…` へのリンク。
- 絞り込み（GET フォーム。URL の検索パラメータが正で、再読み込みや共有で同じ結果になる）: 期間（今月 / 前月 / 今期 / 任意: 開始・終了の日付）、科目、取引先、セグメント、タグ、状態（登録済み / 取消済み / すべて。既定は登録済み）、検索（摘要と行の摘要の部分一致）。パラメータは `from` `to` `account` `partner` `segment` `tag` `status` `q` `page`。select の変更で自動送信（小さな client component）。JS がなくても「絞り込む」ボタンで送れる。
- 表（仕訳帳の見た目。PC の列）: 日付 ・ No. ・ 摘要 ・ 借方 ・ 貸方 ・ 金額 ・ セグメント ・ 状態。借方 / 貸方は 1 行目の科目名（補助科目があれば「科目 / 補助」）で、同じ側に 2 行以上あれば「ほか n 行」。金額は借方合計。セグメントは収益・費用の行のもの（複数なら最初のものと「ほか」）。状態は 取消済み / 反対仕訳 / 訂正済み（→ No. x）/ 締め済み を小さな文字で。取消済みの行は muted。
- 行全体が詳細へのリンク（キーボードで到達できる）。
- スマホ（768px 未満）は 2 段: 日付・摘要 / 借方 → 貸方・金額。
- 並びは日付の降順、同じ日付は No. の降順。50 件ごとに「前へ / 次へ」と「n 件」。
- 空のとき: 「取引がありません。収入・支出・振替から登録します」と 3 つのボタン。

## 4. 新規 `/entries/new`

上に 収入 / 支出 / 振替 / 伝票 の切替（リンク。既定は支出）。フォームは native の input / select / textarea だけで作り、Tab と Enter だけで登録できる。共通の規則:

- 日付（既定は JST の今日。開いている期の外や締め済みならサーバーが拒否し、状態と戻り方を表示）、摘要（必須・200 字）、取引先（任意）、セグメント、タグ（チェックボックスの列。タグがなければ出さない）、金額（税込・`MoneyInput`）、税区分（科目の既定の税区分を初期値に。科目を変えたら未編集の税区分を更新）。
- 「うち消費税 n 円」を金額の下に出す。税率の規則（`TaxRateRule`）を client に渡し、`resolveTaxRule` と `inclusiveTaxAmount` で日付・税区分・金額から計算する（`@niho-finance/ledger` は純粋関数なので client でも動く）。
- セグメントの初期値は科目の既定セグメント、なければ口座の既定セグメント。収益・費用の科目で空なら送信時にエラー（台帳の `SEGMENT_REQUIRED` をそのまま）。
- 取引先を選んだとき、科目・税区分・セグメントが未編集なら取引先の既定値で埋める。
- 送信は Server Action。成功したら詳細へ移り「No. n を登録しました」のトースト。「続けて登録」（secondary）は同じ種類と日付のまま金額・摘要・取引先を空にして留まる。失敗は項目の下にエラー、項目に結べないものはフォームの上に。
- 証憑は S6 で足す（S3 では項目を置かない）。

### 4.1 収入

- 入金先: 口座（有効な口座。「名前（科目 / 補助科目）」）、または科目（資産・負債の科目。例: 売掛金）。1 つの select に optgroup「口座」「科目」で並べ、値は `wallet:<id>` / `account:<id>`。
- 科目: 収益の科目（売上高・営業外収益 の順）。
- 仕訳: 借方 入金先、貸方 収益科目（税区分・税額・セグメント・取引先・摘要は貸方の行に）。`kind = normal`、`sourceKind = manual`。

### 4.2 支出

- 支払元: 口座（銀行 / カード / 現金 / 役員立替 …）、または科目（負債。例: 未払金・未払費用）。収入と同じ select の形。
- 科目: 費用の科目を先に、続けて現預金以外の資産（前払費用・固定資産・創立費など）と負債（役員借入金の返済など）。
- 仕訳: 借方 科目（税区分・税額・セグメント・取引先・摘要）、貸方 支払元。`kind = normal`。

### 4.3 振替

- 出金元の口座 → 入金先の口座（どちらも口座だけ。同じ口座は拒否）、金額、日付、摘要（既定「振替」）、手数料（任意: 金額。科目は 支払手数料 5400 固定、税区分は科目の既定、セグメントは出金元の口座の既定か「共通」）。
- 仕訳: 借方 入金先 金額、（手数料があれば 借方 支払手数料 手数料）、貸方 出金元 金額＋手数料。`kind = transfer`。税区分は口座の行が `na`。

### 4.4 伝票

- 種類: 通常 / 決算整理（`normal` / `adjusting`）。日付・摘要・取引先（任意・仕訳全体の既定）・タグ。
- 行の表: 借方 / 貸方 ・ 科目 ・ 補助科目（科目にあるときだけ）・ 金額 ・ 税区分 ・ 税額（自動・表示だけ）・ セグメント ・ 取引先 ・ 摘要。最初は 2 行（借方・貸方）。「行を追加」「×」で増減。
- 下に 借方合計 / 貸方合計 / 差額。差額が 0 でないあいだは「登録」を無効にし、差額を赤でなく太字で出す。サーバーも `UNBALANCED` で拒否する。
- 税抜経理の期は、各行の金額を税抜として扱い（`taxAmount` は税抜 × 率 ÷ 100）、仮受・仮払の行は自分で書く（自動では足さない）。税込経理の期は各行の金額を税込として扱う。

## 5. 詳細 `/entries/[id]`

- PageHeader: 題名「No. n」、meta に「2026/11/02 · 通常 · 手入力 · owner が 2026/11/03 10:12 に登録」。戻るは一覧へ（絞り込みを保つため `history.back` ではなく一覧のリンク）。
- 状態の帯（該当するものだけ）:
  - 取消済み: 「取消済み（理由: …）。反対仕訳 No. x」（リンク）。
  - 反対仕訳: 「No. x を取り消す反対仕訳」（リンク）。
  - 訂正済み: 「No. y に訂正しました」（リンク）。訂正後の側には「No. x の訂正」（リンク）。
  - 締め済み: 「2026/12/31 までは締めています。訂正と取消は 2027/01/01 付で登録します」。
- 行の表: 借方 / 貸方 ・ 科目（コード 名前 / 補助科目）・ 金額 ・ 税区分 と 税額 ・ セグメント ・ 取引先 ・ 摘要 と タグ。下に合計。
- 操作（`posted` かつ反対仕訳でないとき）: 「訂正」（ButtonLink → `/entries/[id]/correct`）、「取消」（ghost・danger の文字色 → ConfirmDialog `variant: "danger"`: 理由の textarea（必須）、締め済みなら反対仕訳の日付を文で出す。ボタンは「取消」）。取消の後は同じページに留まり帯が出る。
- 履歴: この仕訳と、その反対仕訳・訂正後の仕訳の監査ログ（`entity = journal_entry`）を日時順に。列: 日時 ・ 操作（登録 / 取消 / 訂正）・ 実行者 ・ 理由。行を開くと before / after を整形した JSON で出す（`<details>`）。
- 生成元: `sourceKind` のラベルだけ（手入力 / 初期設定 / 明細 / Stripe / 請求書 / 固定資産 / 定期取引 / 取込）。明細や証憑への導線は S5 / S6 で足す。

## 6. 訂正 `/entries/[id]/correct`

- 伝票のフォームを元の仕訳で埋めて開く（種類・日付・摘要・取引先・タグ・行）。上に「No. n を取り消して、新しい仕訳を登録します」と 理由（必須）。
- 日付の初期値は元の日付。元の日付が締め済みなら `firstOpenDate` にし、その旨を日付の help に出す。
- 「訂正を登録」（primary）→ `correctJournalEntryAction`。成功したら新しい仕訳の詳細へ移り、「No. n を取り消し、No. m として登録しました」のトースト。
- 元の仕訳が取消済み・反対仕訳・`closed` の期のときはこのページを開けない（詳細へ戻し、理由を帯で出す）。

## 7. 締め（設定 › 会計期間）

- 会計期間の行に「締め」の列を足す: `lockedThrough`（yyyy/mm/dd）か「—」、右に「締め」ボタン（sm）。
- ボタンで Sheet を開く: 月末日の select（期の開始から、期の終了日と今日の月末の早いほうまで。先頭に「締めない」）。選ぶと影響を文で出す: 進めるとき「2026/11/02〜2026/12/31 の仕訳 n 件が読み取り専用になります」、戻すとき「2026/12/01〜2026/12/31 の仕訳 n 件が再び登録・取消できるようになります」と 理由（戻すときだけ必須）。確認は ConfirmDialog（「締める」/「締めを戻す」）。
- 締め済みの期間の仕訳は一覧と詳細で「締め済み」を出し、訂正・取消は `firstOpenDate` 付で作られる（§1）。
- `status = closed` の期は列を「決算済み」にしてボタンを出さない。

## 8. 監査ログ `/settings/audit-log`

- 表: 日時 ・ 操作 ・ 対象 ・ 実行者 ・ 理由。50 件ごとに「前へ / 次へ」。絞り込み: 対象（select: 仕訳 / 会計期間 / 事業所 / 勘定科目 / 補助科目 / 税率規則 / 口座 / 取引先 / セグメント / タグ / 標準データ / 初期設定）、期間（開始・終了）。
- 操作はラベルで出す（`journal_entry.post` → 仕訳の登録、`journal_entry.void` → 仕訳の取消、`journal_entry.correct` → 仕訳の訂正、`fiscal_year.close` → 締め、`fiscal_year.reopen` → 締めを戻す、`*.create` → 追加、`*.update` → 変更、`*.activate` / `*.deactivate` → 有効化 / 無効化、`setup.skip` → 初期設定を後回し、`standard_data.bootstrap` → 標準データの投入）。対応のないものは `action` をそのまま muted で出す。
- 対象は「仕訳 No. 12」のように読める形（仕訳は `no` を引く。他は名前）。行を開くと before / after を並べて出す（整形した JSON、`<pre>`、小さい字）。
- 読み取りだけで、監査ログは増えない。

## 9. データと層

- `packages/ledger`
  - `src/simple-entry.ts`: `buildSimpleEntry(input, context)` — 収入 / 支出 / 振替 の入力から `JournalEntryInput` を作る純粋関数（税の分割、税抜経理の仮受・仮払の行、振替の手数料）。`context` は会計期間（`accountingMethod`）、税率規則、口座と科目の参照（id・コード・種類・既定の税区分とセグメント）。`buildVoucherEntry(input, context)` — 伝票の行から `JournalEntryInput`（税額の計算だけ。行は足さない）。
  - `src/master-data.ts` に `ENTRY_KIND_LABELS`、`SOURCE_KIND_LABELS`、`ENTRY_STATUS_LABELS`、`AUDIT_ACTION_LABELS`、`AUDIT_ENTITY_LABELS` を足す。
  - テスト: 貸借一致（任意の入力で）、税込 / 税抜 / 免税の 3 通りの行、振替の手数料、税率の規則がないときの失敗、伝票の税額。
- `packages/db`
  - `src/entries.ts`: `listJournalEntries(db, filters, page)`（件数つき）、`getJournalEntryDetail(db, id)`（名前つきの行、連鎖、締めの状態、`firstOpenDate`）、`correctJournalEntry(db, id, { reason, replacement }, { actor })`、`voidJournalEntryWithOpenDate(db, id, { reason }, { actor })`（締め済みなら `firstOpenDate` を使う）、`loadEntryHistory(db, ids)`、`loadEntryFormOptions(db)`（口座・科目・税区分・セグメント・取引先・タグ・税率規則）。
  - `src/closing.ts`: `closeFiscalYearThrough`、`listCloseOptions(fiscalYear, today)`（月末日の候補）、`countEntriesBetween`。
  - `src/audit-query.ts`: `listAuditLog(db, filters, page)` と、対象の表示名を引く補助。
  - `src/schemas.ts`: `simpleEntrySchema`（種類ごと）、`voucherEntrySchema`、`voidEntrySchema`、`correctEntrySchema`、`closeFiscalYearSchema`、`entriesFilterSchema`、`auditLogFilterSchema`。
  - `settings.ts` は触らない（締めは `closing.ts`）。約 1,800 行の分割は別の機械的な PR で行う。
  - テスト（`test:db`）: 訂正の連鎖（取消済み → 反対仕訳 → 新仕訳、`replacedById`、監査ログの before / after）、締め以前の登録・取消・訂正の拒否と文言、締めの進め・戻し（件数・監査ログ・理由の必須）、締め済みの仕訳の取消が `firstOpenDate` 付になること、一覧の絞り込みとページ、監査ログの絞り込み、読みで監査ログが増えないこと。
- `apps/web`
  - `app/(app)/entries/{page.tsx, new/page.tsx, [id]/page.tsx, [id]/correct/page.tsx, actions.ts}` と `_components/`（絞り込み、一覧の表、収入 / 支出 / 振替 / 伝票 のフォーム、取消ダイアログ、履歴）。
  - `app/(app)/more/page.tsx`、`app/(app)/settings/audit-log/page.tsx`、会計期間の締め（`fiscal-years-table.tsx` に列と Sheet）、`nav-items.ts` と `bottom-tabs.tsx` の有効化、設定の索引。
  - 書き込みは Server Actions → `@niho-finance/db`。読みは Server Components。

## 10. 受け入れ条件

Issue #4 の条件に加えて:

- 収入・支出・振替・伝票のそれぞれで登録でき、詳細の行が台帳の規則（貸借一致・税区分・セグメント）を満たす。
- 税抜経理の期では収入・支出に仮受・仮払の行が自動で付き、税込経理・免税の期では付かずに `taxAmount` だけ持つ（単体テスト）。
- 締め済みの月の仕訳を取消・訂正すると、反対仕訳と新仕訳が開いている最初の日付で作られ、画面にその日付が出る。
- 監査ログの画面で、仕訳の登録・取消・訂正と締めの履歴が理由つきで読める。
- 320px で一覧・新規・詳細が操作でき、横スクロールが出ない。
- `npm run check`、`test:db`、`next build` が通る。
