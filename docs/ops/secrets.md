# 鍵の発行と更新（S8）

値は Secret Manager にだけ置きます。ローカルの `.env`・`scripts/deploy.env`・Issue・PR・この文書に値を書きません（[06 §5](../design/06-architecture.md)）。読む権限は実行サービスアカウント（`niho-finance-runner`）だけで、Secret ごとに `roles/secretmanager.secretAccessor` を付けます。

## 1. 一覧

| Secret | 使う所 | 中身 | 更新 |
| --- | --- | --- | --- |
| `niho-finance-database-url` | 画面・ジョブ（`DATABASE_URL`）、migrate ジョブ（`NIHO_FINANCE_APP_DATABASE_URL`） | アプリ用ロール `niho_finance_app` の接続 URL | 年 1 回 |
| `niho-finance-migrate-database-url` | migrate ジョブ（`DATABASE_URL`） | migration 用ロール `niho_finance_migrate` の接続 URL | 年 1 回 |
| `niho-finance-smtp-password` | 画面・ジョブ（`NIHO_FINANCE_SMTP_PASSWORD`） | 送信元アカウントのアプリパスワード | 年 1 回 |
| `niho-finance-stripe-*` | S4（#5）が定める | Stripe の制限付きキー（読み取り専用） | 年 1 回（[07 §6](../design/07-operations.md)） |

接続 URL の形は `postgresql://<role>:<password>@localhost/niho_finance?host=/cloudsql/<接続名>`（Cloud SQL コネクタの Unix ソケット）。パスワードは英数字だけ（`scripts/db/migrate.sh` が URL から取り出すため）。

## 2. 発行

- DB の 2 ロール: `scripts/gcp-bootstrap.sh resources` がパスワードを生成して Secret に入れる。migration 用ロールは Cloud SQL の API で作り（テーブルの所有者）、アプリ用ロールは migrate ジョブが `niho-finance-database-url` の値から `CREATE ROLE … LOGIN NOCREATEDB NOCREATEROLE` で作る（superuser ではない。Cloud SQL では属性 `NOSUPERUSER` を書くことも拒まれるので既定に任せる）。パスワードは画面にもログにも出ない。
- SMTP のアプリパスワード: 送信元の Google アカウントで 2 段階認証を有効にし、「アプリパスワード」を発行して、発行した人が自分で入れる:

```sh
printf '%s' '<app password>' | gcloud --project <project> secrets versions add niho-finance-smtp-password --data-file=-
```

入れたら `scripts/deploy.sh --no-build`（サービスが新しい版で起動する）→ `scripts/run-job.sh mail-check` で「[NIHO finance] 送信の確認」が届くことを見る。Google アカウントのパスワードを変えるとアプリパスワードは無効になる。そのときは毎朝の `calendar-notify` が SMTP のログインで失敗し、「ジョブの失敗」のアラートが届くので、発行し直す。

- Stripe: S4（#5）の手順。制限付きキーは Balance transactions / Payouts / Charges / Invoices の read だけ。

## 3. 更新（ローテーション）

順序はいつも「新しい版を足す → 配備し直す → 古い版を無効化する」。配備は `scripts/deploy.sh --no-build`（イメージはそのまま、サービスとジョブが最新の版で起動する）。

| 鍵 | 手順 |
| --- | --- |
| migration 用ロール | 新しいパスワードを作る → `gcloud sql users set-password niho_finance_migrate --instance <instance> --password '<new>'` → 新しい URL を `niho-finance-migrate-database-url` に足す → `scripts/deploy.sh --no-build` |
| アプリ用ロール | 新しい URL（パスワードだけ変える）を `niho-finance-database-url` に足す → `scripts/deploy.sh --no-build`（migrate ジョブが `ALTER ROLE … PASSWORD` を流してからサービスが上がる） |
| SMTP | 新しいアプリパスワードを発行して足す → `scripts/deploy.sh --no-build` → `scripts/run-job.sh mail-check` で「送信の確認」が届くことを見る → Google 側で古いアプリパスワードを削除 |
| Stripe | 新しい制限付きキーを発行して足す → `scripts/deploy.sh --no-build` → Stripe 側で古いキーを失効 |

古い版: `gcloud secrets versions disable <n> --secret <name>`（しばらく置いてから `destroy`）。

## 4. ローカル

`.env` は docker compose の使い捨ての値だけ。本番の Secret をローカルに写さない。メールはローカルでは `NIHO_FINANCE_MAIL=log`（送らずログに出す）。
