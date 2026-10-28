# NIHO finance

NIHO株式会社の自社用の会計システムです。複式簿記の台帳を中心に、銀行・カード・Stripe の明細を取り込み、現預金と損益（PL）をいつでも把握し、決算書まで自分たちで作ることを目的にしています。freee のような汎用会計 SaaS の代わりに、1 人〜数人の会社で「毎月の経理が 1 時間で終わる」ことに最適化します。

- 設計書: [`docs/design/`](docs/design/)（[00 概要](docs/design/00-overview.md) から順に読む）
- 調査メモ: [`docs/research/`](docs/research/)
- 決定記録: [`docs/decisions/`](docs/decisions/)
- 運用手順: [`docs/ops/`](docs/ops/)

## 公開境界

このリポジトリは公開です。コードと汎用の設計・運用文書だけを置き、次のものは置きません。

- 会社の実データ（仕訳・明細・証憑・取引先・金額）
- 法人番号・口座番号・インボイス登録番号・Stripe のアカウント ID・内部 URL
- API キー・シークレット・バックアップ

これらは非公開側（`niho-finance-core`。当面はローカルフォルダ、必要になったら非公開リポ）と GCP の Secret Manager・DB・ストレージに置きます。詳細は [`docs/design/06-architecture.md`](docs/design/06-architecture.md) の「公開境界」を参照してください。

## 構成

```
apps/web           Next.js（画面・API route・ジョブの入口）
packages/ledger    複式簿記のコア（仕訳の検証・残高と試算表・税計算・取消・連番）。DB やフレームワークに依存しない
packages/importers 銀行・カードの CSV パーサと Stripe 同期（S4 で実装）
packages/reports   試算表・月次推移・決算書・各種エクスポート（S7 で実装）
packages/db        Prisma schema と migration、仕訳の登録・取消と監査ログ（[packages/db/README.md](packages/db/README.md)）
```

## 開発

前提: Node.js 22 以上、Docker（`docker compose`）。

```sh
npm ci                     # 依存の導入（Prisma Client も生成する）
cp .env.example .env       # ローカルの接続先: docker compose の PostgreSQL 16（port 5433）
npm run db:up              # PostgreSQL を起動して healthy まで待つ
npm run db:migrate         # migration を適用（prisma migrate deploy）
npm run db:seed            # 架空の会社「架空商会株式会社」の第 1 期・勘定科目・仕訳を投入（投入済みなら何もしない）
npm run check              # typecheck + lint + unit
npm run test:db            # DB のテスト（niho_finance_test を作り直し、migrate と seed をしてから実行）
npm -C apps/web run dev    # http://localhost:3000 （/api/health で DB の疎通を確認できる）
```

初期化ウィザードは、会社のない DB で `npm -C apps/web run dev` を起動して `/setup` を開きます（`/` も会社がなければ `/setup` へ移る）。seed 済みの DB を残したまま試すときは、空の DB を作って `DATABASE_URL=postgresql://.../niho_finance_try npm run db:migrate` の後、同じ `DATABASE_URL` で dev を起動します。画面とルートは [apps/web/README.md](apps/web/README.md)。

| コマンド | 内容 |
| --- | --- |
| `npm run db:down` | PostgreSQL を止める（データは volume に残る） |
| `npm run db:reset` | DB を作り直して migration と seed をやり直す |
| `npm run db:migrate:dev` | `schema.prisma` の変更から migration を作る（手順は [packages/db/README.md](packages/db/README.md)） |
| `npm run format` | Prettier で整形する |

- 設定はリポジトリ直下の `.env` から読みます。すでに環境変数があればそちらが優先です。ただし、シェルが別プロジェクトの DB（名前が `niho_finance` / `niho_finance_*` でないもの）を指す `DATABASE_URL` を export しているときは、`.env` の値に置き換えて警告を出します。CI と Cloud Run は `.env` を置かず、環境変数で渡します。
- DB に触るコマンドとアプリは、DB 名が `niho_finance` か `niho_finance_*` でなければ止まります。別の DB で試すときは `DATABASE_URL=postgresql://.../niho_finance_try npm run db:migrate` のように渡します。
- シードとテストのデータはすべて架空です。実データ・実在の口座や番号を足さないでください。

## ライセンス

NIHO が保有するコード・文書は all rights reserved です。閲覧・fork は GitHub の利用規約に従います。詳細は [`LICENSE`](LICENSE)。
