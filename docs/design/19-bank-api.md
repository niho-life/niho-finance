# 19. 銀行 API（GMO あおぞらネット銀行の入出金明細の同期）

v2 #17 の仕様です。法人口座（[D3](../decisions/2026-10-28-bank-gmo-aozora.md)）の入出金明細を API で取り込み、CSV の手作業をなくします。取込の土台（`WalletTransactionDraft`・`insertWalletTransactions`・`finishImportBatch`・ジョブの認証）は S4 の [12](12-imports.md)、明細の片付けは S5 の [15](15-statements.md)、残高の差異の表示は S7 の [14 §6・§9](14-reports.md)。外部連携の方針は [04 §2.3](04-integrations.md)。v1 の間は CSV（12 §3）で取り込み、口座開設と API 契約（最大 2 か月）の後にこの接続へ切り替えます。開発は sunabar（GMO あおぞらの API 実験場）と架空のレスポンスのゴールデンテストで進めます。

範囲外: 振込・総合振込などの更新系 API、振込入金口座（バーチャル口座。請求ごとの消込は [18](18-invoicing.md) の手動消込で足りる）、Webhook（sunabar に無く、日次の同期で足りる）、全銀形式の明細 API（`/accounts/transactions/zengin-format`。取引区分と EDI が要る段階で足す）。

## 1. 画面

### 1.1 銀行 API の接続 `/settings/wallets/<walletId>/bank`

設定 › 口座 の下の 1 ページ。種類が 銀行 の口座だけが開ける（それ以外は 404）。上から 状態 → 操作 → 直近の同期。

- **未設定**（環境変数がない。§5）: 「銀行 API が設定されていません。環境変数を設定してから接続する」と、要る変数の名前（値は出さない）。操作はない。
- **未接続**: 「GMO あおぞらネット銀行の API で入出金明細を毎日取り込みます。接続すると CSV の取込は要りません」と「接続する」。
  - 認可（OAuth）の環境では「接続する」が銀行の認可画面へ移る（§2.2）。戻ると「口座の選択」になる。
  - sunabar のトークン（§2.1）の環境では、その場でトークンを確かめて「口座の選択」になる。
- **口座の選択**（認可済み・口座が未選択）: API の口座一覧のうち円普通預金（科目コード 01 / 02）を radio で出す。表記は「支店名 科目名 末尾 4 桁」（例「法人第一営業部 普通預金（有利息） ••••4567」。口座 ID と口座番号の全桁は出さない）。「この口座を接続する」で保存し、そのまま最初の同期（§3.1）を行って結果を出す。円普通預金が 1 つもなければ「接続できる円普通預金の口座がありません」。ほかの口座にすでに接続した銀行口座は選べない（「「<口座名>」に接続済み」と添えて disabled）。
- **接続済み**: 状態の表 — 口座（上の表記）・環境（sunabar / 検証 / 本番）・最終同期（日時）・取得済みの期間（「〜 YYYY/MM/DD」）・銀行の残高（金額と基準日）。残高の差異そのものは ホームの口座カードと 報告 › 現預金 に出す（§4）。操作は「今すぐ同期」（結果を「新規 n 件・重複 n 件・失敗 n 件」または失敗の理由で、ページの上とトーストに出す）と「接続を外す」（確認ダイアログ「接続を外します。取り込んだ明細は残ります。もう一度つなぐには、銀行の認可からやり直します」）。
- **再接続が必要**（トークンの失効・認可の取消。§2.4）: 警告の帯「銀行 API の認可が切れています。再接続すると、前回の続きから取り込みます」と理由（1 行）、「再接続する」。認可の環境は銀行の認可画面へ、トークンの環境は「sunabar にログインしてトークンを確かめ、環境変数を差し替えてから「再接続する」」と添え、押すとトークンを確かめ直す。接続の口座と取得済みの期間は残すので、再接続の後の同期は取りこぼさない。
- **直近の同期**: この口座の銀行 API の取込（`source = api`）の新しい順 5 件。列は 日時・期間・新規 / 重複 / 失敗・状態（完了 / 失敗と理由）。行 → `/imports/<batchId>`（S4 の結果画面）。新規 0 件の同期は履歴を作らない（§3.4）ので、最終同期の日時で動いていることを示す。
- 320px: 状態の表は 2 段（見出しと値）、ボタンは全幅で縦に並べ、radio の行は折り返す。

### 1.2 導線（追記）

- 設定 › 口座（S2・S4 の表）: 種類が 銀行 の口座は、取込形式の列に接続の状態（「銀行 API 接続済み」「再接続が必要」〔警告色〕「口座の選択待ち」）を出し、`/settings/wallets/<id>/bank` へリンクする。未接続なら今までどおり CSV の形式名で `/imports/wallets/<id>` へ。口座のシート（銀行のときだけ）の末尾に「銀行 API の接続（GMO あおぞらネット銀行）は 銀行 API の接続 で行います」をリンクで足す。
- ホーム（S7）: やることに「銀行 API の再接続」（警告。件数、1 口座ならその接続ページ、複数なら 設定 › 口座）を足す。口座カードは、再接続が必要な口座に「再接続が必要」を出し、接続ページへ結ぶ。最終同期は Stripe と同じ欄に銀行 API の最終同期も入れる。
- 取込 `/imports`（S4）: 銀行 API の取込は履歴に「銀行 API」として出る（S4 の表示のまま。画面は変えない）。

## 2. 認証と鍵

### 2.1 2 つの方式

| 方式 | 使う環境 | アクセストークン |
| --- | --- | --- |
| 認可（OAuth 2.0 ＋ OpenID Connect の Authorization Code フロー） | 検証（`stg`）・本番（`prod`）。sunabar の「認可利用」も URL を与えれば使える（§5） | 認可コード → アクセストークン ＋ リフレッシュトークン。DB に暗号化して置く（§2.3） |
| トークン | sunabar（既定） | sunabar ポータルの「開発者向け」で発行したものを環境変数に置く。リフレッシュしない（ポータルに 30 日ログインしないと失効） |

`NIHO_FINANCE_GMO_AOZORA_CLIENT_ID` があれば認可、なく `NIHO_FINANCE_GMO_AOZORA_ACCESS_TOKEN` があればトークン、どちらもなければ未設定。API の呼び出しはどちらも `x-access-token` ヘッダ。

### 2.2 認可の流れ

1. 「接続する」/「再接続する」→ `GET /api/bank/gmo-aozora/authorize?wallet=<id>`（画面のサービス。IAP の内側）。`state` と `nonce`（各 32 バイトの乱数）を作り、`{ walletId, state, nonce, issuedAt }` を httpOnly の cookie（`niho_bank_oauth`、Path `/api/bank/gmo-aozora`、SameSite=Lax、本番は Secure、10 分）に置いて、認可エンドポイントへ 302。
   - `GET {authBase}/authorization?response_type=code&client_id=…&redirect_uri=…&scope=openid offline_access private:account&state=…&nonce=…`。`offline_access` がないとリフレッシュトークンが出ない。`private:account` は口座（一覧・残高・入出金明細）の照会。
2. 銀行の画面で認可 → `GET /api/bank/gmo-aozora/callback?code=…&state=…`（`redirect_uri`。GMO に事前登録する。§5）。cookie の `state` と一致しなければ 400（cookie は消す）。`error` が来たら（`access_denied` など）接続ページへ戻して「銀行の認可が完了しませんでした」を出す。
3. トークンエンドポイント `POST {authBase}/token`（`grant_type=authorization_code`・`code`・`redirect_uri`）。クライアント認証は既定 `client_secret_basic`（Authorization: Basic）。GMO に `client_secret_post` で登録したときは `NIHO_FINANCE_GMO_AOZORA_CLIENT_AUTH=post`（`client_id`・`client_secret` を本文に）。
4. ID Token の検証（GMO の仕様どおり）: `alg = HS256` で、クライアントシークレットを鍵にした HMAC-SHA256 の署名が一致（`timingSafeEqual`）、`iss` が環境の発行元（本番 `https://api.gmo-aozora.com`・検証 `https://stg-api.gmo-aozora.com`。末尾の `/` の有無は問わない）、`aud` にクライアント ID、`azp` がクライアント ID、`exp` が現在より後、`iat` が現在 − 600 秒以降、`nonce` が cookie の値と一致。どれかが違えば接続しない（「銀行の応答を確かめられませんでした」）。
5. トークンを暗号化して口座に保存し（状態 `authorized`）、cookie を消して接続ページ（口座の選択）へ 302。

コールバックは口座によらず 1 つの URL（`state` の cookie が口座を運ぶ）。認可の途中の状態をサーバーに置かない。

### 2.3 トークンの置き場と更新

- 置き場: 口座の `bank_api_tokens` に `{ accessToken, refreshToken, accessTokenExpiresAt, scope }` を AES-256-GCM で暗号化した文字列（`v1.<iv>.<tag>.<本文>`、各 base64url）。鍵は `NIHO_FINANCE_BANK_TOKEN_KEY`（32 バイトの base64。本番は Secret Manager から結ぶ）。クライアント ID・シークレットも環境変数（本番は Secret Manager）。決定と理由は [決定記録](../decisions/2026-10-28-bank-api-token-storage.md)。
- トークン・口座 ID・クライアントシークレットはログ・監査ログ・画面・バックアップ（S7 の `settings.json`）に出さない。
- 更新: 呼び出しの前に `accessTokenExpiresAt − 5 分 ≤ 現在` なら、`grant_type=refresh_token` で更新する。API が 401 を返したときも 1 回だけ更新して呼び直す。応答に新しい `refresh_token` があれば差し替える（なければ前のものを使い続ける）。リフレッシュ時の ID Token は `nonce` を持たないので検証しない（トークンエンドポイントへの TLS の直接の応答として扱う）。
- 同時の更新（手動の「今すぐ同期」とジョブが重なる）: 保存は「読んだときの暗号文と同じなら書く」の比較つき更新にし、負けた側は保存済みのトークンを読み直して使う（リフレッシュトークンが 1 回限りでも、もう一方を失効させない）。

### 2.4 失効と再接続

- 次は 再接続が必要（状態 `reauth_required`）にする: トークンエンドポイントが `invalid_grant` / `invalid_client` / 401 を返す、更新後もなお API が 401、トークンの方式で API が 401、口座に保存した環境と今の環境が違う（sunabar で接続した口座を本番で同期しようとした）、暗号鍵で復号できない（鍵の差し替え）。暗号鍵そのものがない・形式が違うのは設定の問題で、再接続にはせず失敗として記録する。
- このとき同期は失敗として `ImportBatch`（`error` 入り）を記録し、口座の `bank_api_error` に理由を残して終える（throw しない。ジョブは 200）。監査ログ `wallet.require_bank_reauth`。
- 再接続（§1.1）が成功すると状態を `connected` に戻し、`bank_api_error` を消す。同じ環境なら口座と取得済みの期間は変えない。別の環境で認可し直したときは（sunabar の口座 ID は本番の一覧にない）、口座と取得済みの期間を消して「口座の選択」に戻す。
- 429（`WG_ERR_154`。利用上限）・5xx・通信の失敗は再接続にしない。失敗として記録し、次の同期で取り直す（取得済みの期間を進めないので取りこぼさない）。

## 3. 同期

### 3.1 取得の期間

すべて JST の暦日。`dateTo` は今日。

| 場合 | `dateFrom` |
| --- | --- |
| 最初の同期で、口座に明細がある（CSV で取り込んできた） | 最新の明細の日付 − 3 日 |
| 最初の同期で、口座に明細がない | 今日 − 29 日（30 日分） |
| 2 回目以降 | 取得済みの期間の末日（`bank_api_synced_through`）− 3 日 |

- どの場合も口座の「明細の残高の日付」（`openingBalanceDate`）より前には戻らない（S4 の Stripe と同じく、その日を含む）。
- 3 日の重ねは、銀行の当日分の追記・訂正と、前回の同期の後に届いた分を拾うため。重ねて読んだ行は §3.3 で弾くので冪等。
- 成功したら取得済みの期間の末日を応答の基準日（`baseDate`。ふつう今日）に進め、最終同期の日時を記録する。失敗したら どちらも変えない。

### 3.2 取得と変換

- `GET {apiBase}/accounts/transactions?accountId=…&dateFrom=…&dateTo=…`。応答の `hasNext` が true の間、同じ要求に `nextItemKey` を足して次の 500 件を取る。同じ `nextItemKey` が 2 度来たら、または 200 ページを超えたら失敗にする（無限の繰り返しを避ける）。並びは取引の昇順（仕様）。日付が逆転していたら日付で安定に並べ直す。
- `currencyCode` が `JPY` でなければ同期ごと失敗（「円の口座ではありません」）。
- 1 件の明細 → 1 行の `WalletTransactionDraft`:

| 項目 | 値 |
| --- | --- |
| `externalId` | `itemKey`（口座ごとの明細キー。μs のタイムスタンプ。数字だけの最大 24 桁なので CSV の 64 桁の 16 進と衝突しない） |
| `txnDate` / `valueDate` | `transactionDate` / `valueDate`（`YYYY-MM-DD`） |
| `amount` | `transactionType` 1 = 入金で `+amount`、2 = 出金で `−amount`（`amount` は「マイナス含む」半角数字の文字列。訂正の負の値もそのまま符号に掛ける） |
| `descriptionRaw` | `remarks`（前後の空白を除く）。ないときは「入金」/「出金」 |
| `counterpartyRaw` | null（API の摘要は振込依頼人名を含む 1 本の文字列で、分けられない） |
| `balanceAfter` | `balance`（取引後残高） |
| `category` | null（取引区分は全銀形式の API にだけある） |
| `occurredAt` | null（`itemKey` は登録の時刻で、取引の時刻とは限らない） |
| `raw` | 明細のオブジェクトそのまま（`transferRequestInfo` を含む） |

- 読めない明細（`itemKey` がない、日付・金額・入払コードが読めない）は失敗行（`RowFailure`。行番号は取得した中の順、元の行は 日付・入払・金額・摘要）。ただし重ねて読んだ期間（前回の取得済みの期間の末日より前）の失敗は、最初に読んだ同期が記録済みなので数えない。末日の分は前回の同期の後に届いた行があり得るので数える（同じ失敗を最大 2 回数える）。
- 取得した行の残高の連続性（前の行の残高 + 金額 = この行の残高）を S4 の `checkBalanceContinuity` で見て、崩れたら警告（取込は止めない）。
- 続けて `GET {apiBase}/accounts/balances?accountId=…` の `balance` と `baseDate` を口座に記録する（§4）。残高だけ取れなかったときは警告「銀行の残高を取得できませんでした」にして、明細は取り込む。

### 3.3 重複と CSV との重なり

- 同じ明細の再取得: `(walletId, externalId = itemKey)` の一意制約（S4 の `insertWalletTransactions`）で重複として数える。2 回目の同期で新規 0 件になる。
- CSV と重なる期間: CSV の `externalId`（12 §3.3。日付・金額・摘要・相手・ファイル内の出現順のハッシュ）は API の明細と揃えられない（摘要の表記が CSV と API で違い、出現順はファイルごと）。そこで、`itemKey` で見つからなかった API の明細を、口座の既存の明細のうち API 以外（CSV の取込、または取込によらない行）と **日付と金額で数えて** 突合する:
  - (日付, 金額) ごとに、API 以外の既存の行の数を `c`、`itemKey` で見つからなかった API の明細を `itemKey` の昇順に並べたものを `U` とする。`U` の先頭 `min(c, |U|)` 件は「既存の明細と同じもの」として取り込まず、重複に数える。残りを新しい明細として取り込む。
  - 毎回同じ規則で数え直すので、結び目を保存しなくても重ね読みのたびに同じ答えになる（例: CSV に 1 行、API に同日同額が 2 件 → 1 件目を既存に結び、2 件目だけ入れる。次の同期でも 1 件目は既存に結ばれ、2 件目は `itemKey` で重複）。
  - 摘要は突合の鍵にしない。同じ口座の同じ日の明細は API が全件を返すので、同日同額の行は数が合えば同じ取引の集まりで、どれをどれに結んでも帳簿は同じ。摘要の表記ゆれ（半角カナ・全角・振込依頼人名の位置）で二重にするより安全。
  - 結ばれた既存の明細（CSV の行）は書き換えない。明細の行・状態・仕訳はそのまま。
- 限界（引き渡し）: API の接続の後に、API で取った期間の CSV を取り込むと、S4 の CSV の重複判定（`externalId` だけ）では弾けない。接続ページに「接続中は CSV の取込は要りません」を出す。CSV の側で API の行と日付・金額で突合する変更は S4（#5）の判定の変更なので、この Issue では行わない（§9）。

### 3.4 記録

- 1 回の同期 = 1 `ImportBatch`（`source = api`、`importer = gmo_aozora`、`periodFrom` / `periodTo` = 取得の期間、`rowCount` = 取得した明細の数〔重ね読みで数えない失敗を除く〕、`importedCount` / `duplicateCount`〔`itemKey` の重複と CSV への結びの合計〕/ `failedCount`、`failures`、`warnings`）。
- 新しい明細も新しい失敗もない同期は `ImportBatch` を作らず、口座の最終同期と残高と監査ログ（`import_batch.sync`、entityId なし）だけ更新する（3 日の重ねで毎日「新規 0」の履歴が増えないように。S4 の Stripe と同じ）。
- 新しい明細は `pending` で入れ、`finishImportBatch` の差し込み点で S5 の `settleAfterImport`（取込時の自動登録）を渡す。取込は仕訳を直接作らない。
- 失敗（§2.4・通信・429・通貨・ページングの異常）は `ImportBatch`（`error` 入り。`rowCount = 0`、`periodFrom` / `periodTo` は取得しようとした期間）と監査ログ `import_batch.sync` に残し、口座の `bank_api_error` に同じ理由を置く。成功したら `bank_api_error` を消す。

### 3.5 手動の同期とジョブ

- 手動: 接続ページの「今すぐ同期」→ Server Action `syncBankWalletAction(walletId)`。
- ジョブ: `POST /api/jobs/bank-sync`。S4 の `verifyJobRequest`（OIDC。12 §5）を通った要求だけ受け、接続済み（`connected` と `reauth_required`）の有効な銀行の口座を順に同期し、`{ ok, wallets: [{ walletId, ok, importedCount, duplicateCount, failedCount, error }] }` を 200 で返す。`reauth_required` の口座は API を呼ばずに失敗として記録する（毎日の失敗が履歴とメールに残り、再接続を促す）。認証の失敗は 401 / 403 / 503。同期の失敗で 5xx を返さない。`GET` は 405。
- Cloud Scheduler: 毎日 06:15 JST（`stripe-sync` の後）。S8 の配備（ジョブのサービス・OIDC のサービスアカウント）に 1 本足す（§9）。

## 4. 残高の照合（S7 の仕組みに追記）

- S7 の `loadWalletStatus` は口座の最新の `balanceAfter` を「明細の残高」として帳簿の残高と比べる（14 §6）。API の明細は `balance` を `balanceAfter` に持つので、そのまま差異が出る。
- 追記: 銀行の残高（`bank_api_balance` と基準日 `bank_api_balance_date`）があり、基準日が `through` 以前で、最新の明細の日付以降なら、それを「明細の残高」として使う（同じ日の明細の並びに依らず、銀行が答えた残高で比べる）。
- `WalletStatus` に `bankApiStatus`（接続の状態）を足し、口座カードの「再接続が必要」と、最終同期（`lastSyncedAt` に銀行 API の最終同期も）に使う。
- 差異は「明細の残高が n 円多い / 帳簿の残高が n 円多い（日付 時点）」の S7 の表示のまま。未処理の明細があれば S7 の「未処理 n 件」と並ぶ。

## 5. 環境と切替

| 変数 | 用途 |
| --- | --- |
| `NIHO_FINANCE_GMO_AOZORA_ENV` | `sunabar` / `stg`（検証）/ `prod`（本番）。未設定なら銀行 API は未設定 |
| `NIHO_FINANCE_GMO_AOZORA_ACCESS_TOKEN` | トークンの方式（sunabar）のアクセストークン |
| `NIHO_FINANCE_GMO_AOZORA_CLIENT_ID` / `_CLIENT_SECRET` | 認可の方式のクライアント（接続通知書・sunabar の認可利用の設定）。本番は Secret Manager |
| `NIHO_FINANCE_GMO_AOZORA_CLIENT_AUTH` | `basic`（既定）/ `post`。GMO に登録したクライアント認証方式 |
| `NIHO_FINANCE_GMO_AOZORA_REDIRECT_URI` | GMO に登録したリダイレクト URI（`https://<画面のドメイン>/api/bank/gmo-aozora/callback`） |
| `NIHO_FINANCE_BANK_TOKEN_KEY` | トークンの暗号鍵（32 バイトの base64。`openssl rand -base64 32`）。本番は Secret Manager |
| `NIHO_FINANCE_GMO_AOZORA_API_BASE` / `_AUTH_BASE` | URL の上書き（sunabar の認可利用、仕様の変更、手元の模擬サーバ） |

既定の URL:

| 環境 | API（`apiBase`） | 認可（`authBase`）と ID Token の `iss` |
| --- | --- | --- |
| `sunabar` | `https://api.sunabar.gmo-aozora.com/corporation/v1` | なし（トークンの方式。認可利用は `_AUTH_BASE` で与える） |
| `stg` | `https://stg-api.gmo-aozora.com/ganb/api/corporation/v1` | `https://stg-api.gmo-aozora.com/ganb/api/auth/v1`・`https://stg-api.gmo-aozora.com` |
| `prod` | `https://api.gmo-aozora.com/ganb/api/corporation/v1` | `https://api.gmo-aozora.com/ganb/api/auth/v1`・`https://api.gmo-aozora.com` |

- `_AUTH_BASE` で上書きしたときは、そのオリジンを ID Token の `iss` とする（sunabar の認可利用でも `iss` を検証する）。
- 上書きの URL は `https://` で、ホストが `gmo-aozora.com` か その下位のドメインのものだけ受け付ける（資格情報・クエリ・フラグメントは不可。HTTP のリダイレクトは追わない。トークンを他所へ送らない）。`NIHO_FINANCE_ENV ≠ prod` のときだけ `http://localhost` / `http://127.0.0.1` も許す（手元の模擬サーバで画面を確かめるため）。
- 切替: sunabar で接続した口座は `bank_api_env = sunabar` を持つ。本番に切り替えたら、その口座は再接続が必要になる（§2.4）。本番の口座は新しい口座（設定 › 口座）で接続するのを勧める（sunabar の架空の明細を本番の帳簿の口座に残さないため）。
- 本番の接続の手順（口座開設と API 契約の後。[07](07-operations.md) の設立直後の手順に足す）: GMO の接続通知書のクライアント ID・シークレットを Secret Manager に入れる → リダイレクト URI を GMO に登録 → Cloud Run の画面とジョブのサービスに環境変数と秘密を結ぶ → 設定 › 口座 の法人口座で「接続する」→ Scheduler の `bank-sync` を有効にする。
- sunabar の使い方（開発）: GMO あおぞらの口座保有者が sunabar ポータルで法人の口座のアクセストークンを発行し、`.env` に `NIHO_FINANCE_GMO_AOZORA_ENV=sunabar` と `NIHO_FINANCE_GMO_AOZORA_ACCESS_TOKEN` を書く（コミットしない）。sunabar の残高は 0 円から始まるので、シミュレータで入出金を作ってから同期する。

## 6. データと層

### 6.1 列の追加（migration `*_bank_api`。テーブルは足さない）

| テーブル | 列 | 内容 |
| --- | --- | --- |
| `wallet` | `bank_api_env text?` | 接続した環境（`sunabar` / `stg` / `prod`）。null = 未接続 |
| | `bank_api_status text?` | `authorized`（口座の選択待ち）/ `connected` / `reauth_required`。null = 未接続 |
| | `bank_api_account_id text?` | 銀行の口座 ID（GMO の `accountId`。支店・口座番号を含むので DB にだけ置き、画面・ログ・監査ログ・バックアップに出さない） |
| | `bank_api_account_label text?` | 画面の表記（「支店名 科目名 ••••末尾 4 桁」） |
| | `bank_api_tokens text?` | 暗号化したトークン（§2.3）。トークンの方式では null |
| | `bank_api_synced_through date?` | 取得済みの期間の末日（§3.1） |
| | `bank_api_last_synced_at timestamptz?` | 最終同期（成功・新規 0 件を含む） |
| | `bank_api_balance bigint?` / `bank_api_balance_date date?` | 銀行の残高とその基準日（§4） |
| | `bank_api_error text?` | 直近の失敗の理由。成功で消える |

`Wallet.importer`（CSV の取込形式）は変えない。接続を外しても CSV の取込はそのまま使える。

### 6.2 `packages/importers/src/gmo-aozora/`（純粋。DB を知らない）

```ts
export type GmoAozoraEnvironment = "sunabar" | "stg" | "prod";
export interface GmoAozoraConfig {
  env: GmoAozoraEnvironment;
  mode: "token" | "oauth";
  apiBase: string;
  auth: { authBase: string; issuer: string; clientId: string; clientSecret: string; clientAuth: "basic" | "post"; redirectUri: string } | null; // oauth
  accessToken: string | null;                                        // token
}
export function resolveGmoAozoraConfig(env?: NodeJS.ProcessEnv, options?: { allowLocalhost?: boolean }):
  { ok: true; config: GmoAozoraConfig } | { ok: false; reason: "unset" | "invalid"; message: string; variables: string[] };

// OAuth（fetch は差し替えられる）
export function buildAuthorizationUrl(auth, params: { state: string; nonce: string }): string;
export function exchangeAuthorizationCode(auth, code: string, options: { nonce: string; fetch?; now? }): Promise<GmoTokenSet>; // ID Token を nonce まで検証（照合を忘れられない形）
export function refreshAccessToken(auth, refreshToken: string, options?: { fetch?; now? }): Promise<GmoTokenSet>;
export function verifyIdToken(idToken: string, auth, expected: { nonce: string | null; now: Date }): { ok: true; claims } | { ok: false; reason: string };
export interface GmoTokenSet { accessToken: string; refreshToken: string | null; accessTokenExpiresAt: Date; scope: string; idToken: string | null }
export function sealTokens(tokens: StoredTokens, key: string): string;   // AES-256-GCM
export function openTokens(sealed: string, key: string): StoredTokens;   // 失敗は GmoTokenCipherError

// 口座の API
export interface GmoAozoraApi {
  listAccounts(): Promise<GmoAccount[]>;
  getBalance(accountId: string): Promise<GmoBalance | null>;
  listTransactions(params: { accountId: string; dateFrom: string; dateTo: string; nextItemKey?: string }): Promise<GmoTransactionsPage>;
}
export function createGmoAozoraApi(options: { apiBase: string; accessToken: () => Promise<string>; onUnauthorized?: () => Promise<string | null>; fetch? }): GmoAozoraApi;
export class GmoApiError extends Error { kind: "unauthorized" | "rate_limited" | "bad_request" | "server" | "network" | "invalid_response"; status: number | null; code: string | null }
export function fetchAllTransactions(api, params: { accountId; dateFrom; dateTo }): Promise<{ transactions: GmoTransaction[]; currencyCode: string; baseDate: string }>;
export function convertGmoTransaction(t: GmoTransaction, rowNumber: number): { draft: WalletTransactionDraft | null; failure: RowFailure | null };
export function matchExistingLines(drafts: readonly WalletTransactionDraft[], existing: readonly { txnDate: CalendarDate; amount: Money }[]): { insert: WalletTransactionDraft[]; matched: WalletTransactionDraft[] }; // §3.3（existing は API 以外の行）
export function maskAccountLabel(account: GmoAccount): string;
export function isYenOrdinaryAccount(account: GmoAccount): boolean;   // 科目 01 / 02 かつ JPY
```

- HTTP は `fetch`（Node 標準）。依存は足さない。タイムアウトは 1 呼び出し 30 秒（`AbortSignal.timeout`）。
- 応答の数値は文字列で来る（仕様）。金額・残高は整数の文字列だけ受け付け、`BigInt` にする（浮動小数を通さない）。
- ゴールデンテスト: `packages/importers/test/fixtures/gmo-aozora/` に架空の応答（口座一覧、残高、30 日分の明細を 2 ページ、トークン応答、401・429・400 のエラー）。架空の会社名・支店名・口座番号（`9999999` など）だけを使う。

### 6.3 `packages/db/src/bank-links.ts`

```ts
export interface BankLinkSettings { walletId; walletName; env: GmoAozoraEnvironment | null; status: "authorized" | "connected" | "reauth_required" | null; accountLabel: string | null; syncedThrough: CalendarDate | null; lastSyncedAt: Date | null; balance: Money | null; balanceDate: CalendarDate | null; error: string | null; recentBatches: ImportBatchSummary[] }
export function getBankLink(db, walletId): Promise<BankLinkSettings | null>;                  // 銀行の口座でなければ null
export function listBankLinkStatuses(db): Promise<{ walletId; status }[]>;                     // 設定 › 口座・ホーム
export function saveBankAuthorization(db, input: { walletId; env; tokens: GmoTokenSet | null }, options: { actor; key? }): Promise<void>; // wallet.authorize_bank
export function listLinkableBankAccounts(db, input: { walletId }, options: { api? }): Promise<{ accountId; label; linkedWalletName: string | null }[]>; // 口座の選択
export function connectBankAccount(db, input: { walletId; accountId }, options: ImportOptions & { api? }): Promise<ImportOutcome>; // wallet.connect_bank のあと最初の同期
export function disconnectBankLink(db, input: { walletId }, options: { actor }): Promise<void>;  // wallet.disconnect_bank。列を null に
export function syncBankWallet(db, input: { walletId; now? }, options: ImportOptions & { api?; config? }): Promise<ImportOutcome>; // import_batch.sync。失敗は error に
export function syncAllBankWallets(db, options: ImportOptions & { now? }): Promise<ImportOutcome[]>;
```

- `accountId` は画面に出さないが、口座の選択の radio の値には要る。サーバーで「その口座のトークンで今見える一覧に含まれるか」を確かめてから保存する（改ざんされた値を保存しない）。
- 監査ログ（entity `wallet`）: `wallet.authorize_bank`・`wallet.connect_bank`・`wallet.disconnect_bank`・`wallet.require_bank_reauth`、同期は `import_batch.sync`。スナップショットに トークン・口座 ID を入れない（表記と状態だけ）。
- 入力の Zod スキーマ（`bankWalletInputSchema`・`bankAccountChoiceSchema`）は `schemas.ts` に追記、公開する関数と型は `index.ts` に追記。
- S7 への追記: `loadWalletStatus`（§4）、`HOME_TODO_SOURCES` に `bankReconnectTodo`、`loadBackupSource` の口座から `bankApiTokens` と `bankApiAccountId` を除く。

### 6.4 `apps/web`

- `app/(app)/settings/wallets/[id]/bank/page.tsx`（§1.1）と `actions.ts`（`connectBankAction`〔トークンの方式〕・`chooseBankAccountAction`・`syncBankWalletAction`・`disconnectBankAction`）。
- `app/api/bank/gmo-aozora/authorize/route.ts`・`callback/route.ts`（§2.2）。`actor()` は Server Action と同じ。
- `app/api/jobs/bank-sync/route.ts` と `lib/jobs/bank-sync.ts`（`stripe-sync` と同じ形の handler。テストつき）。

## 7. 受け入れ条件

Issue #17 の条件に加えて:

- 架空のフィクスチャ（30 日分・2 ページ）から全件が `pending` の明細になり、同じ応答の 2 回目の同期で新規 0 件・`ImportBatch` は増えない。
- CSV で取り込んだ期間と重なる API の明細は、同日同額の数だけ既存に結ばれて新規にならず、CSV にない分だけ入る。2 回目の同期でも同じ。
- トークンの失効（401・`invalid_grant`・環境の違い・復号の失敗）で 状態 = 再接続が必要、`ImportBatch.error` と `bank_api_error` に理由、設定 › 口座 と接続ページとホームに再接続の案内。再接続で前回の続きから取り込む。
- 429・5xx・通信の失敗では再接続にならず、取得済みの期間が進まない。
- ID Token の署名・`iss`・`aud`・`azp`・`exp`・`iat`・`nonce` のそれぞれの違いで接続しない。`state` が違うコールバックは 400。
- `/api/jobs/bank-sync` はトークンなし・署名が違うで拒み、正しいトークンで 200（同期の失敗も 200）。
- トークン・口座 ID・クライアントシークレットが、監査ログ・バックアップ・画面・ログに出ない。リポには架空の値だけ。
- 320px で接続ページの各状態が操作できる。

## 8. 要確認（実物で確かめる）

- sunabar の法人 API の URL と、sunabar の「認可利用」の認可・トークンのエンドポイント（公開ページは個人の `personal/v1` の例だけ）。違えば `_API_BASE` / `_AUTH_BASE` で合わせ、§5 の既定を直す。
- アクセストークン（応答例は `expires_in = 2592000`、30 日）とリフレッシュトークンの有効期間、更新でリフレッシュトークンが新しくなるか。
- 入出金明細の照会できる過去の期間の上限（仕様書に記載なし。最初の同期で古い日付が 400 になれば、その旨を失敗の理由に出す）。
- 本番の通知（Webhook）は使わない前提。日次で足りないと分かったら別 Issue。

## 9. 引き渡し

- S8（#9）/ 配備: Cloud Scheduler `bank-sync`（06:15 JST、OIDC、ジョブのサービスの `/api/jobs/bank-sync`）、Secret Manager の `NIHO_FINANCE_GMO_AOZORA_CLIENT_SECRET`・`NIHO_FINANCE_BANK_TOKEN_KEY`、画面のサービスの環境変数（§5）。本番の接続は口座開設と API 契約の後。
- S4（#5）: API で接続した口座への CSV の取込で、API の明細と日付・金額で突合して重複に数える（§3.3 の限界）。要るなら #5 で判定を拡げる。
