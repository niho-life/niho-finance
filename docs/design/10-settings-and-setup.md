# 10. 設定と初期化（S2 の画面仕様）

[05 画面と体験](05-ui-ux.md) §2.8 の詳細。S2（Issue #3）で作る「アプリの殻」「初期化ウィザード」「設定」の画面と、共通の UI 部品を定めます。締め（S3）、ルール・定期取引・証憑の規程・書き出し・監査ログ（S5〜S8）、認証（S8）は範囲外です。

## 1. アプリの殻

- 左ナビ（PC・幅 216px）: 上にブランド（NIHO finance、その下に会社名と第 n 期）。項目は ホーム / 明細 / 取引 / 証憑 / 報告 / 設定。未実装の項目は muted の非リンクとして並べ、S3〜S7 で順に有効にする。
- スマホ（768px 未満）: 左ナビを隠し、下タブ（ホーム / 明細 / 証憑 / 報告 / その他）。その他 → 設定。
- ホーム `/` は S7 まで仮置き。会社名・第 n 期・現預金の合計（仕訳だけから導出。試算表と一致する）・「設定」への導線。会社が未登録なら `/setup` へ redirect。
- 色と字は `app/globals.css` のトークン（モック `docs/design/mock/v1.html` の値）。Tailwind 4。数値は `tabular-nums` で右揃え。
- UI 部品（`apps/web/components/ui/`）: Button（primary / secondary / ghost / danger、sm / md）、Input、Select（native `<select>`）、Textarea、Checkbox、Switch、FormField（label・help・error を近接）、Table（行高 40px）、Sheet（右から出る編集面。PC は幅 400px、スマホは全面）、ConfirmDialog（native `<dialog>`。`variant: "danger"` あり。ボタンは結果の動詞）、Toast（下中央・5 秒）、EmptyState（状態と次の行動）、PageHeader。外部の UI ライブラリは入れない。`window.confirm` / `alert` は使わない。

### 1.1 ホーム画面のアプリ（PWA、#51）

スマホのホーム画面から 1 回で開き、[05 §1](05-ui-ux.md) の 3 つの仕事（残高を見る・明細を片付ける・レシートを撮る）を手早く済ませるための作りです。帳簿は毎回サーバーから最新を読み、端末に残しません。追加の手順は [mobile.md](../ops/mobile.md) に書きます。

- **マニフェスト** `public/app.webmanifest`（静的ファイル。`GET /app.webmanifest`）
  - 名前は「NIHO finance」、`lang: "ja"`。`id`・`start_url`・`scope` は `/`（ホーム）。
  - 背景色とテーマ色は白 `#ffffff`（D14）。
  - アイコンは `public/icons/` の 192px・512px と maskable の 512px。緑（primary）の地に白の印で、原本は `icon.svg`。
- **表示**: `display: "browser"` と `display_override: ["standalone"]`
  - Chrome（Android・PC）は `display_override` を読み、standalone の窓で開く。
  - iOS の Safari は `display_override` を読まない。`browser` なので Safari のタブで開く。理由は下の IAP の項。
- **manifest の読み込み**: ルートの layout に `<link rel="manifest" crossorigin="use-credentials">` で置く
  - ブラウザは manifest を、既定ではクッキーなしで取る。
  - IAP は、クッキーのない要求をすべて Google のサインインへの 302 で返す（本番で確認、2026-10-29）。クッキーなしでは manifest が読めず、インストールできない。
  - Next の `app/manifest.ts` は、Vercel の preview でしか `use-credentials` を付けない。そのため使わない。
- **iOS のメタ**
  - 出すもの: `apple-touch-icon`（180px）、`apple-mobile-web-app-title`、status bar の `default`、`format-detection: telephone=no`（金額の数字を電話番号のリンクにしない）。
  - 出さないもの: `apple-mobile-web-app-capable`。iOS 16.4〜18 ではこれがあると Web アプリの窓で開くため。
- **Service Worker** `public/sw.js`（scope `/`）は帳簿をキャッシュしない
  - Cache Storage に置くのは `/offline.html` の 1 件だけ。activate のときに他のキャッシュを消す。
  - 扱うのは GET のページ遷移（`mode: "navigate"`）だけ。navigation preload を使ってネットワークから取り、通信に失敗したときだけ `/offline.html` を返す。
  - HTTP のエラーと IAP の 302 は、そのままブラウザに渡す。
  - ページ遷移でない要求（fetch・Server Actions・RSC・API の呼び出し・画像などの静的ファイル）には触れない。
  - 新しいタブで開く証憑のファイルや書き出しもページ遷移なので、同じくネットワークの応答をそのまま返す。navigation preload の応答を使うので、要求は 1 回で済む。
  - 登録はルートの layout の client 部品（`components/pwa/`）が行う。
- **接続がない画面** `public/offline.html`（`GET /offline.html`）
  - 自己完結の HTML。CSS と文言を中に持ち、外の CSS・JS を読まない。
  - 見出しは「接続がありません」。本文は「帳簿は最新の内容だけを表示するため、つながっていない間は開けません」。CTA は「開き直す」。
  - オンラインに戻ると自動で開き直す。
- **前面に戻ったときの読み直し**
  - ホーム画面のアプリもブラウザのタブも、前の表示を残したまま前面に戻る。
  - 画面が 60 秒以上隠れてから戻ったとき（`visibilitychange`）は、`router.refresh()` で読み直す。戻る操作で前の表示がそのまま戻ったとき（`pageshow` の `persisted`）も同じ。
  - IAP の期限が切れていれば、Next の読み直しはページ遷移に切り替わり、その遷移で IAP のサインインに進む。
- **下タブの「証憑」（中央のカメラ）**: 押すとカメラが開く
  - 中身は、`<input type="file" accept="image/*" capture="environment">` を包む label。
  - 撮った写真を保存し、その証憑の詳細を開く。詳細には、近い日付の未処理の明細が候補に出る（13 §4）。撮影 → 保存して詳細 → 紐づける、の 3 操作で終わる。
  - 一覧へは、その他 › 証憑 か、ホームの「やること」から入る。`/documents` にいる間は「その他」が現在地になる。
- **IAP**（[06 §3.2](06-architecture.md)）
  - サインインの流れ: 最初の 302 で、画面の origin に nonce のクッキー（15 分）を置く。そのあと PKCE で Google と IAP を往復して戻る。
  - Chrome: インストールした窓はブラウザとクッキーを共有するので、standalone でもサインインが完結する。
  - iOS: ホーム画面の Web アプリは、Safari とクッキーが別。範囲外の Google のサインインは、Safari View Controller のシートで開く。戻り先がシートのままだと nonce が見つからず、サインインが終わらない。これには報告が割れているので、実機で確かめる。
  - そこで iOS は Safari で開くのを既定にする。iOS 26 以降で出る「Web アプリとして開く」は、オフにして追加する。
  - 実機で Web アプリの窓でもサインインが通るとわかったら、`display` を `standalone` に替える（[決定](../decisions/2026-10-29-pwa-display-and-cache.md)）。
- **入口の検査から外す**: `proxy.ts`（23 §3.3）の対象から、`sw.js`・`app.webmanifest`・`offline.html`・`icons/` を外す
  - これらは帳簿を含まない静的ファイルで、誰が通れるかは IAP が決める。
  - 外さないと閲覧の人には 403 になり、要求のたびに利用者を DB で引く。
  - route にしないのも同じ理由。route は先頭で `authorizeRoute` が要る（23 §3.2）。
- **配備**: Next の standalone の出力は `public/` を含まない。Dockerfile の runtime で `apps/web/public` を写す。

## 2. 共通の決まり

- 読みは Server Components、書きは Server Actions。入力は Zod で検証し、書き込みは `packages/db` の repository を通して監査ログを残す。actor は IAP の署名ヘッダーを検証したメール（`apps/web/lib/actor.ts`。ローカルは環境変数 `NIHO_FINANCE_ACTOR`、既定 `owner@example.com` = seed の管理者。v3 からは 設定 › 利用者 に登録したメールでないと画面が開かない。[23 §2](23-users-and-expenses.md)）。
- 一覧の中で直接編集（Google フォーム型）: 行の項目をクリックするとその場で入力になり、blur か Enter で保存。行の右端に「保存済み / 保存中 / エラー（理由）」を小さく出す。行の追加は表の末尾の「追加」行。削除はなく「無効にする」。無効の行は畳み、「無効 n 件を表示」で開く。
- 文言: 見出し・タブ・ボタンは漢語の名詞句と結果の動詞（保存 / 追加 / 無効にする / 有効にする / 次へ / 戻る / 完了 / 登録）。enum 値や ID を見せない。エラーは状態と戻り方（「決算月は会計期間を作った後は変えられません」）。
- 320px で主要操作が欠けない。表はスマホで「名前＋主要 2 項目」の 2 段にする。
- 影響の大きい操作（開始仕訳の登録、会計期間の作成、消費税の区分の変更）は確認ダイアログに影響（件数・金額・期間）を出す。
- 金額の入力は半角数字と 3 桁区切りの両方を受け、表示は 3 桁区切り。単位「円」は列見出しに置く。

## 3. 初期化ウィザード `/setup`

- 会社が未登録のとき、`/` と `/settings` 配下から `/setup` へ redirect する。会社があれば `/setup` は進捗の続きを開く（全部終わっていれば `/` へ）。
- 上に進捗（1 事業所 → 2 会計期間 → 3 勘定科目 → 4 口座 → 5 開始仕訳 → 完了）。各ステップは保存してから次へ進む（再読み込みしても続きから）。4 と 5 は「あとで」で飛ばせる（設定から後で行える）。
- Step 1 事業所: 商号（必須）、カナ、代表者、住所、設立日（必須。会計期間の起点）、決算月（既定 3）、法人番号（任意。13 桁とチェックデジット）、インボイス登録番号（任意。T + 13 桁、法人番号と整合）。保存で `Company` を作る。
- Step 2 会計期間: 設立日と決算月から第 1 期（設立日〜次の決算月末）を計算して表示。終了日だけ変更可。消費税の区分（免税 / 本則 / 簡易。既定は免税）、経理方式（免税なら税込で固定。課税なら税抜を既定）。保存で `FiscalYear`（no = 1）を作る。
- Step 3 勘定科目: テンプレート（`CHART_TEMPLATE`）を区分ごとに折り畳んだ一覧で見せ、「この内容で作成」。標準の税区分・税率規則・セグメントも同時に投入する（既にあれば何もしない）。
- Step 4 口座: 「銀行（普通預金）」1 行と「役員立替」1 行を既定で提案（役員立替は既定 ON）。行の追加: 名前・種類（銀行 / カード / 現金 / Stripe / 役員立替）・既定セグメント。開始残高は入れない（設立と同時に帳簿を始めるので、残高は開始仕訳と取引から導く）。種類から勘定科目を自動で紐づけ（銀行 → 1100、カード → 2100、現金 → 1000、Stripe → 1150、役員立替 → 2400）、補助科目を口座名で作る。Stripe のアカウント ID と鍵は S4 で登録する。
- Step 5 開始仕訳: (a) 資本金の払込: 日付（既定 設立日）・金額（既定 50,000）・入金先の口座。(b) 設立の費用（創立費）: 行ごとに 名目・金額・日付・支払元（役員立替 か 口座）・税区分（既定 `purchase_out`、変更可）。(c) 設立後から開業までの費用（開業費）: 同じ形。下にプレビュー（生成される仕訳の借方 / 貸方と合計）→「登録」で `postJournalEntryInTransaction`（kind = `opening`、sourceKind = `system`、セグメント = 共通）。登録後は読み取り表示にし、直しは取引画面（S3）の訂正で行う旨を出す。
- 完了: 試算表の要約（資産・負債・純資産・当期純利益）と「ホームへ」。その後の手順はホームの「はじめの手順」が示す（§3.1）。

### 3.1 初月のガイド「はじめの手順」（#71）

ウィザードの後、[07 §1](07-operations.md)「設立直後」の残りを画面で示す。ホームの最上段に「はじめの手順」のカードを置き、全部済むまで出す（[14 §9](14-reports.md)）。

| キー | 項目（文の頭） | 済み（自動の判定） | 入口 |
| --- | --- | --- | --- |
| `filings` | 税務の届出 | 第 1 期の「設立から」の期限（[24](24-calendar.md)。`ruleKey` が `founding.` で始まる）が 1 件以上あり、すべて完了 | `/calendar` |
| `import` | 明細の取込 | CSV の取込か銀行の API の同期が 1 回通った（`ImportBatch` の `source` が csv / api で、同期全体の失敗 `error` がない） | `/imports` |
| `stripe` | Stripe の接続 | Stripe の口座が 1 つ以上接続済み | `/imports`（Stripe の口座がなければ `/settings/wallets`） |
| `recurring` | 定期取引の登録（家賃・役員報酬） | 有効な定期取引が 1 件以上 | `/settings/recurring` |
| `records-policy` | 証憑の規程 | 規程の施行日がある（[13 §5](13-documents.md)） | `/settings/documents-policy` |
| `partners` | 取引先の登録 | 有効な取引先が 1 件以上 | `/settings/partners` |

- 並びは法定の期限がある届出を先にし、あとは 07 §1 の順。
- 判定は各レーンの読み出しを使い、結果は保存しない（描画のたびに導出）: 取込は `ImportBatch` の件数（取込の履歴 `listImportBatches` は Stripe と失敗した同期も含むため）、`listImportableWallets`（`stripe.connected`）、`countActiveRecurringItems`、`getRecordsPolicy().effectiveOn`、`listPartners`（有効）、`listCalendarItems`（第 1 期の `founding.*`）。
- 各行: 項目の文・一行の説明・入口のリンク（結果の動詞: 「期限を見る」「取り込む」「接続する」「登録する」「定める」）と「済みにする」（ghost・sm）。手動の「済みにする」は、自動の判定が当てはまらない会社のため（Stripe を使わない、取引先がまだない、届出を出したが期限を完了にしていない など）。お金の動かない、すぐ戻せる操作なので確認ダイアログは出さない。
- 届出の行の下に、未完了の `founding.*` の期限を近い順に最大 3 件（内容・期限の日付・状態の文〔[24 §1](24-calendar.md) の表〕。各行が `/calendar`）。ほかにあれば「ほか n 件」。期限がまだない（会社を作った日の毎朝の同期の前）ときは「期限は毎朝 9 時の同期で作られます」。期限の完了は期限の画面で行う。
- 見出しは「はじめの手順」、meta に「6 項目中 n 項目済み」。済んでいない項目だけを並べ、済んだ項目は下の「済み n 件を表示」で開く（無効の行の畳み方と同じ。§2）。開いた中で、手動で済みにした項目には「未了に戻す」（ghost・sm）。自動で済みの項目は戻せない（条件を満たしているため）。
- 全部済むとカードは出ない。設定 › 事業所 の「はじめの手順」（§4.1）の「ホームに表示する」で、全部済んだ後も出せる。そのときは全項目を済みで並べ、「閉じる」で元に戻す。
- 畳む: 見出しの右の「畳む」/「開く」（`aria-expanded`）。既定は開く。畳んだかどうかは端末ごとに覚える（`localStorage` のキー `niho-finance:first-month-guide`。読めない環境では毎回開く）。畳んだときは見出しと meta だけ。320px で項目の文と入口が欠けない。
- 保存: `Company.setupGuide`（jsonb `setup_guide`）に `{ checked: { <キー>: { at, by } }, shownAt: string | null }`。書き込みは 1 トランザクション（事業所の行のロック → 読む → 変える → 監査ログ）。監査ログは事業所の行に `setup.guide_check` / `setup.guide_uncheck` / `setup.guide_show` / `setup.guide_close`（before / after は `setupGuide`）で、監査ログの画面の絞り込み「初期設定」（`setup.*`）に入る。すでにその状態なら何も書かない。知らないキーは `SettingsError`。
- 層: `packages/db/src/first-month.ts`（`loadFirstMonthGuide(db, today)` と書き込み 4 つ）、`apps/web/app/(app)/_components/first-month-guide.tsx`（ホームのカード。Server Component と、畳むためのクライアント部品）。ホームへの差し込みは 1 行。

## 4. 設定 `/settings`

索引ページは節の一覧。各行に要約（事業所 → 商号、会計期間 → 第 n 期と期間と消費税の区分、勘定科目 → 件数、税区分 → 件数、口座 → 件数、取引先 → 件数、セグメント → 件数、タグ → 件数）。モックの `/settings` の見た目。

### 4.1 事業所 `/settings/company`

フォーム 1 面: 商号・カナ・代表者・住所・設立日・決算月（会計期間が 1 つでもあれば読み取り専用にして理由を出す）・法人番号・インボイス登録番号と登録日。保存。

フォームの下に「はじめの手順」（§3.1）: 「6 項目中 n 項目済み」と、カードがホームに出ていないとき「ホームに表示する」（secondary）。出ているときは「ホームに表示しています」。

### 4.2 会計期間 `/settings/fiscal-years`

表: 第 n 期・期間・消費税の区分・経理方式・締め日（S3 まで「—」）・状態（進行中 / 決算中 / 締め済み）。行の編集: 消費税の区分と経理方式（その期に仕訳があれば確認ダイアログ）。「次の期を作る」: 直前の期末の翌日から 12 か月後の月末を既定にして作る。期の削除はない。

### 4.3 勘定科目 `/settings/accounts`

区分（資産 / 負債 / 純資産 / 収益 / 費用 / 内部）の見出しで区切った表: コード・名前・決算書の区分・既定の税区分・現預金・補助科目の数・状態。直接編集できるのは名前・決算書の区分・既定の税区分・現預金・状態。追加行: コード（4 桁・一意）・名前・種類・決算書の区分。行を開くと補助科目の一覧（追加・名前の編集・無効化）。e-Tax コードの列は v2。

### 4.4 税区分 `/settings/tax-categories`

表: 表示名・方向（売上 / 仕入 / 対象外）・いま有効な税率と控除割合・状態。行を開くと税率規則の表（適用期間・税率・控除割合・有効）。できるのは規則の追加と有効 / 無効の切替だけ（既存の規則の数値は編集しない。誤りは新しい規則で上書きする）。

### 4.5 口座 `/settings/wallets`

表: 名前・種類・紐づく科目と補助科目・既定セグメント・取込形式（S4 まで「—」）・明細の残高・状態。追加と編集は Sheet: 名前・種類・紐づく科目（種類から自動、変更可）・既定セグメント・明細の残高（日付・金額。取込の照合の起点で、帳簿の現預金には足さない）・メモ。Stripe の接続は S4。

### 4.6 取引先 `/settings/partners`

検索欄と表: 名前・カナ・区分（顧客 / 仕入先 / 両方 / その他）・登録番号（形式と法人番号のチェックデジットを検証。国税庁との照合は v2）・既定の科目・既定のセグメント・既定の税区分・状態。直接編集と追加行。

### 4.7 セグメント `/settings/segments`

表: コード・名前・状態。直接編集と追加。標準の 4 つは無効にできない。

### 4.8 タグ `/settings/memo-tags`

表: 名前・状態。追加・名前の編集・無効化。

## 5. データと層

- `Company` に `foundedOn`（設立日）と `invoiceRegisteredOn`（登録日）を足す（migration）。
- 標準データの投入（税区分・税率規則・セグメント・勘定科目テンプレート）は `packages/db/src/bootstrap.ts` にまとめ、seed もそれを使う（二重定義しない）。
- 第 1 期の導出 `deriveFirstFiscalYear(foundedOn, fiscalYearEndMonth)` と、法人番号のチェックデジット `isValidCorporateNumber` / 登録番号 `isValidInvoiceRegistrationNumber` は `packages/ledger` に置く（純粋関数・テスト付き）。
- 開始仕訳の組み立ては `packages/db/src/opening.ts`（入力 → `JournalEntryInput[]` の純粋関数と、登録の関数）。
- 設定の読み書きは `packages/db/src/settings.ts`（会社・会計期間・勘定科目・補助科目・税区分・口座・取引先・セグメント・タグ。すべて監査ログ）。

## 6. 受け入れ条件

Issue #3 の条件に加えて:

- ウィザードを途中で閉じて開き直しても続きから進める。
- 開始仕訳の登録後、試算表が「普通預金 50,000 / 資本金 50,000」「創立費 / 役員借入金」で一致する（ウィザードの入力例で）。
- 勘定科目・取引先・セグメント・タグが一覧の中で直接編集でき、保存の状態が行に出る。
- 320px でウィザードと設定の各節が操作できる。
- 書き込みはすべて監査ログに残る。

## 7. 全体検索（v2 #53）

取引・明細・証憑・取引先・請求を 1 つの検索で横断して開く（freee の画面上部の検索に当たる）。「あの支払いはどこにあったか」を、画面を回らずに探す。読むだけで、監査ログは増えない。検索は経理と管理者のもの（閲覧の役割には入口を出さず、`/search` と検索の Server Action も拒否する。[23 §3.4](23-users-and-expenses.md)）。

### 7.1 入口とキーボード

- PC: 左ナビのブランドの下に検索の欄（見た目は入力欄。押すと検索のパレットが開く。右端に「/」の印）。
- スマホ: 「その他」（`/more`）の上に検索の欄（GET フォームで `/search?q=` へ。JS がなくても使える）。
- パレット: 画面上部の中央に出る native `<dialog>`（PC は幅 560px、320〜767px は全幅で上寄せ）。上に入力欄、下に結果。入力は 200ms 待ってからサーバーに問い合わせる（古い応答は捨てる）。
- キー:

| キー | 動作 |
| --- | --- |
| `/` | パレットを開く。入力欄・dialog の中では効かない。明細の画面（`/statements`）では明細の検索欄へ送る（[15 §6](15-statements.md)。明細の画面のキーを優先） |
| Ctrl+K / ⌘K | どの画面でもパレットを開く（明細の画面を含む） |
| ↓ / ↑ | 結果を移る（種類の見出しをまたいで通しで。先頭と末尾で止まる。入力欄に焦点を置いたまま `aria-activedescendant` で示す） |
| Enter | 選んだ結果を開く（未選択なら最初の結果）。「すべて見る」も結果の 1 つとして選べる |
| Esc | パレットを閉じ、開く前の焦点に戻す |

- 入力欄は `role="combobox"`、結果は `role="listbox"` と `role="option"`（種類ごとに `role="group"` と見出し）。

### 7.2 対象と一致の仕方

| 種類 | 対象の項目 | 開く先 | すべて見る |
| --- | --- | --- | --- |
| 取引 | 摘要・行の摘要・No.・金額（借方合計） | `/entries/[id]` | 文字: `/entries?from=…&to=…&q=…&status=all`（該当の最も古い日付〜最も新しい日付。日付の指定がないと一覧は今期だけになり件数が合わないため） / 金額・No.: `/search?q=…&kind=entry` |
| 明細 | 摘要・振込人・金額 | `/statements?status=<その明細の状態>&wallet=<口座>&q=<金額>`（その明細が出る一覧） | `/statements?q=…`（未処理のタブ） |
| 証憑 | 取引先名・元のファイル名・メモ・金額 | `/documents/[id]` | 文字: `/documents?tab=all&q=…` / 金額: `/documents?tab=all&amountMin=…&amountMax=…` |
| 取引先 | 名前・カナ・登録番号 | `/settings/partners?q=<名前>` | `/settings/partners?q=…` |
| 請求 | 番号・件名・取引先の名前・金額（合計） | `/invoices/[id]` | 文字: `/invoices?type=all&status=all&q=…`（一覧の既定は請求書だけのため、見積書・納品書も出す） / 金額: `/search?q=…&kind=invoice` |

- 問い合わせの読み方（`parseSearchQuery`）: NFKC で正規化し小文字にして前後の空白を除く。
  - 金額: 「1,650」「1650」「¥1,650」「￥1650」「1,650円」は金額 1,650（`|金額|` と一致）。
  - No.: 「No.12」「No 12」「no12」は取引の No. 12（全期間。会計期間が違えば複数）。数字だけ（「12」）は金額 12 と No. 12 の両方。
  - 登録番号: 「T」+ 13 桁は取引先の登録番号と一致（前方一致）。
  - それ以外は文字: 各項目の部分一致（正規化した値どうし。全角・半角・大文字小文字・カナの半角を区別しない）。1 文字だけの文字の問い合わせは結果を出さない（金額・No. は 1 文字でもよい）。
- 並び: 種類の中で日付の新しい順（取引は日付、明細は日付、証憑は取引年月日・なければ保存日、請求は発行日）。取引先は名前の順。取引の反対仕訳は出さない（取消済みの本体は「取消済み」を添えて出す）。無効の証憑と取引先は「無効」を添えて出す。
- 件数: パレットは種類ごとに上位 5 件と「すべて見る」（その種類の該当が 5 件より多いときだけ。件数を添える）。`/search?q=&kind=` はその種類を 50 件まで（「前へ / 次へ」）。
- 結果の 1 行: 取引「No. 12 · 2026/11/05 · クラウドサービス利用料 · 1,650」、明細「2026/12/27 · 架空カード · 口座振替 お支払い · 1,650 · 未処理」、証憑「receipt.pdf · 領収書 · 2026/11/07 · 3,980」、取引先「架空不動産株式会社 · 仕入先 · T…」、請求「INV-2026-0001 · 架空デザイン合同会社 · 330,000 · 送付済み」。金額は 3 桁区切り、単位は付けない。
- 何もないとき: 「「…」に合うものはありません。摘要の一部・金額・取引先名・請求番号で探せます」。

### 7.3 `/search`

- `/search?q=…`: パレットと同じ結果のページ（種類ごとに 5 件と「すべて見る」）。`kind=` で 1 種類を 50 件ずつ。PageHeader「検索」と検索の欄（GET フォーム）。スマホの入口とパレットの「すべて見る」の行き先。
- 結果は普通のリンクの並び（Tab で巡る）。

### 7.4 データと層

- migration（索引だけ）: `CREATE EXTENSION IF NOT EXISTS pg_trgm` と、検索する文字の列の式 `lower(normalize(列, NFKC))` への GIN（`gin_trgm_ops`）索引（`journal_entry.description`、`journal_line.description`、`wallet_transaction.description_raw` と `counterparty_raw`、`document.partner_name` と `original_name` と `note`、`partner.name` と `name_kana`、`invoice.number` と `title`）。金額の B-tree 索引は足さない（種類ごとの条件を UNION の別の枝にし、金額の枝は整数の比較だけで読む）。`pg_trgm` は 3 文字以上の部分一致で索引を使う（2 文字の日本語は全件を見るが、1 社の件数では 1 秒に収まる）。`pg_trgm` は Cloud SQL でも使える trusted な拡張で、DB の所有者が作れる。
- `packages/db/src/search.ts`: `parseSearchQuery(text)`（純粋）、`searchAll(db, text, { perKind })`（種類ごとに上位 n 件と件数）、`searchKind(db, text, kind, { page, pageSize })`。SQL は `$queryRaw`（パラメータで渡す。`%` `_` `\` はエスケープ）。読むだけ。
- `apps/web/components/app-shell/search/`: 入口（左ナビの欄）、パレット（client）、`/` と Ctrl+K のキー。結果は Server Action `searchAction(q)` で取る（読むだけ）。`apps/web/app/(app)/search/page.tsx`。
- テスト: `parseSearchQuery` の単体テスト、`search.db.test.ts`（フィクスチャの摘要の一部・金額・取引先名・請求番号・登録番号・No. のそれぞれで該当が出る、1 秒以内、監査ログが増えない、反対仕訳が出ない、`%` を含む問い合わせ）。
