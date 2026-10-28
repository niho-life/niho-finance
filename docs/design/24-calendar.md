# 24. 期限（S8 の画面仕様）

[07 運用](07-operations.md) §4 の暦と [05 画面と体験](05-ui-ux.md) §2.1 の「期限」の詳細。S8（Issue #9）で作る期限の一覧 `/calendar` と、完了の記録・取り消しを定めます。期限の生成（`CALENDAR_RULES`・`syncCalendarItems`）と通知（ジョブ `calendar-notify`）は [07 §4](07-operations.md) と [`docs/ops/deploy.md`](../ops/deploy.md) §6 のとおりで、ここでは変えません。手で足す期限、土日祝の繰り下げ、「対象外」という別の状態は範囲外です。

## 1. 期限の状態

- `CalendarItem` の状態は「未完了」と「完了」の 2 つ。完了は `completedAt`（記録した日時）と `completedBy`（記録した人。Server Action の actor）で表す。migration はない（列は S1 の schema にある）。
- 未完了の項目は、毎日の同期（`syncCalendarItems`）が規則に合わせて日付・内容・注記・種類を直し、規則から外れたら消す（監査ログ `calendar_item.delete`。07 §4）。完了した項目は同期も通知も触らない（07 §4 の約束のまま）。
- 給与の確定が作る納付の期限（`ruleKey` が `payroll.` で始まり、会計期間なし。[22 §7](22-payroll.md)）は、給与の画面の「納付を登録」（仕訳を登録して完了）と「納付済みにする」で完了する。期限の画面は一覧に並べるが、完了にも未完了にもしない。ここで戻すと納付の仕訳が残ったまま予定に戻り、二重に納付を登録できてしまうため。
- 「完了にする」は、提出・納付・開催を済ませたときのほか、自社に当てはまらない期限（例: 役員報酬を払わない期の「健康保険・厚生年金 新規適用届」）を片付けるときにも使う。対象外を別の状態にはしない（[決定](../decisions/2026-10-28-calendar-completion.md)）。
- 「未完了に戻す」は完了の記録を消す。戻した項目は次の同期で規則に合わせ直され、まだ送っていない通知（当日・期限切れ）は届く。`lastNotifiedOn` は消さないので、送った通知を二度は送らない。
- 画面の状態（表示だけ。保存しない。今日は JST）:

| 状態 | 条件 | 見た目 |
| --- | --- | --- |
| 期限切れ | 未完了で 期限 < 今日 | warn の色・太字（赤は使わない。[05 §3](05-ui-ux.md)） |
| 今日まで | 未完了で 期限 = 今日 | 文字の色・太字 |
| あと n 日 | 未完了で 期限が 7 日以内（ホームの「やること」と同じ幅。`DEADLINE_WINDOW_DAYS`） | 文字の色・太字 |
| 未完了 | 未完了でそれより先 | muted |
| 完了 yyyy/mm/dd | 完了（日付は `completedAt` の JST の日） | muted（行ごと muted） |

## 2. 書き込みと監査ログ

- `completeCalendarItem(db, id, { actor })` / `reopenCalendarItem(db, id, { actor })`（`packages/db/src/calendar.ts`）。1 トランザクションで「ロック → 行を読む → 状態を変える → 監査ログ」。
- ロックは同期と同じ advisory lock（`lockSettings(tx, "fiscalYears")`）。同期が未完了として読んだ項目を、完了した後で上書きしない。
- 監査ログ: `calendar_item.complete` / `calendar_item.reopen`（entity `calendar_item`、`before` / `after` は行全体）。actor は Server Action の `await actor()`（[10 §2](10-settings-and-setup.md)）。
- すでにその状態なら何も書かない（監査ログも増えない）。2 つの画面から同時に押しても記録は 1 回。
- 見つからない id は「この期限は見つかりません。画面を読み込み直してください」、給与の納付の期限は「「<内容>」は給与の画面で納付を記録します」（どちらも `SettingsError`）。
- 監査ログの画面（[11 §8](11-transactions.md)）: 対象「期限」（絞り込みは給与〔22〕が足したもの）の行を「期限 第 n 期 <内容>」（給与の納付は「期限 <内容>」）と名付ける。action の表示名は `calendar_item.complete` → 完了にする（給与の「納付済みにする」と共通）、`.reopen` → 未完了に戻す、`.notify` → 期限の通知、`.delete` → 期限の削除（`.create` / `.update` は共通の 追加 / 変更）。

## 3. 画面 `/calendar`

- 入口: 左ナビ「期限」（報告の後・請求の前）、スマホは その他 › 期限。ホームの「やること」の期限の行（7 日以内と期限切れ。[14 §9](14-reports.md)）もここへ。
- PageHeader: 題名「期限」、meta に「未完了 n 件」（期限切れがあれば「・期限切れ m 件」）。
- 会計期間ごとの節。並びは第 1 期から。見出しは「第n期」と期間（`2026/11/02 – 2027/03/31`）と「未完了 n 件」。会計期間のない項目（給与の納付）は期限の日付が入る期の節に並べ、どの期にも入らないもの（次の期をまだ作っていないときなど）は最後に「その他」の節。
- 節の中の表（PC の列）: 期限 ・ 内容 ・ 注記 ・ 状態 ・ 操作。未完了だけを期限の近い順（同じ日は内容の順）に並べる。
- 完了した項目は表の下に畳み、「完了 n 件を表示」で開く（無効の行の畳み方と同じ。[10 §2](10-settings-and-setup.md)）。開いた表も期限の順。
- 操作: 未完了の行に「完了にする」（secondary・sm）、完了の行に「未完了に戻す」（ghost・sm）。お金の動かない、すぐ戻せる操作なので確認ダイアログは出さない。押すとトースト「「<内容>」を完了にしました」/「「<内容>」を未完了に戻しました」。行は完了の畳みへ移る（戻すと上の表へ）。失敗はトースト（error）で状態と戻り方。ボタンの読み上げ名は「<内容> を完了にする」。
- 給与の納付の行: 操作は「給与を開く」（sm のリンク。未完了は secondary、完了は ghost。`/payroll` の「納付の予定」で納付を登録する）。注記の欄に「給与の画面で納付を登録すると完了になります」。
- 節に未完了がないとき: 「未完了の期限はありません」。節に項目が 1 つもないとき（期を作った日、次の同期の前）: 「この期の期限はまだありません。会計期間から毎日の同期で作られます」。
- 表の下に一行: 「期限は名目の日付です（土日祝でも動かしていません）。7 日前・当日・期限切れの日にメールでも知らせます」。
- スマホ（768px 未満）: 行は「内容」の 1 列と操作。内容の上に「期限 · 状態」、下に注記。320px で操作が欠けない。

## 4. データと層

- `packages/db/src/calendar.ts`: 一覧 `listCalendarItems(db)`（会計期間ごとの節。各節に未完了と完了の列。項目のない期も節を返す。各項目に完了を記録する画面 `managedBy`: `calendar` / `payroll`）、`completeCalendarItem` / `reopenCalendarItem`、表示の状態 `calendarItemStatus(item, today)`（純粋関数）。
- `packages/db/src/reports-query.ts`: `upcomingDeadlinesTodo` の `href` を `/calendar` にする。
- `packages/ledger/src/master-data.ts`（監査ログの対象と action の表示名）と `packages/db/src/audit-query.ts`（期限の行の名付け）は追記だけ。
- `apps/web/app/(app)/calendar/`: `page.tsx`（読み。Server Component）、`actions.ts`（`completeCalendarItemAction` / `reopenCalendarItemAction`。`await actor()`、成功で `revalidatePath("/", "layout")`）、`_components/`（表・状態・ボタン）。
- `nav-items.ts`・`icons.tsx`・`bottom-tabs.tsx`（その他に含めるパス）・`more/page.tsx` は追記だけ。

## 5. 受け入れ条件

- 「完了にする」で行が完了の畳みへ移り、ホームの「やること」から消える。「未完了に戻す」で戻る。
- 完了・取り消しが監査ログに `calendar_item.complete` / `calendar_item.reopen` で 1 回ずつ残り、同じ状態への操作は何も残さない。監査ログの画面で「期限」で絞り込め、行が内容の名前で読める。
- 同期が完了した項目の日付・内容を変えない。未完了に戻した項目は次の同期で規則の日付に戻る。
- 完了した項目は通知されない。
- 給与の納付の期限は期の節に並び、完了・取り消しを受け付けない（給与の画面へ案内する）。
- 1280px と 320px で一覧と操作が欠けない。
