# 13. 証憑（S6 の画面仕様）

[05 画面と体験](05-ui-ux.md) §2.4 と [03 法令対応](03-compliance.md) §3 の詳細。S6（Issue #7）で作る「証憑」の画面（受信箱・検索・詳細・紐づけ・無効化・差し替え）、設定の「証憑の規程」、ファイルの保存層（GCS とローカル）、索引簿の書き出し、電子帳簿保存法の文書（事務処理規程・要件対応表・操作説明書）を定めます。読み取り（#18）、請求書 PDF の生成（#16）、証憑 zip の書き出し（S7 #8）、GCS バケットの作成（S8 #9）は範囲外です。

## 1. 方針と不変条件

- 証憑は電子取引データ（電子帳簿保存法 7 条）の保存庫。ファイル本体は GCS（本番）またはローカルのフォルダ（開発）に置き、`Document` 行がメタデータ（検索の 3 項目・SHA-256・形式・大きさ・保存者・保存日時）を持つ。
- 追記のみ。`Document` は DELETE できず、`storage_key` / `sha256` / `byte_size` / `mime` は変えられない（S1 のガード）。誤った証憑は「無効」（理由と日時を残し、ファイルも紐づけも残す）、差し替えは新しい行＋ `supersedesId`。無効は戻せない。
- 真実性の措置は事務処理規程方式。タイムスタンプは使わない（[03 §3.2](03-compliance.md)）。システム側は SHA-256 の記録・追記のみ・監査ログで規程を裏づける。
- 検索要件（取引年月日・取引金額・取引先。日付と金額は範囲、2 項目以上の組み合わせ）は v1 から満たす。3 項目は保存時には任意にし、どれかが空のものを「未整理」と呼ぶ。受信箱は「手を入れる必要がある証憑」= 紐づけがないもの、または未整理のもの（無効と、取込の CSV を除く）で、月次で空にする（[07 §2](07-operations.md)、規程 第 10 条）。取込の CSV（S4 の `ImportBatch.documentId`）は、取引が明細の各行（日付・金額・相手）なので未整理にも数えない。
- 同じファイル（SHA-256 が同じ）の再アップロードは新しい行を作らず、無効でない既存の証憑に結ぶ。
- 監査ログの action: `document.create` / `document.update` / `document.link` / `document.unlink` / `document.void` / `document.export` / `records_policy.save`。
- 金額は税込の整数円（`BigInt`）、日付は暦日。内部の識別子は画面に出さないが、証憑 ID（ULID）だけは索引簿と詳細の脚注に出す。紙の原本（封筒）と電子の証憑を対応づける鍵になるため。

## 2. ルートと殻

| ルート | 画面 |
| --- | --- |
| `/documents` | 受信箱 / すべて / 無効（`tab`）。アップロード・検索・一覧 |
| `/documents/[id]` | 詳細（プレビュー・項目・紐づけ・候補・無効化・差し替え・履歴） |
| `/settings/documents-policy` | 証憑の規程 |
| `POST /api/documents/prepare` | 重複の判定と送信先の発行 |
| `POST /api/documents/complete` | 送信済みファイルの検証と登録 |
| `PUT /api/documents/upload` | ローカル保存の受け口（保存先がローカルのときだけ） |
| `GET /api/documents/[id]/file` | ファイル本体（GCS は署名付き URL へ 302、ローカルは本体を返す） |
| `GET /api/documents/index.csv` | 索引簿 |

- 左ナビの「証憑」を `/documents` に有効化する。スマホの下タブ中央（カメラ。primary の丸いボタン、名前は「証憑を撮影」）は、押すとカメラが開く。撮った写真は保存され、その証憑の詳細が開く（[10 §1.1](10-settings-and-setup.md)）。スマホの一覧へは、その他 › 証憑から入る。
- 設定の索引の「証憑の規程」を `/settings/documents-policy` に有効化する（要約は「未制定」か「施行日 yyyy/mm/dd」）。
- ホームの「やること」の「受信箱の証憑 n 件」は、S7 の差し込み口 `inboxDocumentsTodo` が `countInboxDocuments` で数えて `/documents` へ結ぶ（S7 が先に入ったので S6 で結線した）。

## 3. 一覧 `/documents`

### 3.1 アップロード

- PC（768px 以上）: 一覧の上にドロップゾーン「ここにドロップ、または選ぶ」。画像・PDF・CSV、1 ファイル 20 MB まで、複数可。`<input type="file" multiple accept="image/*,.heic,.heif,application/pdf,.pdf,text/csv,.csv">`。
- スマホ（768px 未満）: PageHeader の操作に「撮影」（primary。`<input type="file" accept="image/*" capture="environment">`）と「選ぶ」（secondary。複数可）。ドロップゾーンは出さない。
- 流れ（client。`apps/web/lib/documents/upload-client.ts`）: ① `crypto.subtle.digest` で SHA-256 → ② `POST /api/documents/prepare` → 重複なら送信せず「保存済みのファイルと同じ」として既存を開く導線 → ③ 送信先へ `PUT`（GCS の署名付き URL、またはローカルの受け口）→ ④ `POST /api/documents/complete` → ⑤ 1 件なら詳細へ移動、複数なら一覧を更新してトースト「n 件を保存しました」。
- 進捗は一覧の上の小さな表（ファイル名 ・ 状態: 計算中 / 送信中 / 登録中 / 保存済み / 保存済みのファイルと同じ / エラー（理由））。終わったら失敗と重複の行だけ残す。
- `source` は「撮影」からは `camera`、それ以外は `upload`。`kind` の初期値は CSV → `statement`、それ以外 → `receipt`（詳細で変える）。

### 3.2 タブと検索

- チップ: 受信箱 (n) / すべて (n) / 無効 (n)。`tab=inbox|all|voided`（既定 `inbox`）。件数は検索条件に関わらず全体。受信箱は「未紐づけ、または紐づけ済みでも未整理（取引年月日・金額・取引先のどれかが空）」で無効を含まない。「すべて」は無効も含む。
- 検索（GET フォーム。URL の検索パラメータが正で、再読み込みや共有で同じ結果になる）: 取引年月日の範囲（`from` `to`）、金額の範囲（`amountMin` `amountMax`。3 桁区切り可）、取引先（`partner`: 文字。取引先マスタの名前と自由入力の取引先名の部分一致。datalist に有効な取引先）、種別（`kind`）、キーワード（`q`: ファイル名・メモ・取引先名の部分一致）、`page`。select の変更で自動送信（小さな client component）、「検索」ボタンでも送れる。「条件を消す」。
- 条件は AND。未整理（日付や金額が空）の証憑は、その項目に条件があるときは出ない。
- 結果の上に「n 件」と「索引簿を書き出す」（`/api/documents/index.csv` に同じ条件を付けたリンク）。

### 3.3 表

- PC の列: 取引年月日 ・ 種別 ・ 取引先 ・ 金額（円） ・ ファイル ・ 紐づけ ・ 状態。行全体が詳細へのリンク（キーボードで到達できる）。
- 未整理（日付・金額・取引先のどれかが空）は、その空の列に「未整理」（muted）。紐づけは「仕訳 n · 明細 m」（0 のものは出さない）か「—」。状態は 未紐づけ / 紐づけ済み / 無効（理由）。無効の行は muted。
- 並び: 受信箱は保存日時の降順。すべて・無効は取引年月日の降順（空は先頭）、同日は保存日時の降順。50 件ごとに「前へ / 次へ」。
- スマホは 2 段: ファイル名・取引年月日 / 取引先・金額。
- 空のとき: 受信箱「受信箱は空です。すべてのタブで検索できます」、すべて「証憑がありません。領収書や請求書をアップロードするか、スマホで撮影します」。

## 4. 詳細 `/documents/[id]`

- PageHeader: 題名はファイル名（なければ種別）、meta に「領収書 · 2026/11/07 10:12 に owner が保存 · 撮影」。戻るは一覧へ。
- 状態の帯（該当するものだけ）: 「無効（2026/11/08 · 理由: …）」。「差し替え済み → （新しいファイル名）」（リンク）。差し替え後の側には「（元のファイル名）の差し替え」（リンク）。
- 配置: PC は 2 列（左にプレビュー、右 380px に項目と操作）。スマホは縦（プレビューは高さ 50vh まで）。
- プレビュー: 画像は `<img>`、PDF は `<iframe>`、それ以外（HEIC・CSV）は「この形式はプレビューできません」。下に「ファイルを開く」（新しいタブ。`/api/documents/[id]/file`）、大きさ、形式、SHA-256（`<code>` で小さく。改ざん検知の根拠として見せる）、証憑 ID。
- 項目（一覧の中の直接編集と同じ部品。blur / Enter で保存、右上に 保存中 / 保存済み / エラー）: 種別（select）、取引年月日（date）、金額（`MoneyInput`。0 以上）、取引先（select: 有効な取引先＋「その他（名前を入力）」）、取引先名（「その他」のときだけ。文字）、登録番号（T + 13 桁。形式と検査用数字を検証）、メモ。無効の証憑は読み取り専用で、帯に「無効にした証憑は変えられません。正しいファイルは新しい証憑として保存します」（無効の証憑は差し替えられない）。
- 紐づけ: 「取込 · 架空カード · 2026/11/01 – 2026/11/30 · 12 件」（`/imports/[id]` へのリンク。取込の CSV のとき。外せない）、「仕訳 No. 12 · 2026/11/05 · クラウドサービス利用料 · 1,650」（`/entries/[id]` へのリンク）、「明細 架空カード · 2026/11/07 · AMAZON · 3,980」、「請求書 INV-2026-0001」。各行に「外す」（ConfirmDialog。理由なし）。
- 候補「同じ金額・近い日付」: 金額があるとき、|金額| が同じで日付が取引年月日 ±7 日（取引年月日が空なら保存日の 30 日前〜保存日）の 明細（未処理を先に、登録済みも）と 仕訳（登録済み。反対仕訳と取消済みを除く。金額は借方合計）を各 10 件まで、日付の近い順。すでに紐づく相手は除き、ほかの証憑（無効を除く）がすでに紐づく相手は「証憑あり」と示して後ろに並べる。行に「紐づける」（primary・sm）。
- 金額が空のとき（撮ったばかりの領収書）: 候補「近い日付の未処理の明細」として、取引年月日 ±7 日（空なら保存日の 7 日前〜翌日）の未処理の明細を金額を問わず日付の近い順に 10 件出す（仕訳は出さない）。見出しの下に「金額を入れると、同じ金額の明細と取引に絞り込めます」。紐づけると日付・金額が明細から埋まる。これで「カメラのタブ → 撮影 → 紐づける」の 3 操作で明細に結べる（受け入れ条件）。
- 紐づけると、証憑の取引年月日・金額・取引先が空なら相手から埋める（明細: 日付と |金額|、振込人名があれば取引先名。仕訳: 日付と借方合計、行の取引先が 1 つならその取引先）。埋めた項目は `document.update` として別に監査ログに残る。
- 「この証憑から取引を登録」（secondary。無効の証憑には出さない）: `/entries/new?type=expense&date=<取引年月日>&amount=<金額>&partner=<取引先 ID>&document=<証憑 ID>`（空の項目は入れない）。収入・支出のフォームがこれらを初期値にし、登録に最初に成功したときに `document` の証憑を仕訳へ紐づける（S3 の `simple-entry-form.tsx` への追記）。
- 「無効にする」（ghost・文字色 danger）→ ConfirmDialog（`variant: "danger"`）: 理由（必須・200 字）。「紐づけは残り、検索にも理由つきで出ます。ファイルは消えません」。ボタンは「無効にする」。終わったら同じページに留まり帯が出る。
- 「差し替える」→ ダイアログ: 理由（必須）とファイル（1 つ）。送信の流れは §3.1 と同じで、`complete` に `supersedesId` と `reason` を渡す。新しい証憑は元の項目（種別・取引年月日・金額・取引先・登録番号・メモ）と紐づけを引き継ぎ、元は「差し替え: 理由」で無効になる。終わったら新しい証憑へ移動。
- 履歴: この証憑の監査ログ（保存 / 変更 / 紐づけ / 紐づけを外す / 無効）を日時順に。列: 日時 ・ 操作 ・ 実行者 ・ 理由。行を開くと before / after（整形した JSON、`<details>`）。

## 5. 設定 › 証憑の規程 `/settings/documents-policy`

- 上: 状態「未制定（施行日を入れて保存すると制定済みになります）」または「制定済み · 施行日 2026/11/10 · 版 2026-10」。フォーム: 施行日（必須）、管理責任者（既定は代表者）、処理責任者（既定は管理責任者と同じ）。「保存」で `Company` の列に保存し、監査ログ `records_policy.save`（before / after）。
- 下: 規程の全文に商号・責任者・施行日を埋めて表示する。文面の正は `apps/web/lib/documents/policy.ts`（`POLICY_VERSION`、条文の配列、`renderPolicyMarkdown(values)`）で、`docs/ops/electronic-records-policy.md` の本文と一致することを単体テストで確かめる。未入力は「（商号）」のまま出す。「印刷」（`window.print()`。印刷時はナビ・フォーム・ボタンを隠す）。
- 保存済みの版が `POLICY_VERSION` と違うときは「規程の文面が更新されています。読み直して施行日を入れ直してください」。
- 「この規程をシステムがどう支えるか」: 追記のみ（無効化・差し替え）・SHA-256・監査ログ・検索と索引簿、の 4 行と、要件対応表（`docs/ops/electronic-records-compliance.md`）へのリンク。

## 6. 保存層 `apps/web/lib/storage/`

- 保存先は環境変数で決める（`config.ts` の `documentStorageConfig`）: `NIHO_FINANCE_DOCUMENTS_BUCKET`（S8 の `scripts/deploy.sh` が Cloud Run に設定する）があれば `gcs`、なければ `local`。`NIHO_FINANCE_STORAGE=local | gcs` で明示もできる。`NIHO_FINANCE_ENV=prod` で `local` になるときは起動時でなく最初の利用時にエラー（本番でローカルディスクに保存しない）。
- 共通の型 `DocumentStorage`（`types.ts`）: `createUploadTarget({ key, mime, byteSize })`（ブラウザが PUT する先: `url` / `method` / `headers` / `expiresAt`）、`stat(key)`（`{ byteSize }` か `null`）、`read(key)`（全体。20 MB 上限）、`write(key, bytes, mime)`（サーバー側の保存。S4 の CSV、#16 の PDF、差し替え）、`fileResponse(key, { mime, filename })`（GCS は署名付き GET URL への 302、ローカルは本体の `Response`）。`getDocumentStorage()` が env から 1 つ選ぶ（プロセスで 1 つ）。
- キー（`keys.ts`）: `documents/<yyyy>/<mm>/<ulid>.<ext>`。yyyy/mm は保存時刻の JST、拡張子は MIME から。キーに元のファイル名を入れない。
- `local`（`local.ts`）: `NIHO_FINANCE_STORAGE_DIR`（既定 `<repo root>/tmp/documents`。`tmp/` は `.gitignore` 済み）。送信先は `PUT /api/documents/upload?key=…&mime=…&size=…&exp=…&sig=…`（`key` `mime` `size` `exp` の HMAC-SHA256。鍵は `NIHO_FINANCE_UPLOAD_SECRET`、未設定ならプロセスごとの乱数）。受け口は署名と期限を確かめ、`Content-Type` と大きさが一致する本体だけを書き、既にあるキーには書かない。
- `gcs`（`gcs.ts`）: `@google-cloud/storage`（apps/web の依存に足す）。バケットは `NIHO_FINANCE_DOCUMENTS_BUCKET`。認証は ADC（Cloud Run のサービスアカウント。署名は IAM の signBlob）。送信は V4 の署名付き PUT（15 分、`Content-Type` を固定）、閲覧は V4 の署名付き GET（10 分、`response-content-disposition` でファイル名）。
- S8 に渡すバケットの要件: バージョニング ON、削除保護（保持ポリシー 7 年・ロックしない）、均一なバケットレベルのアクセス、公開アクセスの防止。CORS: アプリの origin（Cloud Run の URL）から `PUT`、ヘッダー `Content-Type`、`maxAgeSeconds` 3600。サービスアカウントに `storage.objects.create` と `storage.objects.get`（削除と上書きの権限は与えない）、自身への `roles/iam.serviceAccountTokenCreator`（署名付き URL の signBlob）。ライフサイクルの削除は置かない。送信の途中で検証に失敗したオブジェクト（どの `Document` からも参照されない）は保持ポリシーの下で残るが、量は小さく、証憑一式の書き出し（S7）は `Document` から辿るので混ざらない。
- 受け付ける形式（`mime.ts`。純粋関数は `packages/ledger/src/documents.ts`）: `image/jpeg` `image/png` `image/webp` `image/heic` `image/heif` `application/pdf` `text/csv`。ブラウザの `type` が空か `application/octet-stream` / `text/plain` / `application/vnd.ms-excel` のときは拡張子から決める。`complete` では先頭バイトで形式を確かめる（JPEG `FF D8 FF`、PNG の署名、WEBP の `RIFF….WEBP`、HEIC / HEIF の `ftyp`、PDF の `%PDF`。CSV は UTF-8 か Shift_JIS として読めること）。合わなければ「ファイルの中身が形式と合いません」。

## 7. API

- `POST /api/documents/prepare` `{ sha256, mime, byteSize, originalName, source }` → `{ kind: "duplicate", documentId }`（無効でない同じ SHA-256 がある）| `{ kind: "upload", key, url, method: "PUT", headers, mime, expiresAt }`（`mime` は正規化した形式。PUT の `Content-Type` と `complete` の `mime` に使う）。形式・大きさ・ファイル名（200 字）の検査はここで行い、違反は 400。
- `POST /api/documents/complete` `{ key, sha256, mime, byteSize, originalName, source, kind?, supersedesId?, reason?, link?: { kind, id } }` → `{ documentId, duplicate }`。サーバーは `stat` で大きさ、`read` で SHA-256 と先頭バイトを確かめ（合わなければ 400。オブジェクトはそのまま）、`registerDocument`（`supersedesId` があれば `replaceDocument`、`link` があれば同じトランザクションで `linkDocument`）を呼ぶ。
- `GET /api/documents/[id]/file` → GCS は 302、ローカルは本体。`Cache-Control: private, no-store`、`Content-Disposition: inline; filename*=UTF-8''…`、`X-Content-Type-Options: nosniff`。無効の証憑も開ける。見つからなければ 404。
- `GET /api/documents/index.csv?tab&from&to&amountMin&amountMax&partner&kind&q` → `text/csv; charset=utf-8`、先頭に BOM、CRLF。列: 証憑ID, 取引年月日, 取引金額, 取引先, 登録番号, 種別, 状態, 無効の理由, 仕訳番号（`第1期 No.12 / 第1期 No.15`）, 明細（`架空カード 2026/11/07 3,980 / …`）, ファイル名, 形式, SHA-256, 保存日時, 保存者, メモ。`tab` の既定は `all`。監査ログ `document.export`（after に条件と件数）。
- 同一オリジンの fetch だけを受ける: `POST` は `Content-Type: application/json` 以外を 415、`Sec-Fetch-Site: cross-site` を 403。認証は S8 の IAP（ローカルは無認証）。
- 失敗は `{ error: "利用者向けの文" }` と 4xx。想定外は 500 と汎用の文。

## 8. データと層

### 8.1 schema（列の追加だけ）

- `document`: `voided_at timestamptz?`、`void_reason text?`、`note text?`。CHECK `document_void_fields`: `("status" = 'voided') = ("voided_at" IS NOT NULL)` かつ `("status" <> 'voided' OR "void_reason" IS NOT NULL)`。`ledger_document_guard` を `CREATE OR REPLACE` で差し替え、`voided` から他の状態への変更と、いったん入った `voided_at` / `void_reason` / `supersedes_id` の書き換えを拒否する。
- `company`: `records_policy_effective_on date?`、`records_policy_manager text?`、`records_policy_operator text?`、`records_policy_version text?`。
- migration は PR の直前に main を取り込んでから作る（他レーンの migration より後の timestamp）。

### 8.2 `packages/ledger/src/documents.ts`（純粋）

- `DOCUMENT_KINDS` / `DOCUMENT_KIND_LABELS`（領収書 / 受領した請求書 / 発行した請求書の写し / 契約書 / 明細書 / その他）、`DOCUMENT_SOURCES` / `DOCUMENT_SOURCE_LABELS`（アップロード / 撮影 / メール / Stripe / 生成）、`DOCUMENT_STATUSES` / `DOCUMENT_STATUS_LABELS`（未紐づけ / 紐づけ済み / 無効）、`DOCUMENT_LINK_KINDS`（`journal_entry` / `wallet_transaction` / `invoice`）と `DOCUMENT_LINK_KIND_LABELS`（仕訳 / 明細 / 請求書）、`DOCUMENT_AUDIT_ACTION_LABELS`（§1 の action → 保存 / 変更 / 紐づけ / 紐づけを外す / 無効 / 索引簿の書き出し / 規程の保存）。
- `DOCUMENT_TABS` / `DOCUMENT_TAB_LABELS`（受信箱 / すべて / 無効）、`isUnsortedDocument({ txnDate, amount, partnerId, partnerName })`（未整理の定義）。
- `DOCUMENT_CANDIDATE_WINDOW_DAYS = 7`、`DOCUMENT_UNDATED_CANDIDATE_DAYS = 30`、`DOCUMENT_CANDIDATE_LIMIT = 10`、`DOCUMENT_MAX_BYTES = 20 * 1024 * 1024`、`ACCEPTED_DOCUMENT_MIMES`、`normalizeDocumentMime(type, filename)`（受け付けない形式は `null`。`image/jpg` や Android の CSV の別名も受ける）、`extensionForMime(mime)`、`isPreviewableMime(mime)`。
- `toCsv(rows)`（RFC 4180 の引用、CRLF、先頭 BOM。`=` `+` `-` `@` などで始まる文字のセルは式として解釈されないよう引用して `'` を付ける）、`DOCUMENT_INDEX_COLUMNS`、`documentIndexCells(row)`（1 行分のセル。取引金額は区切りなしの整数、保存日時は JST の `yyyy/mm/dd hh:mm:ss`）。
- テスト: ラベルの網羅、CSV の引用（カンマ・引用符・改行・先頭の `=`）、MIME の正規化と拡張子。

### 8.3 `packages/db/src/documents.ts`

関数はすべて `(db, input, { actor })` の形。入力は `schemas.ts` に足す Zod（`documentRegisterSchema`、`documentUpdateSchema`、`documentVoidSchema`、`documentReplaceSchema`、`documentLinkSchema`、`documentSearchSchema`、`recordsPolicySchema`）。規則に反すると `SettingsError`（利用者向けの文と `field`）。

| 関数 | 内容 |
| --- | --- |
| `registerDocument(db, input, { actor })` | 1 トランザクション。`pg_advisory_xact_lock(hashtext(sha256))` の下で無効でない同じ SHA-256 を探し、あれば `{ document, duplicate: true }`（何も書かない）。なければ行を作り `document.create`。戻り値は `DocumentDetail` |
| `findDocumentBySha256(db, sha256)` | 無効でない既存（`prepare` 用） |
| `updateDocument(db, input, { actor })` | 種別・取引年月日・金額（0 以上）・取引先 ID（存在と有効を確認。入ると取引先名は消す）・取引先名・登録番号・メモ。省略した項目は変えない。無効は拒否。変更がなければ書かない。`document.update`（before / after） |
| `voidDocument(db, { id, reason }, { actor })` | `status = voided`、`voidedAt`、`voidReason`。紐づけは残す。二重の無効化は拒否。`document.void`（reason） |
| `replaceDocument(db, { id, replacement, reason }, { actor })` | 1 トランザクション: 新しい行（`supersedesId = id`。元の項目を引き継ぎ、`replacement` にある項目はそれを優先）→ 紐づけを複製（それぞれ `document.link`）→ 元を無効（理由「差し替え: …」）。元が無効なら拒否。同じ SHA-256 の重複判定は `registerDocument` と同じ。戻り値は新しい証憑 |
| `linkDocument(db, { kind, id, documentId }, { actor })` | 対象（仕訳 / 明細 / 請求書）の存在を確認し `DocumentLink` を作る。`inbox` → `linked`。空の項目を相手から埋める（§4）。すでにあれば何もしない。無効は拒否。`document.link`（after: 対象の要約） |
| `unlinkDocument(db, { kind, id, documentId }, { actor })` | 行を消し、紐づけが 0 になったら `linked` → `inbox`。`document.unlink`（before: 対象の要約） |
| `listDocumentLinks(db, { kind, id })` | 対象に紐づく証憑（無効も理由つきで）。`entries/[id]` と S5 の行が使う |
| `searchDocuments(db, filters, { page, pageSize = 50 })` | §3.2 の条件。`{ rows, total, page, pageSize }`。行: id・種別・取引年月日・金額・取引先名・ファイル名・形式・状態・無効の理由・紐づけの件数（仕訳 / 明細 / 請求書）・保存日時 |
| `countDocuments(db)` / `countInboxDocuments(db)` | タブの件数 `{ inbox, all, voided }` / ホーム用。受信箱は §3.2 の定義 |
| `attachImportBatchDocument(db, { batchId, documentId }, { actor })` / `findImportBatchDocument(db, batchId)` | 取込の CSV を証憑にして `ImportBatch.documentId` を結び、`fileBytes` を空にする。証憑は紐づけ済みになり、空の日付は明細の最終日、空の取引先は口座名で埋める（`document.update`）。差し替えでは新しい証憑に移る |
| `getDocumentFile(db, id)` | `GET /api/documents/[id]/file` が使う保存先・形式・ファイル名（無効も） |
| `getDocumentDetail(db, id)` | 項目・取引先名・紐づけ（仕訳: 期・No.・日付・摘要・金額・状態。明細: 口座・日付・金額・摘要・状態。請求書: 番号）・差し替えの前後（id・ファイル名）・履歴（監査ログの at / actor / action / reason / before / after） |
| `findLinkCandidates(db, { documentId })` | §4 の候補 `{ basis: "amount" \| "date", walletTransactions, journalEntries }`。金額があれば同額（`amount`）、なければ近い日付の未処理の明細だけ（`date`）。すでに紐づく相手を除く |
| `loadDocumentIndex(db, filters)` / `exportDocumentIndex(db, filters, { actor })` | 索引簿の行（§7 の列。紐づく仕訳の `第n期 No.m`）。`export…` は `document.export` を監査ログに残す |
| `getRecordsPolicy(db)` / `saveRecordsPolicy(db, input, { actor })` | `Company` の 4 列。`records_policy.save` |

テスト（`test/documents.db.test.ts`。seed 済み DB）: 登録と重複、項目の変更と監査ログ、検索（日付の範囲・金額の範囲・取引先・2 項目の組み合わせ・種別・タブ・未整理の扱い）、無効化した証憑が「すべて」で理由つきで出ること・項目の変更が拒否されること・ファイルの列が変わらないこと、紐づけ（状態の遷移・冪等・外す・空の項目の補完・対象の不在）、候補（同額・±7 日・除外・金額が空）、差し替え（引き継ぎ・無効化・連鎖）、索引簿の行、規程の保存と監査ログ、ガード（`voided` から戻す更新と CHECK の拒否）。

### 8.4 `apps/web`

- `app/(app)/documents/{page.tsx, [id]/page.tsx, actions.ts, _components/*}`、`app/api/documents/{prepare,complete,upload,index.csv}/route.ts` と `app/api/documents/[id]/file/route.ts`、`lib/storage/{types,config,index,keys,local,gcs,mime,save}.ts`、`lib/documents/{upload-client.ts, api.ts, api-types.ts, policy.ts, import-evidence.ts}`（`api-types.ts` は client と共有する要求・応答の型だけ）、`app/(app)/settings/documents-policy/{page.tsx, actions.ts, policy-form.tsx}`。
- 書き込みは Server Actions（項目の変更・無効化・紐づけ・外す・規程の保存）と `complete`（登録・差し替え）。どちらも `@niho-finance/db` を通し、actor は `NIHO_FINANCE_ACTOR`。書いたら `revalidatePath("/", "layout")`。
- 単体テスト（`apps/web/test/`。vitest を足す）: ローカル保存（書き込み・stat・read・トークンの検証と期限・既存キーの拒否）、先頭バイトの判定、規程の文面と md の一致、キーの形。

## 9. 他レーンに渡すもの

- S4（#5）: S4 が先に入ったので S6 で結線した。CSV の取込（`importCsvAction`）の直後に `keepImportFileAsDocument`（`lib/documents/import-evidence.ts`: `saveBytesAsDocument` → `attachImportBatchDocument`）で明細書の証憑にし、`ImportBatch.fileBytes` を空にする。失敗しても取込は成り立ち、バイト列は `fileBytes` に残る。`file_bytes` の列は、本番で空になったのを確かめてから後の migration で落とす（expand → contract）。
- S5（#6）: `linkDocument` / `unlinkDocument` / `listDocumentLinks` / `findLinkCandidates`。明細からのアップロードは `Uploader`（`_components/uploader.tsx`）に `link={{ kind: "wallet_transaction", id }}` を渡すと `complete` で同時に紐づく。
- #16 請求: `registerDocument({ source: "generated", kind: "invoice_out" })` と `kind: "invoice"` の紐づけ。
- #18 読み取り: `updateDocument` と `Document.extraction`。詳細の項目の欄に「提案」を足す。
- S7（#8）: ホームの「やること」（`inboxDocumentsTodo` → `countInboxDocuments`）と書き出しの証憑一式（`buildDocumentsArchive` の `fetchFile` → `getDocumentStorage().read`）は S6 で結線済み。zip は今はメモリ上で作るので、年に数百件・1 件 1 MB を超える量になったら書き出しを分割するかストリームにする。

## 10. 文書

- `docs/ops/electronic-records-policy.md`: 事務処理規程の雛形（国税庁の「法人の例」に、このシステムの無効化・差し替え・監査ログ・受信箱を当てはめたもの）。実物（商号と責任者を入れて制定したもの）は設定 › 証憑の規程 に保存し、印刷したものを非公開側に置く。
- `docs/ops/electronic-records-compliance.md`: 要件対応表（施行規則 → 機能 → 証跡）と、システム関係書類（概要書・仕様書・操作説明書・事務手続書類）の所在。
- `docs/ops/documents-operations.md`: 操作説明書（アップロード・整理・紐づけ・無効化・差し替え・索引簿・月次の手順）。
- `docs/ops/README.md`: 運用文書の索引。

## 11. 受け入れ条件

Issue #7 の条件に加えて:

- バケットを設定しない（ローカル保存の）状態で GCS なしに、アップロード → 受信箱 → 詳細 → 紐づけ → 索引簿の書き出しまで通る。
- 同じファイルを 2 回アップロードすると 2 回目は送信されず、既存の証憑が開く。
- 無効にした証憑が「すべて」「無効」で理由つきで出て、項目は変えられず、ファイルは開ける。
- 候補の「紐づける」で証憑の空の項目が相手から埋まり、監査ログに `document.link` と `document.update` が残る。
- 320px で一覧・詳細・規程が操作でき、横スクロールが出ない。撮影ボタンの `<input>` に `capture` がある。
- `npm run check`、`test:db`、`next build` が通る。
