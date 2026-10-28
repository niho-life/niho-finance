# 配備（S8）

NIHO finance を GCP に配備し、毎月使える状態に保つ手順です。設計は [06 技術構成](../design/06-architecture.md) §3〜§9、決定は [D7](../decisions/2026-10-28-gcp-shared-project.md)（既存の本番プロジェクトに同居）と [ジョブ用サービスの分離](../decisions/2026-10-28-jobs-service-without-iap.md)。

このリポジトリは公開なので、プロジェクト ID・プロジェクト番号・URL・バケット名・許可するメールアドレスは書きません。それらは手元の `scripts/deploy.env`（`.gitignore` 済み。雛形は [`scripts/deploy.env.example`](../../scripts/deploy.env.example)）に置き、スクリプトが読みます。

## 1. 構成

| 資源 | 名前（既定） | 内容 |
| --- | --- | --- |
| Cloud Run サービス | `niho-finance` | 画面。IAP で許可した Google アカウントだけが通る。min 0 / max 1、同時実行 1 ユーザー想定、`NIHO_FINANCE_SERVICE=web` |
| Cloud Run サービス | `niho-finance-jobs` | ジョブ（`/api/jobs/<name>`）。同じイメージ。IAP なし・未認証の呼び出し不可。`roles/run.invoker` は Scheduler 用のサービスアカウントだけ。`NIHO_FINANCE_SERVICE=jobs` |
| Cloud Run ジョブ | `niho-finance-migrate` | `prisma migrate deploy` と権限の付与（`scripts/db/grants.sql`）。配備のたびに新しいイメージで 1 回実行する |
| Cloud SQL | 既存インスタンス（PostgreSQL 15）に データベース `niho_finance` | 専用ロール 2 つ: `niho_finance_migrate`（テーブルの所有者。migration だけが使う）と `niho_finance_app`（アプリ。`audit_log` と `journal_line` の UPDATE / DELETE / TRUNCATE を持たない） |
| GCS | 証憑バケット | オブジェクトのバージョニング ON、保持ポリシー 7 年（ロックしない）、公開アクセス禁止、均一なバケットレベルのアクセス。アプリのサービスアカウントは作成と閲覧だけ（削除・上書き不可）。CORS は画面の origin（`run.app` と `APP_URL`）からの `PUT`（ブラウザが署名付き URL へ直接送る。13 §6） |
| GCS | バックアップバケット | 日次エクスポート。保持ポリシー 10 年（ロックしない）、公開アクセス禁止 |
| Secret Manager | `niho-finance-database-url`、`niho-finance-migrate-database-url`、`niho-finance-mail-password` | 鍵の発行と更新は [secrets.md](secrets.md) |
| Cloud Scheduler | `niho-finance-stripe-sync`（毎日 06:00 JST）、`niho-finance-backup-export`（毎日 03:00 JST）、`niho-finance-calendar-notify`（毎日 09:00 JST） | `niho-finance-jobs` の `/api/jobs/<name>` へ POST。OIDC（audience はジョブ用サービスの URL）。再試行なし |
| サービスアカウント | `niho-finance-runner` | 2 つのサービスとジョブの実行 ID。Secret の読み取り、Cloud SQL クライアント、バケットの読み書き |
| サービスアカウント | `niho-finance-scheduler` | Scheduler が OIDC トークンを作る ID。`niho-finance-jobs` の `roles/run.invoker` だけ |
| Artifact Registry | `niho-finance`（Docker） | 配備イメージ。直近 5 個だけ残す |
| Cloud Build | — | `cloudbuild.yaml` で `runtime`（画面・ジョブ）と `migrate` の 2 イメージを 1 回のビルドで作る |
| Cloud Tasks | `niho-finance-manual` | ジョブの手動実行（`scripts/run-job.sh`）。再試行なし・同時 1 |
| Cloud Monitoring | アラート 2 つ | 「ジョブの失敗」（ジョブ用サービスのログ `event=job.finished ok=false`）と「5xx」（画面サービスの 5xx）。通知先はメール |

```
ブラウザ ──IAP──▶ Cloud Run niho-finance ──┐
                                            ├─ Cloud SQL (niho_finance) ── Secret Manager
Cloud Scheduler ──OIDC──▶ Cloud Run niho-finance-jobs ─┤
                                            └─ GCS（証憑 / バックアップ）──▶ 手元の niho-finance-core（rsync）
```

### 1.1 画面とジョブを分けた理由

Cloud Run の IAP は呼び出し元の ID を IAP のものに置き換えるため、Scheduler の OIDC トークンをアプリで検証できません（IAP を通す場合、サービスアカウントの認証には IAP 側の OAuth クライアントの許可が別に要ります）。画面は IAP、ジョブは Cloud Run の IAM（`run.invoker`）＋アプリの OIDC 検証という、どちらも標準の経路に分けます。イメージ・DB・Secret は共有し、どちらも min 0 なので固定費は増えません。

### 1.2 ネットワーク

Cloud SQL は private IP のみなので、サービスとジョブは Direct VPC egress（`default` ネットワーク・`private-ranges-only`）で VPC に出て、Cloud SQL コネクタ（Unix ソケット `/cloudsql/<接続名>`）で接続します。インターネット（Stripe・SMTP・Google API）は Cloud Run から直接出るので Cloud NAT は使いません。`DATABASE_URL` は `postgresql://<role>:<password>@localhost/niho_finance?host=/cloudsql/<接続名>` の形です。

## 2. 環境変数

| 変数 | 画面 | ジョブ | 内容 |
| --- | --- | --- | --- |
| `NIHO_FINANCE_ENV` | `prod` | `prod` | 環境名。`prod` では IAP の検証を必須にする |
| `NIHO_FINANCE_SERVICE` | `web` | `jobs` | `jobs` のときだけ `/api/jobs/*` が動く（画面側では 404） |
| `NIHO_FINANCE_IAP_AUDIENCE` | `/projects/<番号>/locations/<リージョン>/services/niho-finance` | — | IAP の署名ヘッダー（`x-goog-iap-jwt-assertion`）の audience。`scripts/deploy.sh` が組み立てる |
| `DATABASE_URL` | Secret | Secret | `niho_finance_app` ロール |
| `NIHO_FINANCE_MAIL` | `smtp` | `smtp` | `log`（ローカル。送らずにログに出す）/ `smtp` |
| `NIHO_FINANCE_MAIL_FROM` / `_TO` | ○ | ○ | 送信元と通知の宛先（カンマ区切り） |
| `NIHO_FINANCE_SMTP_HOST` / `_PORT` / `_USER` | ○ | ○ | 既定 `smtp.gmail.com` / `465` |
| `NIHO_FINANCE_SMTP_PASSWORD` | Secret | Secret | アプリパスワード |
| `NIHO_FINANCE_BACKUP_BUCKET` | — | ○ | 日次エクスポートの書き先（ローカルは `NIHO_FINANCE_BACKUP_DIR`） |
| `NIHO_FINANCE_DOCUMENTS_BUCKET` | ○ | ○ | 証憑（S6 #7 が使う） |
| `NIHO_FINANCE_APP_URL` | ○ | ○ | メールに載せる画面の URL |
| `NIHO_FINANCE_GIT_SHA` | ○ | ○ | 配備したコミット（バックアップの manifest とヘルスチェックに載る） |
| `NIHO_FINANCE_JOB_AUDIENCE` / `_SERVICE_ACCOUNT` | — | ○ | Scheduler の OIDC トークンの `aud`（ジョブ用サービスの URL）と、そのサービスアカウントのメール（12 §5。`scripts/deploy.sh` が入れる） |
| `NIHO_FINANCE_JOB_TOKEN` | — | ローカルだけ | 手元でジョブを `curl` するときの Bearer（`NIHO_FINANCE_ENV=prod` では無視） |
| `NIHO_FINANCE_STRIPE_KEY_<NAME>` | Secret | Secret | Stripe の制限付きキー。Secret `niho-finance-stripe-key-<name>` に版があれば `scripts/deploy.sh` が結ぶ（[secrets.md](secrets.md)） |

## 3. 初回だけ（資源の作成）

`scripts/gcp-bootstrap.sh` が冪等に作ります（あるものは飛ばす）。実行前に `scripts/deploy.env` を書き、Secret の値は実行中に標準入力で渡します（ファイルに残さない）。

1. API の有効化（run・sqladmin・secretmanager・cloudscheduler・iap・artifactregistry・cloudbuild・monitoring・logging）
2. サービスアカウント 2 つと権限
3. Cloud SQL: データベース `niho_finance`、ロール 2 つ（パスワードは生成して Secret へ）
4. Artifact Registry と GCS バケット 2 つ。Cloud Build は既定でプロジェクトの compute サービスアカウントで動くので、ソースの tarball を置く `<project>_cloudbuild` バケットの読み取り（`roles/storage.objectViewer`）を付ける
5. Secret 3 つ。DB の 2 つは生成した値が入る。SMTP のアプリパスワードは端末があれば入力を求め、なければ仮の値（`placeholder`）を 1 版入れて配備を通す。本物は発行した人が [secrets.md §2](secrets.md) の手順で足す（それまでメールは失敗し、`calendar-notify` が失敗として記録される）
6. 最初のビルドと配備（`scripts/deploy.sh`）。migrate ジョブが `prisma migrate deploy` と `grants.sql` を流す
7. IAP: IAP のサービスエージェントに `run.invoker`、画面サービスで IAP を有効化、許可するアカウントに `roles/iap.httpsResourceAccessor`
8. Scheduler 3 つ（ジョブ用サービスの URL が決まってから）
9. 監視: 通知チャネル（メール）とアラート 2 つ

## 4. 毎回の配備

```sh
scripts/deploy.sh            # 現在の HEAD を配備する（clean な worktree で、main を取り込んでから）
scripts/deploy.sh --no-build # いま動いているイメージのまま配備し直す（Secret の新しい版を読ませる）
```

1. `gcloud builds submit --config cloudbuild.yaml`（イメージのタグは git の SHA）
2. `niho-finance-migrate` を新しいイメージで実行し、終わるまで待つ（失敗したら配備を止める）
3. `niho-finance` と `niho-finance-jobs` を新しいイメージで配備（env と Secret も毎回渡す）
4. ブラウザで画面の `/api/health` を開き、`db: true` と `iap: "verified"`（IAP の署名を検証できた = 書き込みが通る）と `gitSha` を確かめる

配備の記録は Cloud Run のリビジョン履歴で足ります（06 §7）。migration は expand → contract（列の削除は配備の 1 つ後）。

## 5. 認証と actor

- 画面: IAP が通した要求には `x-goog-iap-jwt-assertion` が付く。`apps/web/lib/actor.ts` が IAP の公開鍵（ES256）・発行者・audience を検証し、`email` を Server Action の actor（監査ログ）にする。`NIHO_FINANCE_ENV=prod` でヘッダーがない・検証に失敗したときは書き込みを拒む。ローカルは従来どおり `NIHO_FINANCE_ACTOR`（既定 `owner`）。
- ジョブ: Cloud Run の IAM が Scheduler のサービスアカウント以外を弾き、アプリでも `runJob`（`apps/web/lib/jobs/run.ts`）が S4 の `verifyJobRequest`（`apps/web/lib/jobs/auth.ts`。Google の署名・`aud`・サービスアカウント）で確かめる。`NIHO_FINANCE_SERVICE=jobs` 以外では 404。ジョブの書き込みの actor は `system`（stripe-sync はサービスアカウントのメール）。
- 手元でジョブを動かす: `.env` に `NIHO_FINANCE_SERVICE=jobs` と `NIHO_FINANCE_JOB_TOKEN=<任意の文字列>` を置いて dev を起動し、`curl -X POST -H "Authorization: Bearer <その文字列>" localhost:3000/api/jobs/backup`。
- 許可するアカウントを足す・外す（将来の 2 人目など）: `scripts/deploy.env` の `IAP_MEMBERS` に `user:<email>` をカンマ区切りで足して `scripts/gcp-bootstrap.sh access` を流す（既存の許可はそのまま、足した人だけ増える）。外すときは `gcloud beta iap web remove-iam-policy-binding --resource-type=cloud-run --service=niho-finance --region=<リージョン> --member=user:<email> --role=roles/iap.httpsResourceAccessor`。いまの許可一覧は `gcloud beta iap web get-iam-policy --resource-type=cloud-run --service=niho-finance --region=<リージョン>`。
- v1 は 1 ユーザーなので、許可された人は誰でも owner として書ける（役割の区別は v3）。監査ログには IAP のメールが actor として残る。

## 6. ジョブ

| ジョブ | 周期（JST） | 内容 | 失敗のとき |
| --- | --- | --- | --- |
| `stripe-sync` | 06:00 | 接続済みの Stripe 口座の balance transactions を明細化（12 §4） | 同期の失敗でも 200 を返し（12 §4.4）、`job.finished ok=false` を記録する |
| `backup-export` | 03:00 | `exports/<日付>/<時刻>Z/` に、全テーブルの JSON スナップショット（復元用）・会計期間ごとの試算表・`book/`（S7 の書き出し: 設定と仕訳の JSON、仕訳 CSV、beancount、明細と証憑の索引。会社の登録後）・manifest（全ファイルの SHA-256）を、DB の同じ時点から書く | 同上 |
| `calendar-notify` | 09:00 | 会計期間から `CalendarItem` を生成（冪等）し、7 日前・当日・超過の期限をメール。知らせる期限がない日も SMTP のログインまで確かめる（アプリパスワードの失効を期限の前に失敗として知らせる） | 同上 |
| `mail-check` | 手動だけ | 「送信の確認」を 1 通送る（アプリパスワードを入れた・更新したとき） | 同上 |

- どのジョブも例外を外に投げず、`{"severity":"ERROR","event":"job.finished","job":"…","ok":false,…}` を 1 行で記録して HTTP 500 を返す。Scheduler は再試行しない（`--max-retry-attempts=0`）。
- 手で動かす: `scripts/run-job.sh mail-check|backup|calendar|stripe-sync`。ジョブ用サービスは内部からしか受けないので、Cloud Tasks のキュー（`niho-finance-manual`、再試行なし）から Scheduler と同じサービスアカウントの OIDC で呼び、`job.finished` のログを待って結果を出す。Scheduler のジョブは `gcloud scheduler jobs run <name> --location <リージョン>` でも動く。

## 7. バックアップと復元

- Cloud SQL の自動バックアップ（7 日）と PITR は既存インスタンスの設定のまま `niho_finance` にも効く。
- 日次エクスポートはバックアップバケットに 10 年残る。非公開側（`niho-finance-core`。当面ローカルフォルダ）へ写す: `gcloud storage rsync -r gs://<バックアップバケット>/exports <niho-finance-core>/exports`。
- 復元の手順と訓練の記録は [restore.md](restore.md)。

## 8. 監視

| アラート | 条件 | 通知 |
| --- | --- | --- |
| ジョブの失敗 | `niho-finance-jobs` のログに `jsonPayload.event="job.finished" AND jsonPayload.ok=false` | メール |
| 5xx | `niho-finance` の `request_count`（`response_code_class=5xx`）が 5 分で 1 件以上 | メール |

## 9. コスト（月額の見込み）

| 項目 | 見込み |
| --- | --- |
| Cloud Run ×2（min 0）と migrate ジョブ | 0〜300 円 |
| Cloud SQL（既存インスタンスに同居） | 0 円 |
| GCS（証憑・バックアップ） | 50 円未満 |
| Cloud Scheduler 3 件（無料枠 3 件は既存のジョブで使い切っている。止めていても課金される） | 約 45 円 |
| Cloud Tasks（手動実行。月 100 万回まで無料） | 0 円 |
| Secret Manager（有効なバージョン 6 つまで無料） | 0 円 |
| Artifact Registry（直近 10 イメージ） | 10 円未満 |
| Cloud Build（1 日 120 分まで無料） | 0 円 |
| 合計 | 06 §8 の「500 円未満」の範囲（オーナーの上限は月 300 円） |

請求の確かめ方: ラベルを付けられる資源（Cloud Run のサービスとジョブ・GCS・Artifact Registry・Secret Manager）はすべて `app=niho-finance` を持つので、Cloud Billing のレポートでラベルに絞ると NIHO アプリと分けて見られる。Cloud Scheduler はラベルを持てないので SKU（ジョブ数）で見る。Cloud SQL は共有インスタンスなので分けられない（追加の固定費はない）。

## 10. 独自ドメイン

画面サービスに Cloud Run のドメインマッピング（証明書は Google 管理、追加費用なし。プレビュー機能だが同じプロジェクトの NIHO アプリでも使っている）で会社のドメインのサブドメインを付ける。ジョブ用サービスは `run.app` のまま（Scheduler は `run.app` の URL にしか内部扱いで届かない）。

1. ドメインの所有確認（Search Console）が gcloud のアカウントで済んでいること: `gcloud domains list-user-verified`
2. `gcloud beta run domain-mappings create --service niho-finance --domain <host> --region <リージョン>`
3. `gcloud beta run domain-mappings describe --domain <host> --region <リージョン>` の `resourceRecords` を DNS に登録する（CNAME。Cloudflare なら「DNS のみ」で、プロキシを通さない）
4. 証明書が出るまで待つ（数分〜1 時間）。`scripts/deploy.env` の `APP_URL` にその URL を書き、`scripts/deploy.sh --no-build` でメールに載る URL を、`scripts/gcp-bootstrap.sh access` で証憑バケットの CORS を更新する

IAP はサービスに掛かっているので、独自ドメイン経由でも `run.app` 経由でも同じ許可リストで通る。
