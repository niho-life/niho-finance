# 06. 技術構成

NIHO アプリと同じ技術（TypeScript / Next.js / Prisma / PostgreSQL / GCP Cloud Run）で、1 社・1〜数人向けの小さな Web アプリとして作ります。台帳のコアはフレームワークに依存しないパッケージに分け、単体テストで不変条件を守ります。

## 1. モノレポ

npm workspaces。コマンドは `npm -C <dir> ...`。

| パス | 役割 | 依存 |
| --- | --- | --- |
| `packages/ledger` | 仕訳の検証・登録・取消、残高と試算表の計算、税区分と消費税の計算、締め、連番。純粋な TypeScript。I/O なし | なし |
| `packages/importers` | 銀行・カード CSV のパーサ（形式ごとに 1 モジュール＋ゴールデンテスト）、Stripe の balance transaction 取得と明細への変換、重複判定 | `ledger`（型） |
| `packages/reports` | 仕訳帳・総勘定元帳・試算表・月次推移・セグメント PL・決算書・財務諸表 CSV・freee/弥生 CSV・beancount の生成 | `ledger` |
| `packages/db` | Prisma schema、migration、リポジトリ層（仕訳の原子的な登録、監査ログの追記、明細の取込と Stripe の同期） | Prisma、`importers`（取込の判別と変換。[12](12-imports.md)） |
| `apps/web` | Next.js（App Router）。画面、Server Actions、route handler（Stripe 同期・バックアップのジョブ入口）、PDF 生成 | 上の全部 |

`ledger` は DB を知らない。`db` が「仕訳を 1 トランザクションで書き、監査ログを追記し、連番を採る」責務を持つ。画面から直接 Prisma を呼ばない。

## 2. 主要な技術

| 領域 | 採用 | 理由 |
| --- | --- | --- |
| 言語 / ランタイム | TypeScript strict、Node 22 | NIHO アプリと同じ |
| Web | Next.js App Router、React、Tailwind | 画面と API を 1 つに。Server Actions で入力、route handler でジョブ |
| DB | PostgreSQL（ローカルは 16、本番は既存の Cloud SQL インスタンスの 15）、Prisma | 既存の運用知識。bigint・トランザクション・部分索引 |
| 検証 | Zod | 入力の境界で型を固める |
| PDF | `@react-pdf/renderer` または Playwright の印刷 | 請求書・決算書（v2）。日本語フォントを同梱 |
| CSV | 自前の小さなパーサ（RFC 4180・BOM・Shift_JIS は `TextDecoder`）＋ 形式ごとのモジュール | 銀行・カードの取込。依存を増やさない（[12 §3.2](12-imports.md)） |
| Stripe | `stripe` 公式 SDK、読み取り専用の制限付きキー | 2 アカウントを `Stripe-Account` ヘッダーまたは各アカウントのキーで読む |
| 読み取り（v2） | Claude の vision（画像 → 構造化 JSON） | 領収書の日付・金額・税率別内訳・登録番号。確信度つき |
| テスト | Vitest（単体・不変条件・ゴールデン）、Playwright（主要導線の最小限） | |
| ログ | pino → Cloud Logging | |

## 3. 実行環境

| 環境 | 場所 | 用途 |
| --- | --- | --- |
| local | 各 Mac の Docker Postgres または Cloud SQL Proxy | 開発。シードは架空データ |
| prod | GCP Cloud Run（1 サービス）＋ Cloud SQL ＋ GCS | 本番。stg は置かない（1 ユーザーで、本番前の確認は local で足りる） |

### 3.1 GCP の配置

- プロジェクト: 既存の NIHO 本番プロジェクトに置く（請求先が同じ会社になるため）。将来分けたくなったら `pg_dump` と GCS のコピーで移せる。
- Cloud Run: 同じイメージから `niho-finance`（画面。IAP）と `niho-finance-jobs`（ジョブ。IAP なし、Cloud Run の IAM で Scheduler のサービスアカウントだけ）の 2 サービス（どちらも min 0 / max 1、同時実行 1 ユーザー想定。[決定](../decisions/2026-10-28-jobs-service-without-iap.md)）。配備のたびに Cloud Run ジョブ `niho-finance-migrate` が migration を流す。コールドスタートは許容。
- Cloud SQL: 既存インスタンス（PostgreSQL 15、private IP のみ）に新しいデータベース `niho_finance` と専用ロール 2 つ（migration 用とアプリ用）を作る（追加の固定費なし）。アプリのロールには `audit_log`・`journal_line` への UPDATE / DELETE を与えない（`scripts/db/grants.sql`）。
- GCS: 証憑（オブジェクトのバージョニング ON、保持ポリシー 7 年）と日次エクスポート（保持ポリシー 10 年）の 2 バケット。名前はプロジェクトを前置するのでリポには書かない。アプリのサービスアカウントは作成と閲覧だけ（削除・上書き不可）。
- Secret Manager: Stripe の制限付きキー、DB 接続（ロールごと）、メールのアプリパスワード、銀行 API のキー。発行と更新は `docs/ops/secrets.md`。
- Cloud Scheduler: 日次の Stripe 同期、日次バックアップ、月次の登録番号照合、期限の通知。
- 通知: 期限や取込の失敗はメール（Gmail API または SendGrid）。LINE は使わない。

### 3.2 認証

Cloud Run の IAP（Identity-Aware Proxy）直接統合で Google アカウント（会社のアカウント）だけを通す。アプリは IAP の署名ヘッダー（`x-goog-iap-jwt-assertion`）を検証し、そのメールを actor として記録する（`apps/web/lib/actor.ts`）。ジョブ用サービスは IAP を通さず（IAP は呼び出し元の ID を置き換えるため）、Cloud Run の IAM で Scheduler のサービスアカウントだけを通す。IAP が使えない構成なら Auth.js の Google ログインで許可メールを固定する。v3 の複数ユーザーも IAP の許可リストと DB の役割で足りる。

### 3.3 ドメイン

画面サービスに Cloud Run のドメインマッピングで会社のドメインのサブドメインを付ける（[決定](../decisions/2026-10-28-custom-domain-mapping.md)。証明書は Google 管理で自動更新、追加費用なし）。ドメインマッピングはプレビュー機能なので、止まったときは `run.app` の URL で使い続ける。ジョブ用サービスは `run.app` のまま（Scheduler は `run.app` の URL でしか内部の呼び出しにならない）。

## 4. ジョブ

| ジョブ | 周期 | 内容 |
| --- | --- | --- |
| `stripe-sync` | 毎日 06:00 JST | 2 アカウントの balance transactions をカーソルから取得して明細化。失敗はメール |
| `bank-sync`（v2） | 毎日 | 銀行 API の入出金明細を取得 |
| `backup-export` | 毎日 03:00 JST | 全テーブルの JSON スナップショット・会計期間ごとの試算表・manifest（SHA-256）を GCS に書き、S7 の CSV / beancount を同じフォルダに足す。Cloud SQL の自動バックアップとは別 |
| `calendar-notify` | 毎日 09:00 JST | 会計期間から `CalendarItem` を生成（冪等）し、7 日前・当日・超過の期限を 1 通のメールで知らせる |
| `invoice-registry-verify`（v2） | 毎月 | 取引先の登録番号を国税庁 API で照合 |

ジョブは route handler（`/api/jobs/<name>`）で、ジョブ用サービス（`NIHO_FINANCE_SERVICE=jobs`）でだけ動く。Cloud Run の IAM が Scheduler のサービスアカウント以外を弾き、アプリ側でも OIDC トークンを検証する（`apps/web/lib/jobs/`）。失敗しても throw せず、`event=job.finished ok=false` のログを 1 行残して HTTP 500 で終える。Scheduler は再試行しない（再試行の嵐を避ける）。

## 5. 公開境界と秘密

| 公開リポ（niho-finance） | 非公開側 |
| --- | --- |
| コード、設計・運用の文書、架空データのシードとテスト | 会社の実データ（DB・GCS）、`niho-finance-core`（会社固有の設定ファイル、事務処理規程の実物、日次エクスポートの写し） |
| CSV 形式の定義（列名だけ） | 口座番号・支店名などの実値 |
| Stripe の同期ロジック | アカウント ID・キー（Secret Manager） |
| `.env.example` | `.env`（ローカル）、Cloud Run の env と Secret |

- 会社固有の値はすべて DB か Secret Manager に置き、コードに埋めない。設定画面から入力する。
- テストのフィクスチャは架空の会社・架空の口座。実データを混ぜない。
- Issue / PR も公開。金額・取引先・口座の実値を書かない。

`niho-finance-core` は当面ローカルフォルダ（iCloud / Drive に同期しない。Time Machine の対象にする）で始め、日次エクスポートの写しを自動で受け取る段階になったら非公開リポにする（git の履歴がそのまま改ざん検知になる）。

## 6. データ保護

| 項目 | 方法 |
| --- | --- |
| バックアップ | Cloud SQL 自動バックアップ（7 日）＋ PITR。加えて日次エクスポート（`backup-export`）を GCS（バージョニング・保持 10 年）に保存 |
| 復元訓練 | 年 1 回、local にエクスポートを読み込んで試算表が一致することを確認する（`npm run db:restore`。手順と記録は `docs/ops/restore.md`） |
| 証憑 | GCS のバージョニング ON、削除保護（保持ポリシーは「ロックしない」で 7 年）。アプリからの削除は論理削除のみ |
| 改ざん検知 | 証憑は SHA-256、仕訳は監査ログ（追記のみ）。日次エクスポートの差分を非公開 git に積む |
| 秘密 | Secret Manager。Stripe は読み取り専用の制限付きキー（Balance transactions / Payouts / Charges / Invoices の read） |
| アクセス | IAP の許可メールだけ。管理画面の URL は非公開 |

## 7. CI と配備

- CI（GitHub Actions、公開リポ）: typecheck、lint、unit、`prisma validate`、ゴールデンテスト。秘密は使わない。
- 配備: v1 は Mac から `scripts/deploy.sh`（Cloud Build でイメージを作り、Cloud Run ジョブで `prisma migrate deploy`、`gcloud run deploy` で 2 サービス。手順は `docs/ops/deploy.md`）。公開リポの Actions に GCP の権限を持たせない。配備の記録は `docs/ops/deploy-log.md` ではなく Cloud Run のリビジョン履歴で足りる。
- migration は expand → contract（列の削除は配備の 1 つ後）。

## 8. コストの見積り

| 項目 | 月額（目安） |
| --- | --- |
| Cloud Run（min 0、1 ユーザー） | 0〜300 円 |
| Cloud SQL（既存インスタンスに同居） | 追加 0 円（分離する場合は最小構成で 1,500 円前後） |
| GCS（証憑・バックアップ、数 GB） | 50 円未満 |
| Secret Manager / Scheduler / Logging | 0〜100 円 |
| 読み取り（LLM、月 100 枚） | 100〜300 円 |
| 合計 | 500 円未満 |

## 9. 観測

- エラーは Cloud Logging の severity で拾い、週 1 のまとめをメール。アラートポリシーは「ジョブの失敗」と「5xx」の 2 つだけ。
- 画面の操作ログは監査ログで足りる。分析用のトラッキングは入れない。

## 10. 参考にした OSS と借りた設計

調査の全文は [`../research/oss.md`](../research/oss.md)。日本の小規模法人の要件（消費税・インボイス・電子帳簿保存法・法人の決算書）を標準で満たす成熟した OSS はなく、「依存先」ではなく「設計の参考」として 3 層に分けて借ります。ライセンスが AGPL / BSL / Elastic のものはコードを写しません。

| 層 | 参考元 | 借りるもの |
| --- | --- | --- |
| 台帳コア | pgledger（MIT）、TigerBeetle の設計文書（Apache-2.0）、Medici（MIT） | 不変の台帳、符号付き金額と前後残高、訂正は新しい取引で行う、取消 = 反対仕訳＋元への参照 |
| 会計アプリ | Bigcapital（AGPL・設計のみ）、ERPNext / Frappe Books（設計のみ）、Odoo の会計コア（LGPL・体系のみ） | 元文書 → 仕訳の転記（`sourceKind` / `sourceId`）、銀行明細の「未分類 → ルール → 突合 → 登録」の状態機械、段階的なロック（通常 / 期末、理由つきの例外）、期末の損益振替を仕訳として残す |
| 日本ローカライズ | freee の公開 API スキーマ（MIT）、Odoo `l10n_jp`（体系のみ）、個人事業主向けの TS 実装（tsumiki-kaikei は MIT、aoiko / domble は AGPL・設計のみ） | freee 風のデータモデル（取引・振替伝票の決算整理フラグ・口座明細・税区分・固定資産・レポート）、e-Tax 勘定科目コードを科目に持つ、税区分を「申告書の集計区分」としてマスタ化し税率・期間・経過措置を期間つきデータに分ける、DB のトリガーで確定後の UPDATE / DELETE を禁止、貸借一致を commit 時に検証、確定仕訳のハッシュ連鎖 |

本システムに取り込む具体策:

- `packages/db` の migration で、`journal_entry` / `journal_line` の `posted` 行への UPDATE / DELETE を禁止するトリガーと、貸借一致を deferred constraint（commit 時）で検証する関数を持つ。アプリのバグでも帳簿が壊れない。
- 確定仕訳に前の仕訳のハッシュを含めたハッシュ（`entryHash`）を持ち、日次エクスポートで連鎖を検証する（電子帳簿保存法の訂正削除履歴の補強。v2 で可）。
- 税区分は「申告書の集計区分」（課税売上 10% / 軽減 8% / 非課税 / 不課税 / 輸出 / 課税仕入 10% / 8% / インボイスなし / 対象外 / 簡易課税の事業区分）を固定コードにし、税率・控除割合・適用期間は `TaxRateRule` として別表で持つ。
- 勘定科目に e-Tax の勘定科目コードを持ち、財務諸表 CSV（HOT010）へ直結する。
- beancount の `balance` アサーション相当として、口座の残高（明細の `balanceAfter`・Stripe の残高・現金の実査）と帳簿残高の一致を月次の締めで検証する。
