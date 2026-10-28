# 復元（S8）

帳簿を失ったとき・確かめたいときの手順と、年 1 回の復元訓練（[07 §6](../design/07-operations.md)）の記録です。

## 1. 何から復元するか

| 元 | 使うとき | 粒度 |
| --- | --- | --- |
| 日次エクスポート（バックアップバケット `exports/<日付>/<時刻>Z/`。非公開側 `niho-finance-core` にも写す） | 帳簿の中身を確かめたい、別の DB に立てたい、年 1 回の訓練 | 1 日 1 回（03:00 JST） |
| Cloud SQL の自動バックアップ（7 日）と PITR | インスタンスやデータベースそのものが壊れた | 任意の時点 |

エクスポートの中身: `snapshot.json`（全テーブル。bigint は文字列、日付は ISO）、`trial-balance.json`（会計期間ごとの試算表）、`manifest.json`（各ファイルの SHA-256、書き出し時の migration 名と git の SHA）。S7（#8）の CSV / beancount は merge 後に同じフォルダに並ぶ。

## 2. 日次エクスポートからローカルに復元する

```sh
# 1. エクスポートを取ってくる（niho-finance-core に写しがあればそれでよい）
gcloud storage cp -r "gs://<バックアップバケット>/exports/<日付>/<時刻>Z" ./tmp/restore/

# 2. 空の DB を作って migration を流す（manifest.json の migration まで。新しい migration があっても列の追加だけなら通る）
docker exec niho-finance-postgres-1 createdb -U niho niho_finance_restore
DATABASE_URL="postgresql://niho:niho_dev_password@localhost:5433/niho_finance_restore?schema=public" npm run db:migrate

# 3. 復元して試算表を突き合わせる（一致すれば `restore: OK`、違えば差分を出して exit 1）
DATABASE_URL="postgresql://niho:niho_dev_password@localhost:5433/niho_finance_restore?schema=public" npm run db:restore -- ./tmp/restore/<時刻>Z

# 4. 画面で見る
DATABASE_URL="postgresql://niho:niho_dev_password@localhost:5433/niho_finance_restore?schema=public" npm -C apps/web run dev -- -p 3316
```

- `db:restore` は空の DB（会社・仕訳・監査ログが 0 件）にしか入れない。
- 仕訳は台帳のガードを通して入れる（仕訳と行を同じトランザクションで、取消は登録後に取消の列だけを更新）。復元後も登録済みの仕訳は書き換えられない。
- `db:restore` は先に `manifest.json` の SHA-256 とサイズを照合し、違えば復元せずに止まる。相対パスは `npm run` を実行した場所から解決する。
- 復元先の migration がエクスポート時点（`manifest.json` の `migration`）より新しいときは警告して続行する。表や列が合わないときは `manifest.json` の `gitSha` のコミットで復元する。

## 3. Cloud SQL から復元する

インスタンスは NIHO アプリと共有なので、インスタンスごと戻さない。時点を指定して別インスタンスに複製し、`niho_finance` だけを取り出す。

1. `gcloud sql instances clone <instance> <instance>-restore --point-in-time <RFC3339>`（複製は課金される。終わったら削除する）
2. 複製から `niho_finance` を `gcloud sql export sql <instance>-restore gs://<バックアップバケット>/sql/<日付>.sql --database niho_finance`
3. 中身を確かめる（手元の PostgreSQL に `psql -f` で入れ、`/api/health` と試算表を見る）
4. 本番に戻すときは `gcloud sql databases delete niho_finance` → `gcloud sql databases create niho_finance` → `gcloud sql import sql <instance> gs://…/sql/<日付>.sql --database niho_finance` → `scripts/deploy.sh --no-build`（migrate ジョブが権限を付け直す）
5. `gcloud sql instances delete <instance>-restore`

## 4. 訓練の記録

年 1 回（決算の後）。手順は §2。

| 日付 | 元 | 復元先 | 結果 | 備考 |
| --- | --- | --- | --- | --- |
| 2026-10-28 | 本番の日次エクスポート（`backup-export` を Scheduler から手で起動し、GCS から取得） | local の空の DB | OK。manifest の SHA-256 が一致し、0 行・0 期で一致（会社の登録前で帳簿が空） | GCS → 手元 → `db:restore` の経路の確認 |
| 2026-10-28 | 架空データ（seed の第 1 期。取消と反対仕訳を含む仕訳 13 件）の日次エクスポート（同じコードのジョブを local で実行） | local の空の DB | OK。25 表 215 行を復元し、第 1 期の試算表（12 科目、借方合計 = 貸方合計）が一致 | 帳簿に中身がある状態での照合 |

次回: 本番の帳簿に第 1 期の仕訳が入り、最初の月を締めた後に、本番のエクスポートでもう一度行う。
