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

## 構成（予定）

```
apps/web          Next.js（画面・API route・ジョブの入口）
packages/ledger   複式簿記のコア（仕訳・残高・税計算・締め）。DB やフレームワークに依存しない
packages/importers 銀行・カードの CSV パーサと Stripe 同期
packages/reports  試算表・月次推移・決算書・各種エクスポート
packages/db       Prisma schema と migration
```

## 開発

```sh
npm ci
npm run check   # typecheck + lint + unit
```

（実装の着手前。コマンドは実装とともに更新する）

## ライセンス

NIHO が保有するコード・文書は all rights reserved です。閲覧・fork は GitHub の利用規約に従います。詳細は [`LICENSE`](LICENSE)。
