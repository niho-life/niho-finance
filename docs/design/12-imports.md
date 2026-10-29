# 12. 明細の取込（S4 の画面仕様）

[05 画面と体験](05-ui-ux.md) §2.2 の「明細」に明細を供給する側の仕様です。S4（Issue #5）で作る「取込」の画面、CSV パーサ、Stripe の同期、ジョブの認証と、そのデータ・層を定めます。取り込んだ明細の片付け（登録・振替・無視・ルール）は S5、取込ファイルの証憑としての保存は S6、銀行 API は v2（#17）で、ここでは範囲外です。外部連携の方針は [04](04-integrations.md)、明細のモデルは [01 §2](01-domain-model.md)、Stripe の仕訳の型は [02 §4.2](02-accounting-rules.md)。

## 1. 画面

### 1.1 取込 `/imports`

取込の入口。口座ごとの状態と、取込の履歴を 1 ページに置く。

- 上: 取込できる口座の表。対象は有効な口座のうち種類が 銀行 / カード / Stripe / その他 のもの（現金・役員立替は手入力なので出さない）。列は 名前・種類・取込形式（自動判別 / 形式名 / 汎用 / Stripe 接続済み / 未接続）・最終取込（日時と「新規 n 件」）・操作。操作は、銀行・カード・その他が「CSV を取り込む」（→ `/imports/csv?wallet=<id>`）、Stripe が接続済みなら「同期」（その場で同期し、結果をトーストと履歴に出す）、未接続なら「接続する」（→ 設定）。各行の右端「設定」→ `/imports/wallets/<id>`。
- 下: 取込の履歴（新しい順 20 件）。列は 日時・口座・元（CSV / Stripe）・ファイル名（Stripe は期間）・新規 / 重複 / 失敗・状態（完了 / 失敗）。失敗の行は理由を 1 行で添える。行 → `/imports/<batchId>`。
- 空状態（05 §3.1。題と説明）: 口座がなければ 題「取り込める口座がありません」・説明「設定 › 口座 で銀行・カード・Stripe を登録します」。履歴がなければ 題「まだ取込がありません」・説明「上の口座の「CSV を取り込む」から始めます」。

### 1.2 CSV の取込 `/imports/csv`

1 ページで ファイル → プレビュー → 取込 と進む。状態はクライアントに持ち、サーバーへはファイルを毎回送る（プレビューと取込は同じファイルを別々の Server Action に渡す。途中の状態をサーバーに置かない）。

1. ファイル: 口座（`?wallet=<id>` を既定に、銀行・カード・その他から選ぶ）と、ドロップゾーン（クリックで選択もできる）。受け付けるのは `.csv` / `.txt`（`text/csv` / `text/plain` / 空の MIME）、10 MB まで。ファイルを選ぶと `previewCsvImportAction` でプレビューを取る。
2. プレビュー:
   - 形式: 自動判別の結果を select に入れて出す（口座に取込形式が保存されていればそれを使い、判別はしない）。候補は形式の一覧（§3.1）と「汎用」。変えるたびにプレビューを取り直す。判別できなかったときは「形式を判別できません。汎用を選んで列を対応づける」を出し、汎用を選ばせる。
   - 汎用の列対応: ファイルの先頭 20 行を表で見せ、その上の select で 日付・摘要・金額（符号付き）または 出金・入金・残高・相手 の列を選ぶ。ヘッダ行の数（既定 1）、「金額の正を出金として扱う」（カード明細の「利用金額」）、並び（自動 / 古い順 / 新しい順）。日付と摘要と、金額または出金・入金のどちらかが必須。
   - 数: 明細 n 行・失敗 n 行・取込済み n 行（DB にすでにある行）・期間（最初と最後の日付）・文字コード。ヘッダとトレーラがある形式は取引前後の残高。
   - 明細の表（先頭 20 行）: 日付・摘要・相手・金額・残高。失敗行の表: 行番号・理由・元の行。警告（残高の連続性 §3.4）。
   - 「この形式と列対応を口座に保存し、次回から使う」（既定 ON）。
   - 同じファイル（SHA-256 が一致）が取込済みなら「このファイルは YYYY/MM/DD に取り込み済みです」と履歴へのリンクを出し、「取り込む」を無効にする。明細が 0 行のときも無効にする。
3. 取込: 「取り込む」→ `importCsvAction` → `/imports/<batchId>` へ。失敗行があっても取り込める（失敗行は結果に残り、明細にはならない）。重複は数えるだけで、何も変えない。

### 1.3 取込の結果 `/imports/<batchId>`

- 概要: 口座・元（CSV / Stripe）・ファイル名（Stripe は取得した期間）・日時・新規 / 重複 / 失敗・状態。失敗した同期は理由を出す。
- 失敗行の表（行番号・理由・元の行）、警告の一覧。
- 導線: 「取込へ」。「明細を見る」は S5 まで非リンク（準備中）。

### 1.4 取込の設定 `/imports/wallets/<walletId>`

口座ごとの取込の設定。設定 › 口座 の口座そのもの（名前・科目・残高）はここでは変えない。

- 銀行・カード・その他: 取込形式（自動判別 / 各形式 / 汎用）。汎用のときは列対応（§1.2 と同じ入力。ファイルがないので列は番号で選ぶ）。「保存」。
- Stripe: 接続の欄に アカウント ID（`acct_` で始まる）と 鍵の名前（鍵を置いた環境変数の名前。鍵そのものは入れない・出さない。§4.1）。「保存」。接続済みなら 状態（最終同期・取得の起点〔カーソルの日付〕・直近の同期の結果）と「同期」「接続を外す」（確認ダイアログ。明細は残り、カーソルだけ消える）。
- 未接続の Stripe 口座は、ここで接続するまで同期できない。

### 1.5 導線

- 設定 › 口座（S2・共有）: 取込形式の列に形式名（銀行・カード・その他で未設定なら「自動判別」、Stripe は「Stripe 接続済み」/「未接続」、現金・役員立替は「—」）を出し、`/imports/wallets/<id>` へリンクする。ヘッダの右に「明細の取込 ›」（→ `/imports`）。口座のシート末尾の「取込形式（CSV・Stripe の接続）は明細の取込で設定します」をリンクにする。
- スマホの「その他」（`/more`。S3）: 「明細の取込」の行を足す（取引 と 設定 の間）。左ナビの 7 項目は増やさない（取込は月 1 回の作業で、明細と設定から入る）。
- 明細（S5）: ヘッダの「CSV 取込」「Stripe 同期」を `/imports/csv` と `/imports` へ結ぶ。
- ホーム（S7）: やることに「取込の失敗」「残高の警告」を出す。

## 2. 共通の決まり

- 読みは Server Components、書きは Server Actions。入力は Zod で検証し、書き込みは `packages/db` の `imports.ts` / `stripe-links.ts` を通して監査ログを残す（[10 §2](10-settings-and-setup.md) と同じ）。
- 取込は仕訳を作らない。明細は `status = pending` で入れるだけ。取込後の処理（ルールの自動登録）は S5 が差し込み点（§6.3）に足す。
- 文言: 骨格は 取込 / 同期 / 取込形式 / 汎用 / 履歴 / 結果。CTA は 取り込む / 同期 / 保存 / 接続を外す。形式のキー（`gmo_aozora_zengin` など）や `txn_` の ID は見せず、形式名と日付・金額で示す。
- 想定内の失敗（読めないファイル、鍵がない、Stripe の API エラー）は throw せず結果に出す。読めない行は取込を止めず、理由つきで結果に残す。
- 320px で ファイル選択・プレビューの数・「取り込む」・履歴 が欠けない。表はスマホで 2 段（日付と金額 / 摘要）。
- 金額は JPY の整数。Stripe の `amount` は最小単位で JPY は円そのもの。通貨が `jpy` でない balance transaction は失敗行にする。

## 3. CSV の取込

### 3.1 形式

形式ごとに 1 モジュール（`packages/importers/src/csv/formats/<key>.ts`）と、架空データのフィクスチャによるゴールデンテストを持つ。判別は先頭の数行（ヘッダ行やレコード区分）で行う。

| キー | 名前 | 対象 | 列（0 始まり） | 判別 | 備考 |
| --- | --- | --- | --- | --- | --- |
| `gmo_aozora_zengin` | GMO あおぞらネット銀行 全銀 CSV | 銀行 | 全銀協の入出金明細フォーマットをカンマ区切りにしたもの。レコード先頭の データ区分 で 1 ヘッダ / 2 データ / 8 トレーラ / 9 エンド。データ: 0 区分, 1 照会番号, 2 勘定日（和暦 YYMMDD）, 3 起算日, 4 入払区分（1 入金 / 2 出金）, 5 取引区分（10 現金 / 11 振込 / 14 振替 / 18 その他 / 19 訂正）, 6 取引金額, 7 うち他店券金額, 8〜12 未使用, 13 振込依頼人コード, 14 振込依頼人名, 15 仕向銀行名, 16 仕向店名, 17 摘要内容, 18 EDI 情報。ヘッダ: 3 作成日, 4・5 勘定日の自至, 6〜12 口座, 13 貸越区分, 14 取引前残高。トレーラ: 1・2 入金件数・合計, 3・4 出金件数・合計, 5 貸越区分, 6 取引後残高 | 1 行目の 0 列が `1` で 1 列が `03`、データ行の 0 列が `2` | 金額の符号は入払区分、残高はヘッダの取引前残高から行ごとに積み、トレーラの取引後残高と一致を確かめる。摘要は 摘要内容（空なら取引区分の名前）、相手は振込依頼人名、分類は取引区分の名前、起算日は valueDate。和暦は令和とみなす。列順は全銀協の仕様から起こしたもので、実ファイルで確定する（[04 §9](04-integrations.md)） |
| `docomo_smtb` | ドコモ SMTB ネット銀行（旧 住信 SBI ネット銀行） | 銀行 | `日付, 内容, 出金金額(円), 入金金額(円), 残高(円), メモ` | ヘッダ行がこの 6 列（空白と全角の違いは吸収） | 金額 = 入金 − 出金。摘要は内容、残高あり。並びは自動判定 |
| `rakuten_card` | 楽天カード（e-NAVI） | カード | `利用日, 利用店名・商品名, 利用者, 支払方法, 利用金額, 手数料/利息, 支払総額, ◯月支払金額, ◯月繰越残高, 新規サイン` | ヘッダ行の先頭 5 列が一致（`◯月` は可変なので見ない） | 金額 = −利用金額（カード口座は負債。利用は口座から見て出金）。摘要は利用店名・商品名、分類は支払方法、残高なし。利用日が空の行（合計など）は失敗行にせず読み飛ばす |
| `generic` | 汎用 | 銀行 / カード / その他 | 列対応（`GenericCsvConfig`）で指定 | 判別しない（選ぶ） | GMO あおぞら「当社 CSV」、三井住友カード、JCB など列が未確認の形式はこれで取り込み、実ファイルが揃ったら専用の形式を足す |

形式の一覧は `CSV_FORMATS` に並べ、画面の select と判別の順はこの配列の順。形式を足すときは モジュール・フィクスチャ・期待値 JSON・一覧への追加 の 4 点。

### 3.2 文字コードと表記のゆれ

- 文字コード: BOM を除き、UTF-8（`fatal`）で読めなければ Shift_JIS（`TextDecoder("shift_jis")`。cp932 の機種依存文字を含む）。どちらで読んだかをプレビューに出す。
- CSV: RFC 4180（ダブルクォート、`""` のエスケープ、引用内の改行、CRLF / LF / CR）。末尾の空行は無視。依存を増やさず自前の小さなパーサで読む（[06 §2](06-architecture.md)）。
- 日付: `YYYY/MM/DD`、`YYYY-MM-DD`、`YYYY.MM.DD`、`YYYY年MM月DD日`、`YYYYMMDD`、`R8.11.2` / `令和8年11月2日` / `H31.4.30`（元号つき和暦）。全角数字は半角に。月日の 1 桁も可。元号のない `YYMMDD` は全銀形式だけが読む（令和とみなす。西暦の `261102` を令和 26 年と読み違えないよう、汎用では受けない）。
- 金額: 3 桁区切りのカンマ、空白、`円` / `¥` / `＼`、全角数字、`+` を除き、負は `-` / `−` / `▲` / `△` / 括弧。小数は `.0` / `.00` だけ許す（JPY に小数はない）。空は「なし」。
- 文字列: 前後の空白を除く。摘要の全角・半角はそのまま残す（検索は S5）。

### 3.3 行の識別と重複

- `externalId` = `sha256("<txnDate>|<amount>|<descriptionRaw>|<counterpartyRaw>|<occurrence>")` の 16 進 64 桁。`occurrence` は同じファイルの中で (日付・金額・摘要・相手) が同じ行の、古い順の出現順（0 始まり）。残高は入れない（残高のない形式と汎用の列対応の違いで ID が変わらないように）。
- 重複は `(walletId, externalId)` の一意制約で弾き、「重複 n 件」として数える。同じファイルの再取込は SHA-256（`ImportBatch.fileSha256` の一意制約）で「取込済み」として止める。
- 限界: 1 日の途中で切れたファイル（同日の一部の行しか含まない）を重ねて取り込むと、同日同額同摘要の行の出現順がずれて重複を見逃すことがある。月初〜月末など日の境界で出力する運用にする。

### 3.4 残高の連続性

残高のある形式（全銀・住信 SBI・汎用で残高列を選んだとき）は、取りこぼしと重複を残高で検知する。警告であり、取込は止めない。

- ファイルの中: 古い順に `前の行の残高 + 金額 = この行の残高`。崩れた行を「n 行目で残高がつながりません」と出す。
- 前回との接続: 口座の最新の明細（日付が最も新しく、同日なら最後に取り込んだもの）の残高、それがなければ口座の「明細の残高」（`openingBalance` / `openingBalanceDate`。[10 §4.5](10-settings-and-setup.md)）を起点に、今回の最初の行とつながるかを見る。起点がなければ見ない。
- 全銀形式はトレーラの取引後残高と、ヘッダの取引前残高から積んだ残高の一致も見る。

### 3.5 失敗行

読めない行は `RowFailure`（行番号・理由・元の行）として `ImportBatch.failures` に残し、結果と履歴に出す。理由の例: 「日付が読めません」「金額が読めません」「列が足りません（n 列が要ります）」「通貨が円ではありません（usd）」。失敗行は明細にならない。全行が失敗なら取込を止める（取り込む行がない）。

## 4. Stripe の同期

### 4.1 接続

- Stripe の口座（`Wallet.kind = stripe`）は `StripeAccountLink` を 1 対 1 で持つ: `stripeAccountId`（`acct_` + 英数字。D4 の法人アカウントとその拠点アカウント）、`secretName`（鍵を置いた環境変数の名前。`NIHO_FINANCE_STRIPE_` で始まる大文字の英数字と `_`。ほかの秘密〔`DATABASE_URL` など〕を鍵として Stripe へ送らないため、この接頭辞以外は登録も読み出しもしない）、`syncCursor`、`lastSyncedAt`。アカウント ID は DB にだけ置く。
- 鍵の解決: `loadRootEnv()` の後に `process.env[secretName]`。ローカルは `.env`（コミットしない）、本番は Cloud Run の `--set-secrets` で Secret Manager の秘密を同名の環境変数に結ぶ（S8）。鍵の値はログ・監査ログ・画面に出さない。
- 鍵は読み取り専用の制限付きキー（`rk_`。Balance transactions の読み取り。あれば Payouts / Charges の読み取り）。法人アカウント（D4）ができるまではテストモードの `rk_test_` を使う。本番の鍵は本番の環境にだけ置く。
- 1 アカウント 1 鍵。`Stripe-Account` ヘッダーで連結アカウントを platform の鍵で読む方法は `createStripeBalanceTransactionSource` の `stripeAccount` で用意するだけで、画面には出さない（Organizations の組織キーは v2）。

### 4.2 取得

- `balance_transactions.list`（`limit: 100`、`created[gte]`、`starting_after` でページング、`has_more` が false になるまで）。既定の並びは新しい順。
- 取得の起点: カーソルがあればその `created` から 7 日戻した時刻（取りこぼしを重ねて拾う。重複は externalId で弾くので冪等）。カーソルがなければ口座の「明細の残高の日付」（JST 00:00）、それもなければ全期間。
- カーソル: 取得した中で最も新しい `created` と ID を JSON `{"created":<unix>,"id":"txn_…"}` で `syncCursor` に保存し、`lastSyncedAt` を更新する。失敗したときはどちらも変えない。
- `available_on` が未来（`status = pending`）のものも取り込み、`valueDate` に入れる（入金待ちを表す）。
- 1 回の同期 = 1 `ImportBatch`（`source = stripe`、`importer = stripe`、`periodFrom` / `periodTo` は取得した明細の日付の範囲）。新しい明細も新しい失敗もなければ `ImportBatch` は作らず、`lastSyncedAt` と監査ログだけ更新する（7 日の重ね読みで毎日「新規 0」の履歴が増えないように）。
- 失敗（通貨が円でないなど）は、カーソルより後に作られた取引の分だけ記録する。重ね読みした分は、最初に読んだ同期が記録済み。失敗行の「元の行」は 日付・金額と通貨・摘要。

### 4.3 変換

[04 §1.2](04-integrations.md) のとおり、1 件の balance transaction から 総額の行 と 手数料の行 を作る。分類は `type` ではなく `reporting_category`。

| 行 | externalId | amount | category | descriptionRaw | 条件 |
| --- | --- | --- | --- | --- | --- |
| 総額 | `<bt.id>` | `bt.amount` | `reporting_category` | 分類の名前（下表）＋ `bt.description` | `amount ≠ 0`、または手数料の行がないとき |
| 手数料 | `<bt.id>:fee` | `−bt.fee` | `fee` | 「手数料 · 」＋ 総額の行の摘要 | `bt.fee ≠ 0` |

- 日付: `txnDate` は `created` の JST の暦日、`occurredAt` は `created` の時刻（UTC の暦日はここから導く。Stripe の月次の適格請求書は UTC の月で締まる）、`valueDate` は `available_on` の JST の暦日。
- `raw` には balance transaction をそのまま（`source` は ID だけ）。手数料の行の `raw` は `{ balanceTransactionId, feeDetails }`。手数料の税抜と消費税額が `fee_details`（`type = tax`）で分かれて来る場合はそこに残り、S5 の仕訳生成が使う（分かれて来ない場合は税込の手数料から内税を計算する。[04 §1.3](04-integrations.md)）。
- `amount = 0` かつ `fee = 0` は読み飛ばす（結果にも数えない）。`currency ≠ jpy` は失敗行。
- 分類の名前: `charge` / `payment` 決済、`refund` / `payment_refund` 返金、`refund_failure` 返金の失敗、`dispute` チャージバック、`dispute_reversal` チャージバックの取消、`fee` 手数料、`payout` 入金（銀行へ）、`payout_reversal` 入金の戻り、`platform_earning` プラットフォーム手数料、`platform_earning_refund` プラットフォーム手数料の返金、`transfer` 振替、`transfer_reversal` 振替の取消、`topup` チャージ、`adjustment` 調整、`risk_reserved_funds` 留保、`other_adjustment` その他の調整。表にないものは `reporting_category` をそのまま出す。
- 2 アカウント（platform と拠点）は口座が別なので、`(walletId, externalId)` の一意性はアカウントをまたいで保たれる。

### 4.4 手動の同期とジョブ

- 手動: `/imports` と取込の設定の「同期」。Server Action `syncStripeAction(walletId)` が同期して結果（新規 / 重複 / 失敗、または理由）を返す。
- ジョブ: `POST /api/jobs/stripe-sync`。`verifyJobRequest`（§5）を通った要求だけ受け、接続済みの有効な Stripe 口座を順に同期し、`{ ok, wallets: [{ walletId, ok, importedCount, duplicateCount, failedCount, error }] }` を 200 で返す。認証に失敗したら 401 / 403。同期の失敗で 5xx を返さない（再試行の嵐を避ける。[06 §4](06-architecture.md)）。`GET` は 405。
- Cloud Scheduler は毎日 06:00 JST（S8 が作る。OIDC のサービスアカウントと audience は §5 の環境変数）。
- 同期の失敗（鍵がない、API の認証エラー、レート制限、通信エラー）は `ImportBatch.error` に理由を残し、`/imports` の履歴に「失敗」として出す。メールの通知は S8。

## 5. ジョブの認証 `apps/web/lib/jobs/auth.ts`

Cloud Scheduler からの OIDC トークンだけを受け付ける検証。S8 の `backup-export` / `calendar-notify` と v2 のジョブも同じ関数を使う。

- `verifyJobRequest(request, options?)` → `{ ok: true, principal: string } | { ok: false, status: 401 | 403 | 503, reason: string }`。
- `Authorization: Bearer <JWT>` を取り、ヘッダの `alg = RS256` と `kid` から Google の JWKS（`https://www.googleapis.com/oauth2/v3/certs`。`Cache-Control: max-age` の間はキャッシュ、なければ 1 時間）で署名を検証する（`node:crypto` の `createPublicKey({ format: "jwk" })` と `verify`。依存は足さない）。
- 検証する claim: `iss` が `https://accounts.google.com` または `accounts.google.com`、`aud` が `NIHO_FINANCE_JOB_AUDIENCE` と一致、`exp` が現在（60 秒の猶予）より後、`iat` が現在 + 60 秒より前、`email` が `NIHO_FINANCE_JOB_SERVICE_ACCOUNT` と一致し `email_verified` が true。
- 環境変数が未設定なら 503（「ジョブの認証が設定されていません」）。ローカル（`NIHO_FINANCE_ENV ≠ prod`）では `NIHO_FINANCE_JOB_TOKEN` を Bearer に入れた要求も通す（手元で `curl` するため。本番では無視する）。
- テスト: テストの中で RSA の鍵対を作り、JWKS の取得を差し替えて 署名・aud・exp・email の各失敗を確かめる（`apps/web` に vitest を足す）。

## 6. データと層

### 6.1 列の追加（migration `*_imports`。テーブルは足さない）

| テーブル | 列 | 内容 |
| --- | --- | --- |
| `wallet` | `importer_config jsonb?` | 汎用形式の列対応（`GenericCsvConfig`）。`importer` は既存（形式のキー、`stripe`、v2 は銀行 API のキー） |
| `wallet_transaction` | `value_date date?` | 起算日（全銀）/ `available_on`（Stripe）の JST 暦日 |
| | `occurred_at timestamptz?` | 取引の時刻（Stripe の `created`）。CSV は null |
| | `category text?` | 元の分類（Stripe の `reporting_category`、全銀の取引区分の名前、カードの支払方法）。S5 のルールと入金照合が使う |
| | `raw jsonb?` | 元の行（CSV は文字列の配列、Stripe は balance transaction） |
| `import_batch` | `original_name text?` | 元のファイル名 |
| | `file_bytes bytea?` | 取り込んだファイルそのもの。S6 が証憑（`statement`）に移して `document_id` を結び、その後の migration でこの列を落とす（expand → contract）。電子取引データの保存対象（[03 §3.2](03-compliance.md)）を S6 まで失わないために持つ |
| | `failures jsonb?` | `RowFailure[]` |
| | `warnings jsonb?` | `string[]`（残高の連続性など） |
| | `error text?` | 同期そのものが失敗した理由。null なら完了 |
| | `period_from date?` / `period_to date?` | 取り込んだ明細の日付の範囲 |

`ImportBatch.fileSha256` は CSV だけ持つ（Stripe は null。一意制約は null を数えない）。監査ログのスナップショットに `file_bytes` と `raw` は入れない。

### 6.2 `packages/importers`（純粋。DB を知らない）

```ts
export type ImportSource = "csv" | "stripe" | "api";

export interface WalletTransactionDraft {
  externalId: string;
  txnDate: CalendarDate;
  valueDate?: CalendarDate | null;
  occurredAt?: Date | null;
  amount: Money;                    // 符号付き。口座から見て入金が正
  descriptionRaw: string;
  counterpartyRaw?: string | null;
  balanceAfter?: Money | null;
  category?: string | null;
  raw?: unknown;                    // JSON にできる値
}

export interface RowFailure { rowNumber: number; reason: string; raw?: string[] }

export interface ParsedStatement {
  format: CsvFormatKey;
  rows: WalletTransactionDraft[];   // 古い順。externalId を付与済み
  failures: RowFailure[];
  warnings: string[];
  openingBalance: Money | null;     // ヘッダ（全銀）
  closingBalance: Money | null;     // トレーラ（全銀）
  period: { from: CalendarDate; to: CalendarDate } | null;
}

export interface GenericCsvConfig {
  headerRows: number;               // 既定 1
  columns: {
    date: number; description: number;
    amount?: number;                // 符号付き（入金が正）
    deposit?: number; withdrawal?: number;
    balance?: number; counterparty?: number;
  };
  invertSign?: boolean;             // 符号付きの列の正を出金として扱う
  order?: "asc" | "desc" | "auto";  // 既定 auto
}

export type CsvFormatKey = "gmo_aozora_zengin" | "docomo_smtb" | "rakuten_card" | "generic";
export interface CsvFormat {
  key: CsvFormatKey; label: string; walletKinds: readonly WalletKind[];
  detect(table: string[][]): boolean;                                   // generic は常に false
  parse(table: string[][], config: GenericCsvConfig | null): ParsedStatement; // externalId なし
}
export const CSV_FORMATS: readonly CsvFormat[];
export const CSV_FORMAT_LABELS: Readonly<Record<CsvFormatKey, string>>;
export function decodeCsvBytes(bytes: Uint8Array): { text: string; encoding: "utf-8" | "shift_jis" };
export function parseCsvTable(text: string): string[][];
export function detectCsvFormat(table: string[][]): CsvFormatKey | null;
export function parseStatement(input: { table: string[][]; format: CsvFormatKey; config?: GenericCsvConfig | null }): ParsedStatement;
export function checkBalanceContinuity(rows: readonly WalletTransactionDraft[], start: Money | null): string[];
export function sha256Hex(bytes: Uint8Array | string): string;
export function parseStatementDate(text: string): CalendarDate | null;   // §3.2 の表記
export function parseStatementAmount(text: string): Money | null;

// Stripe
export interface StripeBalanceTransaction { /* id, amount, fee, net, currency, created, available_on, reporting_category, type, description, status, source (ID), fee_details[] */ }
export interface BalanceTransactionPage { data: StripeBalanceTransaction[]; hasMore: boolean }
export interface BalanceTransactionSource {
  list(params: { createdGte?: number; startingAfter?: string; limit: number }): Promise<BalanceTransactionPage>;
}
export function createStripeBalanceTransactionSource(options: { apiKey: string; stripeAccount?: string | null }): BalanceTransactionSource; // 公式 SDK
export function fetchBalanceTransactions(source: BalanceTransactionSource, params: { createdGte?: number }): Promise<{ transactions: StripeBalanceTransaction[]; newest: { created: number; id: string } | null }>;
export function convertBalanceTransaction(bt: StripeBalanceTransaction, options?: { timeZone?: string }): { rows: WalletTransactionDraft[]; failure: RowFailure | null };
export const STRIPE_CATEGORY_LABELS: Readonly<Record<string, string>>;
export function parseSyncCursor(text: string | null): { created: number; id: string } | null;
```

- `parseStatement` が externalId の付与・古い順の並べ替え・ファイル内の残高の連続性（警告）を担う。形式モジュールは行の読み取りだけ。
- Stripe の取得は `BalanceTransactionSource` を差し替えられるようにし、テストはフィクスチャ（架空の 2 アカウント分）を返す source で行う。

### 6.3 `packages/db`（`imports.ts` / `stripe-links.ts`）

```ts
// imports.ts
export interface ImportableWallet { id; name; kind; importer: string | null; importerConfig: GenericCsvConfig | null; stripe: { connected: boolean; lastSyncedAt: Date | null } | null; lastBatch: ImportBatchSummary | null }
export interface ImportBatchSummary { id; walletId; walletName; source; importer; originalName; periodFrom; periodTo; rowCount; importedCount; duplicateCount; failedCount; error; executedAt; executedBy }
export interface ImportBatchDetail extends ImportBatchSummary { failures: RowFailure[]; warnings: string[] }
export interface CsvImportPreview { walletId; fileName; fileSha256; byteSize; encoding; format: CsvFormatKey | null; detectedFormat: CsvFormatKey | null; config: GenericCsvConfig | null; table: string[][] /* 先頭 20 行 */; columnCount; rows: PreviewRow[] /* 先頭 20 行 */; rowCount; duplicateCount; failures; warnings; period; openingBalance; closingBalance; alreadyImported: { batchId; executedAt } | null }
export interface ImportOutcome { batchId: string | null; walletId; source; rowCount; importedCount; duplicateCount; failedCount; warnings: string[]; error: string | null }
/** 取込後の処理の差し込み点。S5 がルールの自動登録を渡す。同じトランザクションの中で呼ぶ */
export type AfterImportHook = (tx: Tx, batch: { id: string; walletId: string; source: ImportSource; transactionIds: string[] }, options: { actor: string }) => Promise<void>;
export interface ImportOptions { actor: string; afterImport?: AfterImportHook }

export function listImportableWallets(db): Promise<ImportableWallet[]>;
export function listImportBatches(db, options: { walletId?: string; limit?: number }): Promise<ImportBatchSummary[]>;
export function getImportBatch(db, id): Promise<ImportBatchDetail | null>;
export function updateWalletImporter(db, input: WalletImporterInput, options: { actor }): Promise<ImportableWallet>; // wallet.update_importer
export function previewCsvImport(db, input: CsvImportInput): Promise<CsvImportPreview>;                       // 書かない
export function importCsv(db, input: CsvImportInput & { rememberFormat: boolean }, options: ImportOptions): Promise<ImportOutcome>; // import_batch.import
export function insertWalletTransactions(tx, params: { walletId; importBatchId; drafts }): Promise<{ created: string[]; duplicateCount: number }>; // (walletId, externalId) で重複を数える
export function finishImportBatch(tx, batch, created: string[], options: ImportOptions): Promise<void>; // 差し込み点を呼ぶ唯一の場所

// stripe-links.ts
export function getStripeAccountLink(db, walletId): Promise<StripeAccountLinkSettings | null>;
export function saveStripeAccountLink(db, input: StripeAccountLinkInput, options: { actor }): Promise<StripeAccountLinkSettings>; // stripe_account_link.create / .update
export function removeStripeAccountLink(db, input: { walletId }, options: { actor }): Promise<void>;         // stripe_account_link.delete
export function resolveStripeApiKey(secretName: string, env?: NodeJS.ProcessEnv): string | null;
export function syncStripeWallet(db, input: { walletId: string; now?: Date }, options: ImportOptions & { source?: BalanceTransactionSource }): Promise<ImportOutcome>; // import_batch.sync。失敗は error に
export function syncAllStripeWallets(db, options: ImportOptions): Promise<ImportOutcome[]>;
```

- `CsvImportInput` は `{ walletId, fileName, bytes: Uint8Array, format?: CsvFormatKey | null, config?: GenericCsvConfig | null }`。入力の Zod スキーマ（`walletImporterInputSchema`・`genericCsvConfigSchema`・`stripeAccountLinkInputSchema`・`csvImportInputSchema`）は `schemas.ts` に追記する。
- `importCsv` は 1 トランザクションで ImportBatch の作成（`fileSha256` の一意制約で取込済みを弾く）→ 明細の挿入（`createMany` + `skipDuplicates`。重複は挿入前の照会で数える）→ `rememberFormat` なら口座の `importer` / `importerConfig` の保存 → `finishImportBatch`（差し込み点）→ 監査ログ。
- `syncStripeWallet` は 接続と鍵の解決 → 取得 → 変換 → 挿入 → カーソルの更新 を行い、取得や鍵の失敗は `ImportBatch`（`error` 入り）を記録して `{ error }` で返す（throw しない）。
- 監査ログの action: `import_batch.import`、`import_batch.sync`、`wallet.update_importer`、`stripe_account_link.create` / `update` / `delete`。`after` のスナップショットに `fileBytes` と鍵は入れない。
- 依存: `db` が `importers` に依存する（取込の変換と判別のため）。`importers` は `db` を知らない。`apps/web` の `transpilePackages` に `@niho-finance/importers` を足し、Server Actions の `bodySizeLimit` を 10 MB にする。

### 6.4 環境変数

| 変数 | 用途 |
| --- | --- |
| （`secretName` が指す名前。例 `NIHO_FINANCE_STRIPE_KEY_PLATFORM`） | Stripe の制限付きキー。ローカルは `.env`、本番は Secret Manager から結ぶ |
| `NIHO_FINANCE_JOB_AUDIENCE` | OIDC トークンの `aud`（Cloud Scheduler に設定した値。ジョブの URL） |
| `NIHO_FINANCE_JOB_SERVICE_ACCOUNT` | Cloud Scheduler が使うサービスアカウントのメール |
| `NIHO_FINANCE_JOB_TOKEN` | ローカル専用の Bearer。本番では無視 |

`.env.example` にコメントつきで並べる（値は書かない）。

## 7. 受け入れ条件

Issue #5 の条件に加えて:

- 各形式のゴールデンテストが通り、同じ CSV の再取込は「取込済み」で止まり（新規 0）、重なる期間の別ファイルは重複 n 件・新規 m 件になる。
- Stripe の架空フィクスチャ（2 アカウント）から、総額・手数料・入金が別行の明細になり、同じフィクスチャの再同期で新規 0 件。
- 汎用 CSV の列対応を口座に保存すると、次回は判別なしにその対応でプレビューが出る。
- 失敗行が行番号・理由・元の行つきで結果と履歴に出る。
- 残高がつながらないファイルで警告が出て、取込は止まらない。
- `/api/jobs/stripe-sync` はトークンなし・署名が違う・`aud` が違う・期限切れ・別のメール のそれぞれで拒み、正しいトークンで 200。
- 320px で取込の各画面が操作できる。書き込みはすべて監査ログに残る。

## 8. 引き渡し

- S5（#6）: `finishImportBatch` の `afterImport` にルールの自動登録を渡す。`category` と `valueDate` を入金照合（payout と銀行の入金）と推定に使う。明細のヘッダに「CSV 取込」「Stripe 同期」の導線を足す。
- S6（#7）: `ImportBatch.fileBytes` / `fileSha256` / `originalName` を証憑（`statement`）にして `documentId` を結び、`file_bytes` を落とす。→ 結線済み（S6 の PR #27）: CSV の取込の直後に証憑にして `fileBytes` を空にする。列を落とすのは、本番で全件が空になったのを確かめた後の migration。
- S7（#8）: ホームのやることに取込の失敗と残高の警告、口座カードに最終取込。
- S8（#9）: Cloud Scheduler（06:00 JST、OIDC）、Secret Manager の鍵、失敗のメール。`verifyJobRequest` を他のジョブでも使う。
- v2 #17（銀行 API）: 同じ `WalletTransactionDraft` と `insertWalletTransactions` を `source = api` で使う。
