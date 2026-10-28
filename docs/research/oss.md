<!-- 調査メモ。2026-10-28 に subagent が GitHub と Web で収集。stars・最終更新は取得日の値。ライセンスの扱いは本文の注意に従う。設計の正は docs/design/ -->

# 調査レポート: freee 風の複式簿記会計ソフト（TypeScript 自作）の参考になる OSS・台帳ライブラリ

- 調査日: 2026-10-28
- 対象: 日本の小規模株式会社（創業者 1 人・3 月決算）向けに、freee 風の複式簿記会計ソフトを TypeScript で自作する際の参考元
- 方法: WebSearch（standard 主体、薄い所だけ extended）、WebFetch、GitHub REST API（stars・license・最終 push の取得と、ファイル一覧・生ファイルの閲覧のみ。git clone はしていない）、npm registry
- stars・最終 push は 2026-10-28 に GitHub API で取得した値（「約」として読むこと）。
- 凡例: 「（未確認）」は今回確認できていない事項、「（検索結果要約ベース）」は原文を直接読めず検索結果の要約に依拠した事項、「（二次情報）」は第三者の記事に依拠した事項。税務の記述は参考であり、実装時は国税庁の最新資料で確認すること。

---

## 1. 総評と推奨の参考元トップ5

### 1.1 総評

1. **日本の小規模法人（消費税・インボイス・3 月決算・電子帳簿保存法）を標準機能で満たす成熟した OSS は見つからなかった。** 2026-08-29 付の Qiita 調査記事（二次情報）も「調査範囲では日本の税制を標準で満たす OSS は見当たらない」「JIIMA 認証を受けた OSS もない」「e-Tax へ直接書き出す OSS が見当たらない」と同じ結論。本調査でも、法人向けの e-Tax 財務諸表 CSV/XBRL や法人税別表を生成する OSS は見つからなかった。
2. **2026 年に入り、個人事業主（青色申告）向けの TypeScript 製 OSS が多数出ている**（aoiko、domble、openkk、kanean、e-shiwake、opentax など）。ただしいずれも作成から数か月、stars は 0〜11、AGPL が多く、法人（別表・株主資本等変動計算書・個別注記表・eLTAX）は対象外。「設計の参考」にはなるが「依存先」にはならない。
3. **現実的な戦略は 3 層に分けて参考にすること。**
   - (a) 台帳コア（不変性・残高・冪等性・訂正）: pgledger / TigerBeetle / Medici / ledgerkit / Lefra
   - (b) 会計アプリ層（伝票→仕訳の転記、期間ロック、期末、銀行取込、請求書）: Bigcapital / ERPNext / Frappe Books / Odoo
   - (c) 日本ローカライズ層（e-Tax 科目コード、消費税の税区分、付表、インボイス、XTX/CSV）: Odoo `l10n_jp` と、個人事業主向けの TS 実装、国税庁の公開仕様
4. **ライセンスで取り込める範囲が大きく違う。** MIT / Apache-2.0（pgledger、TigerBeetle、Medici、Lefra、freee-mcp、freee-api-schema、Cala、Blnk）は取り込み可。AGPL-3.0（Bigcapital、Frappe Books、aoiko、domble、opentax、kanean）は「設計の参考のみ・コードは写さない」が安全。BSL 1.1（Akaunting）と Elastic License 2.0（Invoice Ninja、Midaz）は改造・再提供に制限があり不向き。Odoo Community は LGPL-3.0 で、`l10n_jp` の CSV をそのまま転載すると派生物扱いになりうるので、体系（コード・区分の考え方）を参考に自前で作るか、法務確認を取る。
5. **beancount / hledger / ledger-cli で日本の法人の経理をしている個人開発者のブログ・repo は見つからなかった。** 見つかったのは個人事業主（青色申告・同人経理）の事例のみで、いずれも消費税・インボイスは未対応か記述なし、減価償却は手計算（詳細は 4.9）。ただし「残高アサーション」「期末の繰越・要約の考え方」「証憑リンク」は自作の参考になる。

### 1.2 推奨の参考元トップ5

| 順位 | 参考元 | 何を借りるか（要点） | ライセンス・注意 |
|---|---|---|---|
| 1 | **freee/freee-api-schema（OpenAPI）+ freee/freee-mcp** | 「freee 風」の正解データモデル。`deal`（取引: 明細ごとに account_item_id・tax_code・entry_side・vat・部門・メモタグ・セグメント、支払 payments は口座 walletable から）、`manual_journal`（振替伝票。`adjustment` 決算整理フラグ付き）、`wallet_txn`（口座明細→取引へ突合）、`taxes`、`journals`、`fixed_assets`、`reports`（試算表など）。OpenAPI は 107 パス・180 スキーマ | schema は MIT、freee-mcp は Apache-2.0（TypeScript、★513）。API の写像であって内部実装ではない |
| 2 | **Odoo（会計コア + `l10n_jp`）** | 日本語名つき 208 科目（コードは e-Tax 勘定科目コード体系 `10A100020` 現金及び預金 など）、税 55 件（売上 10/8/0/輸出/非課税、簡易課税 第 1〜6 種、仕入 10/8、非適格請求書発行者の控除割合 80/70/50/30%）、税グループ、フィスカルポジション（国内取引/非適格請求書発行者/海外取引）、消費税申告のレポート定義（付表 1-3/2-3/4-3/5-3 相当）、償却モデル。コアは `account.move`/`account.move.line`/`account.tax`（repartition + タグ）、ロック日付（通常/税/ハード+例外）、確定仕訳のハッシュ連鎖 | LGPL-3.0。CSV の転載は派生物扱いの可能性（要法務確認）。Python で TS には直接流用不可 |
| 3 | **Bigcapital** | TS 製で唯一の本格的な会計アプリ OSS。元文書→GL の転記（`referenceType/referenceId`）、`Ledger` 値オブジェクト（reverse）、区分別の取引ロック（全体/売上/仕入/財務+部分解除+理由）、銀行明細の「未分類→ルール認識→突合→分類」パイプライン（freee の口座明細→登録に最も近い OSS 実装） | AGPL-3.0（設計参考のみ）。GL 行は元文書の編集で書き換わる可変設計。日本の税区分は無し |
| 4 | **pgledger（+ TigerBeetle の設計文書、Medici）** | Postgres 上の最小・不変の台帳（11KB の SQL）。accounts（balance・version・負残高禁止）/ transfers（from→to・amount>0・event_at）/ entries（符号付き金額・前後残高・account_version）、アカウント ID をソートしてロックしデッドロック回避。TigerBeetle は ledger（通貨）/code（種別）/user_data による分類、訂正は新しい transfer で行う作法。Medici は journal + transactions の多脚仕訳と「void = 逆仕訳 + 元仕訳へのリンク」 | pgledger: MIT、TigerBeetle: Apache-2.0、Medici: MIT。pgledger の transfer は 2 脚（複合仕訳は束ねて表現）。Medici は MongoDB 専用・浮動小数（precision 0 で整数モード） |
| 5 | **個人事業主向け TS/SQL 実装（aoiko、domble、tsumiki-kaikei）** | aoiko: 訂正仕訳+履歴、国税庁 XSD に基づく XTX 生成（KOA020/210/110、消費税 SHA/SHB）、銀行・カード CSV パーサー 10 種超、経過措置 80/70/50/30% の消費税試算。domble: SQLite トリガーで更新・削除を禁止、ハッシュ連鎖 `audit_chain`、公式 XSD で XML 検証、純粋関数の会計ロジック。tsumiki-kaikei: Postgres のトリガー（貸借一致を commit 時に検証、確定後の編集禁止）、税区分を「税率」でなく「申告書の集計区分」として持ち、税率・期間・経過措置はデータ（`tax_relief_rules`）に分離、勘定科目→決算書行のマップ | aoiko/domble は AGPL-3.0、tsumiki-kaikei は MIT。いずれも ★0・作成数か月・個人向けで、依存せず設計参考に留める |

### 1.3 次点（トップ 5 に入らなかった理由つき）

- **ERPNext**: GL Entry の列設計、Period Closing Voucher、`enable_immutable_ledger` は優れた教科書。ただし Python/Frappe 前提で巨大、日本の勘定科目テンプレートなし（国別 CoA 約 70 本の中に jp が無い）。設計の読み物としては必読（3.4）。
- **Frappe Books（旧）**: `LedgerPosting`（借貸を積む→検証→保存/逆転）は TS で書かれた小さく読みやすい転記ビルダー。ただし 2026-10-02 にアーカイブ（EOL）、AGPL。
- **Beancount / Fava / hledger**: 日本の法人事例なし。ただし `balance` アサーション・`pad`・`document`・`OPEN ON/CLOSE ON/CLEAR`・`hledger close` は期末処理と検証の考え方として有用。
- **GnuCash**: Account/Transaction/Split と有理数金額、Close Book を「ただの取引」で表す発想。デスクトップ GPL で TS への直接流用は不可。
- **Akaunting / Invoice Ninja / Midaz**: ライセンス制限（BSL 1.1 / Elastic License 2.0）のため非推奨。

### 1.4 自作設計への示唆（調査から言える範囲）

1. 仕訳は「ヘッダ + 明細」。金額は整数円（bigint）。貸借一致は DB の deferred constraint などで commit 時に検証（tsumiki-kaikei）。
2. 確定後は UPDATE/DELETE 禁止（DB トリガー: tsumiki-kaikei、domble）。訂正は赤伝（逆仕訳）+ 新仕訳（Fowler の Reversal Adjustment、dbconcept の赤黒訂正、Square/TigerBeetle の補償エントリ）。元文書が可変な設計（Bigcapital）は電帳法の訂正削除履歴の観点で別途履歴が要る。
3. 「取引（deal）→仕訳」の 2 層にする（freee、Mercari の matter_id、Fowler の Posting Rule、Cala の取引テンプレート）。freee は決算整理仕訳を `manual_journal.adjustment` で区別。
4. 税区分は税率ではなく申告書の集計区分としてマスタ化し、税率・適用期間・経過措置（80/70/50/30% など）は期間付きデータにする（tsumiki-kaikei、Odoo の tax tag、open-journal-rules）。端数処理は「税率ごと・請求書 1 枚につき 1 回」（japan-invoice-mcp、jp-invoice）。
5. 勘定科目に e-Tax の勘定科目コードを持たせると、法人の財務諸表 CSV（HOT010 Ver.3.0、Shift-JIS）に直結できる（Odoo `l10n_jp` が実例。4.5）。
6. ロックは「通常ロック」「税務ロック」「ハードロック」のように段階化し、例外（期限つき・理由つき）を残す（Odoo、Bigcapital）。期末の損益振替は仕訳として残す方式（ERPNext PCV、GnuCash Close Book）と、レポート時に要約する方式（Odoo の当期純損益、Beancount の CLEAR）がある。
7. 銀行取込は「未分類→ルール→突合→登録」の状態機械（Bigcapital、freee の wallet_txn、clovis の pending/reconciled）。
8. 電帳法は「訂正削除履歴を全取引について確保」（国税庁 Q&A。5.2）が設計要件。あわせて OSS の e-shiwake は検索要件として「日付・金額・取引先」を挙げ、証憑との関連付けも実装している（これらの検索・関連性要件の国税庁原文は今回未確認）。JIIMA 認証を受けた OSS は見つからなかった。

---

## 2. 一覧表

### 2.1 基本情報（汎用会計・プレーンテキスト会計・台帳ライブラリ・請求書）

最終 push は GitHub API の `pushed_at`。★は stargazers。日本固有 OSS は 4 章の表にまとめた。

| # | 区分 | プロジェクト（URL） | ★ | 言語・スタック | ライセンス | 最終 push・状態 |
|---|---|---|---|---|---|---|
| 1 | 汎用会計 | Akaunting https://github.com/akaunting/akaunting | 約 10.2k | PHP（Laravel）+ Vue + Tailwind。MariaDB/MySQL/PostgreSQL/SQLite | BSL 1.1（4 年後に GPLv3。追加使用許諾: 2 ユーザー超・1 社超・請求書 1,000 件超の本番利用、リブランド再配布、会計サービス提供は不可） | 2026-10-28・活発 |
| 2 | 汎用会計 | Bigcapital https://github.com/bigcapitalhq/bigcapital | 約 4.0k | TypeScript。NestJS 10 + Objection/Knex + MariaDB（mysql2）+ Redis（bull/bullmq）、React/Vite、PDF は Gotenberg、Plaid、分析は ClickHouse | AGPL-3.0 | 2026-10-27・活発（モノレポ: packages/server, webapp） |
| 3 | 汎用会計 | Frappe Books（旧）https://github.com/frappe/books | 約 5.0k | TypeScript + Vue + Electron + SQLite | AGPL-3.0 | 最終 push 2026-10-02・**同日 archived（EOL）**。後継は https://github.com/frappe/frappe-books（★約 55、TS、Frappe Framework 上、2026-08 作成、AGPL-3.0、2026-10-26 push） |
| 4 | 汎用会計 | ERPNext（会計部分）https://github.com/frappe/erpnext | 約 40.7k | Python + JS（Frappe Framework）、MariaDB | GPL-3.0 | 2026-10-28・活発 |
| 5 | 汎用会計 | Odoo（会計部分）https://github.com/odoo/odoo | 約 55.4k | Python、PostgreSQL | LGPL-3.0（Community）。高度な会計機能は Enterprise（二次情報） | 2026-10-28・活発 |
| 6 | 汎用会計 | GnuCash https://github.com/Gnucash/gnucash | 約 4.4k | C/C++（GTK）+ Scheme/Python バインディング。XML/SQLite/MySQL/PostgreSQL | GPL v2 または v3（選択） | 2026-10-20・活発（5.x 系） |
| 7 | プレーンテキスト | beancount https://github.com/beancount/beancount | 約 6.1k | Python（+C パーサ）。v3 で importer（beangulp）・query（beanquery）が別 repo に分離 | GPL-2.0 | 2026-08-23 |
| 8 | プレーンテキスト | Fava https://github.com/beancount/fava | 約 2.6k | Python + JS（Beancount の Web UI） | MIT | 2026-10-25・活発 |
| 9 | プレーンテキスト | hledger https://github.com/hledgerorg/hledger（旧 simonmichael/hledger） | 約 4.8k | Haskell（CLI/TUI/Web） | GPL-3.0 | 2026-10-28・活発 |
| 10 | プレーンテキスト | ledger-cli https://github.com/ledger/ledger | 約 6.1k | C++（CMake、Boost、GMP、MPFR） | BSD-3-Clause | 2026-10-22・活発 |
| 11 | 台帳ライブラリ | Medici https://github.com/flash-oss/medici | 約 360 | TypeScript（v5 で TS 化）。Node + Mongoose/MongoDB | MIT | 2026-07-29（v7.4.0）。npm 週 DL 約 1.9k |
| 12 | 台帳ライブラリ | TigerBeetle https://github.com/tigerbeetle/tigerbeetle | 約 17.3k | Zig（専用の金融取引 DB。各言語クライアント） | Apache-2.0 | 2026-10-23・活発 |
| 13 | 台帳ライブラリ | Formance Ledger https://github.com/formancehq/ledger | 約 1.5k | Go。v2.x は PostgreSQL、**v3（main、rc.1 は 2026-10-14）は Raft + Pebble で Postgres を使わない** | v2.4.16 は MIT。**main（v3）のルートに LICENSE ファイルが無い（要確認）** | 2026-10-27・活発（v2.4.16 は 2026-10-21） |
| 14 | 台帳ライブラリ | pgledger https://github.com/pgr0ss/pgledger | 約 500 | PostgreSQL の SQL（テーブル・関数・ビュー）。性能テストは Go | MIT | 2026-10-27・活発（2025-03 公開） |
| 15 | 台帳ライブラリ（TS） | Lefra https://github.com/radzserg/lefra | 約 10 | TypeScript + PostgreSQL（slonik）。npm `lefra` 1.0.4 | MIT | 2026-07-24 |
| 16 | 台帳ライブラリ（TS） | ledgerkit https://github.com/themusashimaru/ledgerkit | 約 0 | TypeScript、実行時依存ゼロ、仕訳帳はメモリ上（永続化は利用側） | MIT | 2026-08-23（2026-07 作成） |
| 17 | 台帳ライブラリ（TS） | node-pgledger https://github.com/duniyalr/node-pgledger | 約 1 | TypeScript（pgledger 用の型・ユーティリティ） | 未設定 | 2025-12-10 |
| 18 | 台帳ライブラリ（TS） | clovis https://github.com/cloviscomputing/clovis | 約 1 | TypeScript + SQLite（複式台帳、CLI、MCP）。npm `clovis` 1.3.0 | AGPL-3.0-or-later | 2026-09-29 |
| 19 | 台帳ライブラリ | Cala（Galoy）https://github.com/GaloyMoney/cala | 約 43 | Rust + PostgreSQL（event sourcing、outbox） | Apache-2.0 | 2026-10-27 |
| 20 | 台帳ライブラリ | Blnk https://github.com/blnkfinance/blnk | 約 570 | Go（ledger / balances / reconciliation） | Apache-2.0 | 2026-10-24 |
| 21 | 台帳ライブラリ | Midaz https://github.com/lerianstudio/midaz | （未確認。集計サイトでは約 380） | Go（コアバンキング基盤） | **現行は Elastic License 2.0**（旧版は Apache-2.0） | 集計サイトでは 2026-05 時点（未確認） |
| 22 | 請求書 | Invoice Ninja https://github.com/invoiceninja/invoiceninja | 約 10.3k | PHP（Laravel）+ Flutter/React | Elastic License 2.0（source-available。ホステッドサービスとしての提供不可） | 2026-10-27・活発 |
| 23 | 請求書 | Crater https://github.com/crater-invoice-inc/crater | 約 8.4k | PHP（Laravel）+ Vue、モバイルは React Native | AGPL-3.0 | **最終 push 2024-08-10（停滞）** |
| 24 | 請求書 | InvoiceShelf https://github.com/InvoiceShelf/InvoiceShelf | 約 1.9k | PHP（Laravel 想定）+ Vue/TypeScript | AGPL-3.0 | 2026-10-27・活発（2.x が stable、3.x は alpha） |
| 25 | 参考 | LedgerSMB https://github.com/ledgersmb/LedgerSMB | 約 570 | Perl + PostgreSQL | GPL-2.0（README の記載） | 2026-10-26 |
| 26 | 参考（対象外） | Dolibarr（★約 7.8k、PHP、GPL-3.0）、Firefly III（★約 25k、PHP、AGPL-3.0、個人家計簿） | — | — | — | 会計ソフトとしては本件の主対象でないため詳細調査せず |
| 27 | npm 小型 TS | accounting-up（npm） | — | TypeScript、SQLite（会社ごとに 1 ファイル）。ledger/tax/invoicing/bank/expenses/bills/payroll/inventory のモジュール分割。カナダ税対応 | MIT（npm 記載） | 2026-10-22 更新（2026-10-04 作成の初期版 0.1.6） |
| 28 | npm 小型 TS | @companyio/accounting（npm） | — | 業務ドキュメントはアダプタ経由で GL に転記する設計。ホストが PostgreSQL を所有 | **license 未記載** | 2026-10-23 更新 |
| 29 | npm 小型 TS | @mulmoclaude/accounting-plugin（https://github.com/receptron/mulmoclaude、★約 386） | — | TypeScript のプラグイン（shared/vue/server）。ワークスペースファイル保存のバックエンド | MIT | 2026-10-26 push（データモデル詳細は未確認） |
| 30 | npm 小型 | @fin.cx/skr（npm） | — | ドイツの標準勘定科目表 SKR03/SKR04 を「国別 CoA パッケージ」として配布 | （未確認） | 2026-10-17 更新 |

### 2.2 データモデル比較（勘定科目 / 仕訳 / 税区分 / 請求書 / 銀行取込）

| プロジェクト | 勘定科目 | 仕訳 | 税区分 | 請求書 | 銀行取込 |
|---|---|---|---|---|---|
| **freee（API スキーマ）** | `account_items`（勘定科目 ID・コード） | 取引 `deal`（明細 details: 科目・税区分コード・貸借 entry_side・税額 vat、部門・品目・メモタグ・セグメント）が仕訳を生成。直接入力は `manual_journal`（`adjustment` 決算整理フラグ） | `tax_code`（整数。`taxes` で一覧） | `invoices` / `quotations` が取引とは別リソースとして存在 | `walletables`（口座）→ `wallet_txns`（口座明細）を取引へ突合・登録 |
| **Bigcapital** | `accounts`（code, accountType, parentAccountId, predefined） | GL = `accounts_transactions`（元文書 referenceType/Id、debit/credit、為替、basis=発生/現金）。手動仕訳 `manual_journals` + entries | `tax_rates` + `tax_rate_transactions`、明細に taxRateId・isInclusiveTax | 売上請求書・見積・領収・請求受領・クレジットノート等が共通明細 `items_entries` を共有 | Plaid / CSV → 未分類 → `bank_rules` → 認識 → 突合 → 分類 |
| **ERPNext** | Account（木 lft/rgt、root_type、report_type、account_type、tax_rate、freeze）。国別 CoA テンプレート約 70 本（日本なし） | GL Entry（voucher_type/no、posting_date、fiscal_year、is_opening、is_cancelled、通貨 3 層） + Journal Entry | Tax Category / Sales Taxes and Charges Template / Item Tax Template（設定項目名から。詳細未精査） | Sales/Purchase Invoice | Bank Transaction + 突合ツール（自動突合・fuzzy matching・ルール自動実行の設定あり） |
| **Odoo** | `account.account`（code, account_type, tag）。`l10n_jp` は 208 科目（e-Tax 科目コード体系） | `account.move`（entry/請求書/請求受領/領収書を同一テーブルで move_type 区別）+ `account.move.line`（debit/credit/balance/amount_currency, tax_ids, tax_repartition_line_id, tax_tag_ids） | `account.tax`（percent/fixed/group/division、price_include、repartition lines、tax group）+ fiscal position + タグ→申告書レポート | `account.move`（out_invoice 等） | `account.bank.statement(.line)` + `account.reconcile.model` + partial/full reconcile |
| **Akaunting** | コアは銀行・現金口座（Banking\Account）+ Category。複式（勘定科目表・手動仕訳・試算表）は**有償アプリ** | コアに GL なし。Transaction（収入/支出）+ Transfer | `Tax`、`DocumentItemTax`、`TransactionTax` | `Document`（請求書と請求受領を type で統一）+ `DocumentItem` + `DocumentTotal` + `DocumentHistory` | `Reconciliation` モデル（詳細未確認） |
| **Frappe Books（旧）** | Account（木） | `AccountingLedgerEntry`（date, account, party, debit, credit, referenceType/Name, reverted, reverts）+ JournalEntry | Tax スキーマ | SalesInvoice / PurchaseInvoice | 未確認 |
| **GnuCash** | accounts（guid, parent_guid, account_type, commodity, code, placeholder, hidden） | transactions + splits（value と quantity を別持ち、分子/分母の有理数） | taxtables（business 側） | business 系テーブル（customers/vendors/invoices/entries/jobs） | OFX/QIF/CSV 取込（既知機能・今回は未検証） |
| **Beancount** | `open`/`close` ディレクティブ。根は Assets/Liabilities/Equity/Income/Expenses の 5 種 | transaction（postings 合計 0 を強制）、`balance`、`pad`、`document`、tags/links/metadata | 組み込みなし（metadata/タグで自作） | なし（LWN: 請求書機能は無い） | importer（beangulp）。日本向けは見つからず |
| **hledger** | `account` 宣言 + type タグ（A/L/E/R/X） | transaction（`!`/`*` 状態、periodic `~`、auto posting `=`、残高アサーション） | なし（日本の事例でも未対応） | なし | CSV 取込ルール（自作が必要） |
| **Medici** | `account_path`（`:` 区切りの文字列） | `Medici_Journals`（ヘッダ）+ `Medici_Transactions`（明細。credit/debit/meta/voided/_original_journal） | なし（meta で自作） | なし | なし |
| **pgledger** | `pgledger_accounts`（name, currency, balance, version, allow_negative/positive） | `pgledger_transfers`（from→to, amount>0, event_at, metadata）+ `pgledger_entries`（符号付き amount, 前後残高, account_version） | なし | なし | なし |
| **TigerBeetle** | Account（ledger, code, flags, user_data_128/64/32, debits/credits の pending/posted） | Transfer（debit_account_id, credit_account_id, amount, ledger, code, pending_id…）。不変 | なし | なし | なし |
| **Formance v2** | アカウントは `users:001` のようなコロン区切りアドレス | transaction = postings（source, destination, amount, asset）+ metadata。moves / accounts_volumes / ハッシュ連鎖 logs（マイグレーション名から） | なし | なし | なし |

---

## 3. 各プロジェクトの要点

書式: 基本情報は 2 章の表を参照。ここでは「データモデルの要点」「借りるべき設計」「注意」を書く。

### 3.1 Akaunting（https://github.com/akaunting/akaunting ／ 約 10.2k★ ／ PHP Laravel ／ BSL 1.1 ／ 2026-10-28 活発）

- データモデル:
  - 勘定科目: コアには勘定科目表がない。`Banking\Account` は銀行・現金口座、`Setting\Category` が収支分類。**複式簿記（勘定科目表・手動仕訳・総勘定元帳・試算表・BS/PL）は有償の「Double-Entry」アプリ**（公式サイトの料金表示: 年払い $72/年〜、買い切り $756）。
  - 仕訳: コアには GL が無く、`Banking\Transaction`（収入/支出）と `Transfer`（口座間移動）。
  - 税区分: `Setting\Tax` + `Document\DocumentItemTax` + `Banking\TransactionTax`（明細ごとの税）。
  - 請求書: `Document\Document` が請求書と請求受領を type で統一し、`DocumentItem` / `DocumentItemTax` / `DocumentTotal`（小計・税・割引・合計を行として保持）/ `DocumentHistory`。
  - 銀行取込: `Banking\Reconciliation` モデルあり（取込の詳細は未確認）。
- 借りるべき設計: 請求書と請求受領を 1 つの document モデルで type 区別すること、合計行（小計・税・割引・合計）を別行として持つこと。
- 注意: BSL 1.1 の追加使用許諾は「2 ユーザー超・1 社超・請求書 1,000 件超」「リブランド再配布」「第三者への会計サービス提供」を禁止（LICENSE.txt 確認済み）。改造して自社 SaaS にするのは不可。設計の参考のみ。

### 3.2 Bigcapital（https://github.com/bigcapitalhq/bigcapital ／ 約 4.0k★ ／ TypeScript ／ AGPL-3.0 ／ 2026-10-27 活発）

- スタック: NestJS 10 + Objection/Knex + mysql2（MariaDB）、Redis、React/Vite、Gotenberg（PDF）、Plaid、ClickHouse（`Analytics` モジュールで台帳を同期）。マイグレーションは `database/system` と `database/tenant` に分離（システム DB + テナント別 DB と推定）。
- データモデル:
  - 勘定科目: `accounts`（name, code, accountType, parentAccountId, predefined, currencyCode, active、Plaid 連携列）。
  - 仕訳: GL は `accounts_transactions`（accountId, debit, credit, exchangeRate, date, **referenceType / referenceId = 元文書**, transactionType, contactId/contactType, branchId, projectId, itemId, index/indexGroup, taxRate/taxRateId, `basis` = 発生/現金）。手動仕訳は `manual_journals`（journalNumber, journalType, publishedAt = 下書き→公開, basis, attachments）+ `manual_journals_entries`。元文書の保存時に GL を生成し、編集・削除時は `LedgerRevertService` が元文書単位で GL を逆転して書き直す。`Ledger` は `filter / whereAccount / whereFromDate / … / reverse()` を持つ値オブジェクト。**GL 行自体は書き換わる可変設計**（不変台帳ではない）。
  - 税区分: `tax_rates`（code, name, rate, active）+ `tax_rate_transactions`（referenceType/Id, rate, taxAccountId）。明細 `items_entries` に taxRate / taxRateId / isInclusiveTax。日本の課税区分（課税・非課税・不課税・免税）、控除割合、申告書集計は無い。
  - 請求書: sales_invoices / sales_estimates / sales_receipts / bills / credit notes / vendor credits が共通明細 `items_entries`（referenceType, referenceId, index, itemId, sellAccountId, costAccountId, quantity, rate, discount…）を共有。
  - 銀行取込: Plaid + Import モジュール。`uncategorized_cashflow_transactions`（amount, date, payee, description, categorized, excludedAt, pending, recognizedTransactionId, categorizeRefType/Id）→ `bank_rules`（order, applyIfAccountId, applyIfTransactionType, conditions[], assignCategory / AccountId / Payee / Memo）による自動認識 `recognized_bank_transactions` → `matched_bank_transactions`（既存の請求書・仕訳への突合）→ 分類。
  - ロック: `TransactionsLocking`（グループ all / sales / purchases / financial、`lockToDate` + 理由、`unlockFromDate〜unlockToDate` + 理由の部分解除、書込みガード）。
- 借りるべき設計: ① 元文書と GL を `referenceType/referenceId` で結ぶ転記方式 ② 区分別ロック日付 + 理由 + 部分解除 ③ 銀行明細の「未分類→ルール認識→突合→分類」の状態遷移（freee の自動登録ルールに最も近い OSS 実装）。
- 注意: AGPL-3.0（改変版を SaaS で提供するとソース開示義務）。設計の参考にとどめ、コードは写さない。Plaid は日本の銀行に使えない可能性が高い（未確認）。

### 3.3 Frappe Books（旧）／ frappe-books（新）（https://github.com/frappe/books ／ 約 5.0k★ ／ TypeScript + Vue + Electron + SQLite ／ AGPL-3.0 ／ 2026-10-02 archived）

- 状態: 2026-10-02 に archived（README: 「End of life。Frappe Framework 上の frappe/frappe-books に置き換え」。Issue #1566 は「fork して自由に使ってよい」旨）。新 repo は ★約 55、TS、AGPL-3.0、2026-08 作成で、Frappe Framework 前提。
- データモデル:
  - 勘定科目: Account（木構造）。
  - 仕訳: `AccountingLedgerEntry`（date, account, party, debit, credit, referenceType, referenceName, **reverted, reverts**）+ JournalEntry。金額は `pesa` の Money（整数ベース）。
  - 転記: `LedgerPosting`（取引文書 1 件に対し `debit(account, amount)` / `credit(...)` を積み、`post()` で貸借一致を検証して保存、`postReverse()` で取消）。`makeRoundOffEntry()` が端数差を丸め科目へ振る。`revert()` は元行に `reverted = true` を立て、借貸を反転した行（`reverts` で元行を参照、日付は取消日）を追加し、物理削除しない。
  - 税・請求書: Tax / SalesInvoice / PurchaseInvoice / Payment のスキーマ（`schemas/{app,core,meta,regional,tests}`）。銀行取込は未確認。日本語 UI なし。
- 借りるべき設計: ① 文書ごとの「Posting ビルダー」（借貸を積む→検証→保存／逆転）② `reverted` / `reverts` による取消の双方向リンク ③ 端数差を丸め科目に振る処理。
- 注意: 旧 repo は保守終了。AGPL-3.0。

### 3.4 ERPNext（会計部分）（https://github.com/frappe/erpnext ／ 約 40.7k★ ／ Python + Frappe ／ GPL-3.0 ／ 2026-10-28 活発）

- データモデル（GitHub 上の doctype JSON から抽出）:
  - 勘定科目: Account（`lft/rgt` の入れ子集合による木、root_type = Asset/Liability/Income/Expense/Equity、report_type = BS/PL、account_type、tax_rate、freeze_account、balance_must_be、account_number、disabled）。国別 CoA テンプレート JSON が約 70 本（us, in, au, sg, tw, id, de SKR03/04, fr, nl など）。**日本（jp）は無い**。`erpnext/regional` にも日本なし。
  - 仕訳: **GL Entry**（35 項目: posting_date, account, party_type/party, cost_center, project, debit/credit（会社通貨）+ `*_in_account_currency` + `*_in_transaction_currency` + `*_in_reporting_currency`, voucher_type / voucher_no / voucher_detail_no = 元文書, against / against_voucher, is_opening, is_advance, fiscal_year, finance_book, **is_cancelled**）。Journal Entry は提出式ドキュメント。
  - 税区分: Tax Category / Sales Taxes and Charges Template / Item Tax Template（Accounts Settings の項目名から。詳細は未精査）。`round_row_wise_tax`（明細単位で端数処理するか）の設定。
  - 請求書・銀行: Sales/Purchase Invoice、Payment Entry、Bank Transaction + 突合ツール（Accounts Settings に auto_reconcile_payments、enable_party_matching、enable_fuzzy_matching、automatically_run_rules_on_unreconciled_transactions がある）。
  - 期末: Fiscal Year（year_start_date, year_end_date, is_short_year, disabled, companies）。**Period Closing Voucher**（提出式。company + fiscal_year + closing_account_head + period_start/end。損益残高を資本科目へ振り替え、BS 残高は繰越。**古い年度から順に閉じる**、後続の PCV があると不可、closing 科目は非グループの Liability/Equity。**過去日付の入力は PCV では止まらない**ので Accounts Frozen Upto / Accounting Period で凍結。同じ年度に追加仕訳があれば PCV を再提出して差分だけ振替）。`ignore_account_closing_balance` で PCV 未実施でもレポートを GL から作る。
  - 不変性: Accounts Settings の **`enable_immutable_ledger`**（有効にすると取消エントリを実際の取消日に計上し、レポートは取消済みも考慮）。`delete_linked_ledger_entries` は逆に削除する設定。`repost_allowed_types` で再転記。
- 日本対応: コアは弱い。「ERPNext.JP」は商用で、OSS としての repo は見つからなかった（Ecosire が「ERPNext Japan Qualified Invoice」という有償の Frappe アプリを約 $499〜999 で提供と掲示。v15/v16 対象。販売者の主張で未検証）。
- 借りるべき設計: ① GL Entry の列設計（元文書の参照、is_cancelled、is_opening、fiscal_year、通貨 3 層）② 期末の損益振替を「提出式の仕訳ドキュメント」として残す PCV ③ 不変性を設定で切り替え、取消を取消日付の逆仕訳で表す方式。
- 注意: GPL-3.0。Frappe 前提で巨大。

### 3.5 Odoo（会計部分の設計思想 + 日本ローカライズ）（https://github.com/odoo/odoo ／ 約 55.4k★ ／ Python ／ LGPL-3.0（Community）／ 2026-10-28 活発）

- データモデル（`addons/account/models` のソースから）:
  - 仕訳: `account.move`。`move_type` = entry / out_invoice / in_invoice / out_refund / in_refund / out_receipt / in_receipt で**請求書も仕訳の一種として同一テーブル**。`state` = draft / posted / cancel。取消は `reversed_entry_id` / `reversal_move_ids`（逆仕訳）。`auto_post`（予約記帳）。ジャーナルの `restrict_mode_hash_table` により確定仕訳に `inalterable_hash` と `secure_sequence_number`（欠番なし連番）を付与し改ざんを検知。
  - 明細: `account.move.line`。debit / credit / balance / amount_currency、tax_ids、tax_line_id、**tax_repartition_line_id**、**tax_tag_ids**、`display_type`（product / tax / payment_term / line_section / line_note）、reconciled / full_reconcile_id / matching_number。SQL 制約（credit と debit の同時非 0 禁止、勘定必須 など）。
  - 税: `account.tax`（type_tax_use sale/purchase、tax_scope、amount_type = percent / fixed / group / division、price_include、include_base_amount、is_base_affected、tax_group_id、**請求用・返金用の repartition lines**）。税額の配賦先科目とタグを repartition に持たせ、`account.report` が**タグを集計して申告書を作る**。`account.fiscal.position` で税の読替え。
  - 銀行: `account.bank.statement(.line)`、`account.reconcile.model`（突合ルール）、`account.partial.reconcile` / `account.full.reconcile`。
  - ロック: 会社設定に `fiscalyear_lock_date`（Lock Everything: 変更・新規とも不可、会計日を翌日へ自動繰下げ）、`tax_lock_date`（Tax Return Lock）、`sale_lock_date`、`purchase_lock_date`、**`hard_lock_date`（不可逆。法規制のデータ不変性向け）**の 5 種。例外は `account.lock_exception`（ユーザー指定または全員、理由、終了日時、失効/取消の状態）で、管理者が期限つきで作成しチャッターに記録。当期純損益は特別な科目種別（既定 999999 Undistributed Profits/Losses）で動的に表示し、年度末に日付つきのその他仕訳で資本科目へ振り替える。
- **`l10n_jp`（v2.3、作者 Quartile Limited、LGPL-3、`addons/l10n_jp`）**:
  - 勘定科目 208 件。日本語名つきで、**コードは e-Tax の勘定科目コード体系**（例 `10A100020` 現金及び預金、`10A100090` 売掛金。国税庁の説明では 業種番号 2 桁 + 区分番号 3 桁 + 4 桁整数の 9 桁。`10` = 一般商工業）。BS/PL 区分などのアカウントタグ（特別損益・法人税等・繰延資産・投資その他の資産 など）。償却モデル（定額 n 年）。
  - 税グループ: JCT 8% / JCT 10% / 0% / 非課税 / 源泉。税 55 件: 売上 10・8・0・輸出免税・非課税、**簡易課税 第 1〜6 種 × 10/8**、仕入 10・8（課税売上対応／課税・非課税共通対応の別）、**非適格請求書発行者（NQI）の仕入控除 80・70・50・30%**、国外 EX/SP、源泉 -10.21%。
  - フィスカルポジション: 国内取引 / 非適格請求書発行者 / 海外取引（POS 用の内税・外税も説明に記載）。
  - 消費税申告のレポート定義: 「売上積上げ計算」「売上割戻し計算」の 2 本 × 申告書本体と付表 1-3 / 2-3 / 4-3 / 5-3 相当のセクション。税の repartition に `S1_3_2B`、`S2_3_1B` のようなタグを付けて集計。
  - `l10n_jp_ubl_pint`: Peppol PINT の日本版 UBL（e-invoice）。
  - OCA/l10n-japan（https://github.com/OCA/l10n-japan ／ ★約 14 ／ AGPL-3.0 ／ 19.0 ブランチ）: 締め日つき支払条件（account_payment_term_cutoff_day）、請求書合算と繰越（l10n_jp_summary_invoice, _carryover）、都道府県・住所・かな・敬称。適格請求書発行事業者番号の印字モジュール（l10n_jp_account_report_registration_number）は 16.0 向けの記載を確認（19.0 では一覧に無い）。
- 借りるべき設計: ① 勘定科目に e-Tax コードを持たせる（財務諸表 CSV に直結）② 税区分を「税率」でなく「税グループ + repartition + 申告書タグ」で持つ ③ 仕入側の「非適格請求書発行者」読替え（控除割合別の税）④ ロック日付の段階（通常/税/ハード）と期限つき例外 ⑤ 確定仕訳のハッシュ連鎖。
- 注意: Qiita（2026-08、二次情報）は「`l10n_jp` は未完成でコミュニティ保守、高度な会計は Enterprise」と評価。レポート UI は Enterprise 側の可能性（未確認）。LGPL-3.0 のため CSV データの転載は派生物扱いとなりうる。

### 3.6 GnuCash（https://github.com/Gnucash/gnucash ／ 約 4.4k★ ／ C/C++ ／ GPL v2 または v3 ／ 2026-10-20 活発）

- データモデル（SQL スキーマ）: `accounts`（guid, name, account_type, commodity_guid, parent_guid, code, hidden, placeholder）、`transactions`（guid, currency_guid, num, post_date, enter_date, description）、`splits`（tx_guid, account_guid, memo, action, reconcile_state/date, **value_num/value_denom と quantity_num/quantity_denom**, lot_guid）。金額は有理数（分子・分母）で丸めを避ける。ほかに commodities、prices、slots（KV）、lots、budgets、schedxactions、business 系（customers / vendors / invoices / entries / jobs）、taxtables。
- 期末: Close Book は期末日付で損益を資本へ振り替える**ただの取引を作るだけ**（削除すれば元に戻る。標準レポートが閉鎖取引を考慮しないため任意）。`Auto-readonly days` は「N 日より古い取引を編集不可」にする日数ベースの簡易ロック（2020 年のメーリングリストの記述による。現行仕様は未確認）。
- 日本: `data/accounts/ja` に 18 個の勘定科目テンプレート（acctchrt_business など）。米国テンプレの翻訳が中心と思われ（未確認）、e-Tax 科目体系ではない。Qiita（二次情報）は「消費税・請求書が日本の商慣習に合わず有志ツールで補う」と評価。
- 借りるべき設計: 1 取引 = N 個の split、value（取引通貨）と quantity（科目の単位）を別に持つ。有理数で丸め誤差を避ける（TS では bigint 円で足りる）。Close Book を「ただの取引」で表す。
- 注意: デスクトップアプリで TS への直接流用は不可。

### 3.7 Beancount ＋ Fava（https://github.com/beancount/beancount ／ 約 6.1k★ ／ Python ／ GPL-2.0 ／ 2026-08-23。Fava: https://github.com/beancount/fava ／ 約 2.6k★ ／ MIT ／ 2026-10-25）

- データモデル:
  - 日付つきディレクティブ列: `open` / `close` / `commodity` / `balance` / `pad` / `note` / `document` / `price` / `event` / `query` / `custom` / transaction（`txn`, `*`, `!`）。ファイル順に依存せず日付順にソートされ、非取引ディレクティブは当日の開始時点で効く（`balance` は同日の取引より前に検査）。
  - 勘定科目: 根は Assets / Liabilities / Equity / Income / Expenses の 5 種。使用前に `open` が必要（悲観的・厳格）。
  - 仕訳: 取引は 2 つ以上の posting の合計が 0（構文解析時に検査）。tags（`#`）、links（`^` = 請求書と入金など関連取引のグルーピング）、metadata（`key: value`）。`document` は科目に証憑ファイルを紐付け。`pad` は直後の `balance` を満たすための補正取引を自動挿入。
  - 税区分・請求書: 組み込み無し（LWN: 請求書の作成・管理機能は無い）。税区分は metadata / タグで自作する前提。
  - 銀行取込: importer フレームワークは beangulp（https://github.com/beancount/beangulp ／ 約 145★ ／ GPL-2.0）。日本の銀行向け importer は見つからなかった。
  - 期末: BQL の `FROM … OPEN ON <日付> CLOSE ON <日付> CLEAR`。`OPEN ON` は期首より前を要約して期首残高に畳み（損益は前期繰越利益へ）、`CLEAR` は期末で損益を Equity の当期利益へ寄せる。入力ファイルに期末仕訳を焼かず、レポート時に要約する方式。
  - 日本語の科目名: ledger2beancount の互換表は「UTF-8 の文字・数字は Beancount 2.1 以降」と記載。一方、作者 Blais の比較文書は「UTF-8 は引用符内のみで科目名には使えない（レキサー書換え予定）」、2023 年の日本語ブログは「v2 は ASCII のみのため Ledger を選んだ」と記す。**版・ビルドで揺れる。`資産:現金` が通るか事前検証が必要**（v3 の扱いは未確認）。
- 借りるべき設計: ① 残高アサーション（`balance`）と補正（`pad`）で銀行残高・預金残高を継続検証 ② `document` による科目↔証憑リンク ③ tags / links / metadata に T 番号・税区分・請求書番号を持たせる発想 ④ 期末を仕訳に焼かずレポート時に要約する方式（CLEAR）。
- 注意: 日本の法人事例は見つからず（4.9）。Qiita（二次情報）は「消費税や減価償却は自作」と整理。
- Fava: BS・損益・試算表・仕訳・クエリ・証憑を見る Web UI。MIT。

### 3.8 hledger（https://github.com/hledgerorg/hledger ／ 約 4.8k★ ／ Haskell ／ GPL-3.0 ／ 2026-10-28 活発。旧 simonmichael/hledger は移管済み）

- データモデル: Ledger 互換のジャーナル。`account` 宣言と type タグ（A/L/E/R/X）、残高アサーション（`=`、`==`、`=*` で小計含む。日付順に検査）、periodic transactions（`~`）、auto postings（`=`）、tags（取引・posting・科目へ伝播）、状態マーク（`!` 保留、`*` 確認済み）。UTF-8 の日本語科目名は使える（日本語ブログで中項目を日本語化）。出力は CSV / JSON / SQL / Beancount 形式など。
- 期末: `hledger close`（`--clopen`（旧 `--migrate`）で閉鎖取引と開始取引を同時に生成、`--retain` で損益を利益剰余金へ、`--assert` で残高アサーションのみ生成）。**年度ごとにファイルを分け、期末に closing / opening 取引で繰り越す運用**が前提。
- 日本での使われ方: 個人事業主のみ（4.9）。消費税・インボイスは未対応、減価償却は手計算、CSV 取込ルールは自作。
- 借りるべき設計: 年度ファイル分割 + closing/opening 取引による繰越の考え方、残高アサーションの自動生成。
- 注意: 日本語情報が少なく、ledger / hledger / beancount の間でファイルの互換性は無い（ブログの指摘）。

### 3.9 ledger-cli（https://github.com/ledger/ledger ／ 約 6.1k★ ／ C++ ／ BSD-3-Clause ／ 2026-10-22）

- 位置づけ: プレーンテキスト会計の元祖。Beancount 作者は「Ledger は楽観的、Beancount は悲観的（厳格）」と対比。Ledger はファイル全体で多様なエンコーディングを許容し、virtual postings（不均衡を許す）や periodic / automated transactions を持つ。
- 借りるべき設計: 逆説的に、「virtual postings（貸借不一致の仮想行）は採らない」という判断材料（Beancount は排除）。
- 注意: 日本語事例は同人経理（個人）のみ（4.9）。

### 3.10 Medici（https://github.com/flash-oss/medici ／ 約 360★ ／ TypeScript + MongoDB ／ MIT ／ 2026-07-29、v7.4.0）

- データモデル:
  - `Book`（名前で複数の帳簿を 1 DB に同居）。
  - `Medici_Journals`（ヘッダ: datetime, memo, `_transactions`, book, voided, void_reason）と `Medici_Transactions`（明細: credit, debit, meta（任意）, datetime, account_path[], accounts, book, memo, `_journal`, voided, void_reason, `_original_journal`）。ヘッダの book・datetime・voided 等は明細側にも複製して populate を避ける。
  - 勘定科目は `Assets:Cash` のような `:` 区切りの文字列。親で問い合わせると子を含む。`meta` のキーで balance / ledger を絞り込める。
  - 仕訳: `book.entry(memo).debit(account, amount, meta).credit(...).commit()`。貸借が合わなければ `INVALID JOURNAL`。
  - **void**: 元仕訳を削除せず `voided` を立て、**同額で逆の仕訳を追加**（既定は取消時点の日付、`use_original_date: true` で元日付。キャッシュ残高が最大 48 時間ずれうる）。
  - 同時実行: MongoDB のセッション内で `writelockAccounts` を最後に呼ぶ方式（2022 年以降の推奨）。残高は `medici_balances` に 24 時間ごとのスナップショット（既定 48 時間で失効）。
  - 精度: 既定 precision 8 の浮動小数。`precision: 0` で整数モード（円向きの設定）。`Number.MAX_SAFE_INTEGER` が上限。
  - 税区分・請求書・銀行取込: なし。
- 借りるべき設計: ① ヘッダ + 明細の多脚仕訳 ② void = 逆仕訳 + `_original_journal` で元と結ぶ ③ meta キーで絞れる残高照会 ④ 1 DB に複数 book。
- 注意: MongoDB 専用で Postgres 前提の自作とは相性が悪い。API の参考として読むのが良い。

### 3.11 TigerBeetle（https://github.com/tigerbeetle/tigerbeetle ／ 約 17.3k★ ／ Zig ／ Apache-2.0 ／ 2026-10-23）

- データモデル（公式ドキュメント）:
  - Account: id（128bit、クラスタ全体で一意）、`ledger`（32bit。通貨・資産種別などのパーティション。同じ ledger の口座間でのみ取引可）、`code`（16bit。口座カテゴリ）、`flags`、`user_data_128/64/32`（外部エンティティ・イベントとの紐付け。検索可能）、`debits_pending / debits_posted / credits_pending / credits_posted`。**残高は保存せず累積借方・累積貸方のみ**。残高の符号はアプリが口座種別で解釈。
  - フラグ: `debits_must_not_exceed_credits` / `credits_must_not_exceed_debits`（資産・費用側は後者、負債・資本・収益側は前者）、`linked`（複数作成を原子的に連結）、`history`、`imported`（過去の timestamp を指定して移行）、`closed`。
  - Transfer: 1 件で 1 口座を借方・1 口座を貸方に。金額は符号なし 128bit 整数。`code` は理由、`id` は冪等キー（時間ソート可能な ID を推奨）。pending → post / void の二段階取引。
  - **口座と取引は不変。誤りは新しい transfer で訂正する**（公式レシピ: 訂正専用の `code` を使い、同じ `user_data_128` を元と訂正に付けて関連付け、レポート層で訂正後の結果だけを見せる。訂正の訂正も可）。
  - 金額の小数: asset scale（10 のべき）で整数化。asset scale の変更は新しい ledger への移行を要する。
- 借りるべき設計: ① 残高を保存せず累積借方・貸方から導出 ② `ledger` / `code` / `user_data` による分類と関連付け ③ 不変 + 訂正専用 code ④ id による冪等 ⑤ 過去データ移行用の imported フラグ。
- 注意: 専用 DB であり、複合仕訳（多脚）は `linked` で束ねる表現。会計の勘定科目表・税・請求書は別レイヤーが必要。思想の参考として読む。

### 3.12 Formance Ledger（https://github.com/formancehq/ledger ／ 約 1.5k★ ／ Go ／ v2.x は MIT ／ 2026-10-27）

- 状態: **v2.x（安定、最新 v2.4.16 は 2026-10-21）は PostgreSQL 版で MIT。v3（v3.0.0-rc.1 は 2026-10-14）は単一 Raft グループ + Pebble で Postgres を使わない別アーキテクチャ。main の README は v3 を説明し、ルートに LICENSE ファイルが無い（ライセンス要確認）。**
- データモデル（v2）: アカウントは `users:1234` のようなコロン区切りアドレス（`world` は外部の源）。取引 = postings のリスト（source, destination, amount, asset）+ metadata。ストレージのマイグレーション名から、`moves` / `accounts_volumes`（入出金累計）/ `transactions` + metadata / `accounts` + metadata / **ハッシュ関数つきの `logs`**（`compute-hash-function`、`logs-async-hash-procedure`）/ 冪等キー（ik）/ post-commit volumes（pcv）/ transaction templates / schema 機能があることが分かる。Numscript という取引記述 DSL。
- 借りるべき設計: ① 取引を「postings（source→destination）」で表す ② 追記専用 logs + ハッシュで改ざん検知 ③ 冪等キー ④ 口座ごとの入出金累計（volumes）を別に持つ。
- 注意: 会計の勘定科目・税・請求書は持たない。v3 のライセンス不明。

### 3.13 pgledger（https://github.com/pgr0ss/pgledger ／ 約 500★ ／ PostgreSQL SQL ／ MIT ／ 2026-10-27 活発）

- データモデル（`pgledger.sql` を直接確認、約 11KB）:
  - `pgledger_accounts`: id（プレフィックスつき ULID `pgla_`）、name、currency、`balance NUMERIC`、`version BIGINT`、`allow_negative_balance`、`allow_positive_balance`、metadata。
  - `pgledger_transfers`: from_account_id、to_account_id、`amount NUMERIC`（CHECK で正の有限値・同一口座禁止）、created_at、**`event_at`（実世界の発生時刻。既定 now()、指定可）**、metadata。
  - `pgledger_entries`: account_id、transfer_id、符号付き amount、account_previous_balance、account_current_balance、**account_version**。
  - 関数 `pgledger_create_account / _transfer / _transfers`（複数 transfer を 1 トランザクションで順に適用。**関係口座の ID をソートしてロックしデッドロック回避**）。ビュー `*_view`。履歴残高は created_at でなく account_version 順で取る。
  - 多通貨: 1 口座 1 通貨。為替は 2 ユーザー口座 + 2 流動性口座の 4 entry を 2 transfer で表す。
  - 性能: 作者の測定（M3 MacBook Air、PG17、未調整）で 7.5k〜10.6k transfers/s。
- 借りるべき設計: ① 口座の `balance` + `version` と entry の前後残高を同時更新し、過去時点残高を version で再現 ② 実世界の発生時刻 `event_at` と記録時刻 `created_at` の分離 ③ 負残高禁止などの制約を関数内で検査 ④ SQL だけで完結し、アプリのトランザクションに同居できる。
- 注意: transfer は 2 口座間（2 脚）で、複合仕訳（売上 + 仮受消費税 ↔ 売掛金 のような 3 脚以上）は複数 transfer の束で表すか、journal ヘッダ + 明細モデルを自前で足す必要がある。税・請求書・銀行取込なし。TS 向けは node-pgledger（型・ユーティリティ、★1）。

### 3.14 TypeScript 製の小さな台帳・会計ライブラリ（Lefra / ledgerkit / clovis / accounting-up ほか）

- **Lefra**（https://github.com/radzserg/lefra ／ 約 10★ ／ TypeScript + PostgreSQL（slonik）／ MIT ／ 2026-07-24、npm 1.0.4）
  - データモデル: `ledger_currency` / `ledger` / `ledger_account_type`（`normal_balance` = DEBIT or CREDIT、親子あり）/ `ledger_ledger_account_type` / `ledger_account`。システム型は固定口座、エンティティ型（ユーザーごとの買掛など）は自動生成。1 ledger 1 通貨、金額は `Unit` クラス。取引は `TransactionDoubleEntries` と `doubleEntry / debit / credit` で組み立て、`ledger.record(ILedgerOperation)` で記録。`npx lefra init` でスキーマ作成、`npx lefra generate` で DB から型付き ledger spec を生成。同作者のホスト版 API「Ledfra」あり。
  - 借りる設計: 勘定科目種別に normal_balance と親子を持つ、操作（ILedgerOperation）を型付きの転記ルールにする、DB スキーマから型を生成する。不変性・訂正は README に記述なし。
- **ledgerkit**（https://github.com/themusashimaru/ledgerkit ／ ★0 ／ TypeScript、依存ゼロ ／ MIT ／ 2026-07 作成）
  - 金額は `bigint` の最小単位（float は境界で拒否）、`allocate` は最大剰余法で按分して合計を保つ。entry は冪等キーと legs を持ち、不均衡は作れない。記帳済み entry は deep-freeze、訂正は逆仕訳。`balanceAt`、`trialBalance`。不変条件のファズテスト（seed 固定）。**会計期間は非目標**、1 ledger 1 通貨、永続化は利用側。
  - 借りる設計: bigint 円 + 最大剰余法の按分、冪等キー、不変条件のファズテスト。成熟度は不明（★0）。
- **clovis**（https://github.com/cloviscomputing/clovis ／ ★1 ／ TypeScript + SQLite ／ AGPL-3.0-or-later ／ npm 1.3.0）
  - ローカル SQLite の複式台帳を CLI・Node API・MCP から操作。「台帳は事実を覚え、**pending 行が不確かさを持ち、突合が信頼を決める**」という状態設計。借りる設計: pending → reconciled のワークフロー。AGPL。
- **accounting-up**（npm ／ MIT ／ 2026-10 作成 v0.1.6）: 会社ごとに 1 つの SQLite、ledger / tax / invoicing / bank / expenses / bills / payroll / inventory のモジュール分割。税モジュールに国別税率を焼き込む（カナダ）。借りる設計: 国別税を差し替え可能なモジュールに分離。初期版。
- **@companyio/accounting**（npm ／ license 未記載）: 業務パッケージはドキュメントを持ち、アダプタ経由で GL に転記する。「Accounting owns the financial truth」。反転・冪等あり。ライセンス不明のため参考のみ。
- **@mulmoclaude/accounting-plugin**（receptron/mulmoclaude ／ MIT）: ワークスペースファイル保存の複式簿記プラグイン（詳細未確認）。
- **@fin.cx/skr**（npm）: ドイツの SKR03/SKR04 を国別 CoA パッケージとして配布。日本版 CoA（e-Tax コード付き）を同様にパッケージ化する発想の参考。

### 3.15 他言語の台帳（Cala / Blnk / Midaz）

- **Cala**（https://github.com/GaloyMoney/cala ／ ★約 43 ／ Rust + PostgreSQL ／ Apache-2.0 ／ 2026-10-27）: event sourcing + outbox。取引テンプレートを CEL 式でパラメータ化（宣言的な転記ルール）。借りる設計: 取引種別ごとの「仕訳テンプレート」。
- **Blnk**（https://github.com/blnkfinance/blnk ／ ★約 570 ／ Go ／ Apache-2.0 ／ 2026-10-24）: ledgers / balances / transactions（inflight、scheduled、overdraft、bulk）/ identities / 外部明細との突合ルール / balance snapshots。借りる設計: 外部明細と内部記録の突合ルール。
- **Midaz**（https://github.com/lerianstudio/midaz ／ Go）: **現行は Elastic License 2.0**（旧版は Apache-2.0）。ホステッドサービスとしての提供不可のため非推奨。

### 3.16 Invoice Ninja（https://github.com/invoiceninja/invoiceninja ／ 約 10.3k★ ／ PHP Laravel ／ Elastic License 2.0 ／ 2026-10-27 活発）

- データモデル: 請求書（Invoice）は `line_items`（JSON）、**`tax_name1..3` / `tax_rate1..3`（3 スロット）**、`uses_inclusive_taxes`（内税/外税）、`is_amount_discount`、`e_invoice`（オブジェクト）、`balance` / `paid_to_date`、ステータス（draft=1 / sent=2 / partial=3 / paid=4 / cancelled=5 / …）。見積・クレジット・入金・経費・ベンダー・プロジェクト・工数を持つ。**GL（複式の総勘定元帳）は無い**。`CompanyLedger` は活動（請求・入金など）ごとに adjustment と balance を記録する残高推移用の台帳（GL ではない。顧客単位かどうかは未確認）。
- 借りるべき設計: 請求書のステータス遷移、請求・入金ごとに残高推移を残す台帳（売掛の時系列）。
- 注意: Elastic License 2.0（ホステッド/マネージドサービスとして第三者に提供不可、ライセンスキー機能の回避禁止）。日本固有の記述なし。

### 3.17 Crater／InvoiceShelf（請求書系）

- **Crater**（https://github.com/crater-invoice-inc/crater ／ 約 8.4k★ ／ PHP Laravel + Vue ／ AGPL-3.0）: 請求書・見積・経費・入金。**最終 push が 2024-08-10 で停滞**（README に終了の記載は見当たらない）。
- **InvoiceShelf**（https://github.com/InvoiceShelf/InvoiceShelf ／ 約 1.9k★ ／ PHP + Vue/TS ／ AGPL-3.0 ／ 2026-10-27 活発）: 請求書・見積・入金・経費・税・レポート、定期請求、顧客ポータル、複数会社（スコープつきロール）、EN 16931 の電子請求（ZUGFeRD/Factur-X）を公式モジュールで提供。2.x が stable、3.x は alpha（本番データ不可）。Crater との関係は README では確認できなかった（一般に Crater の fork と言われるが未確認）。
- 借りるべき設計: 電子請求を「公式モジュール」として本体から分離する構成、定期請求。

### 3.18 参考: LedgerSMB

- https://github.com/ledgersmb/LedgerSMB ／ 約 570★ ／ Perl 5.38+ + PostgreSQL 14+ ／ GPL-2.0 ／ 2026-10-26。Web ベースの複式簿記 + ERP（見積・受注・請求・在庫・出荷、テンプレート出力）。1.14 が開発版、1.13 が stable。Postgres で会計を持つ古典的な実装として読み物になるが、詳細は今回未精査。

---

## 4. 日本固有 OSS

### 4.0 問いごとの結論

| 問い | 結果 |
|---|---|
| 消費税／インボイス制度に対応した会計 OSS（法人） | **見つからず**（標準機能で満たす成熟 OSS なし）。部品は小規模なものが点在（4.3）。最も体系的なのは Odoo `l10n_jp`（3.5） |
| 電子帳簿保存法に対応した OSS | **部分的にあるが JIIMA 認証 OSS は見つからず**（4.4）。設計の参考になるのは domble（ハッシュ連鎖）、nene-vault（監査ログ + SHA-256）、aoiko（訂正仕訳 + 履歴） |
| freee API クライアント | 公式 SDK（C#/Java/PHP/JS）は **archived**。現行は **freee-mcp（TS、Apache-2.0）** と **freee-api-schema（OpenAPI、MIT）**。TS の非公式クライアントは freee-api-axios（license なし）。OpenAPI から型生成が現実的（4.1） |
| e-Tax 財務諸表 CSV／XBRL を生成する OSS（法人） | **見つからず**。近いのは eTaxtools（R、国税庁 Excel 標準フォーム→CSV、2020）。個人向けの XTX（所得税・消費税）生成は aoiko / domble / opentax（4.5） |
| 法人税申告書（別表）の XML 生成 OSS | **見つからず**（4.5） |
| 公表システム Web-API クライアント | kendama（Ruby ★7・Python ★0。OpenAPI 定義同梱）、invoice-lookup（Rust）、mcp-houjin-bangou（TS の MCP）、japan-data-mcp（Python の MCP）。**TS の純クライアントライブラリは見つからず**（4.2） |
| 日本の銀行 CSV パーサ | aoiko の `src/parsers`（MUFG・SMBC・SBI新生・PayPay・楽天カード・JCB・セゾン・ビュー・ライフ・au PAY）が最も充実。汎用の成熟ライブラリは**見つからず**。Beancount 向け日本 importer も見つからず（4.7） |
| beancount／hledger で日本の法人経理をしている個人開発者 | **見つからず**（個人事業主の事例のみ。4.9） |

### 4.1 freee 関連（API・スキーマ・SDK）

| プロジェクト（URL） | ★ | 言語 | ライセンス | 最終 push・状態 | 要点・借りる点 |
|---|---|---|---|---|---|
| freee/freee-api-schema https://github.com/freee/freee-api-schema | 約 27 | OpenAPI（JSON） | MIT | 2026-10-27 | 会計 API v1.0（`v2020_06_15/open-api-3/api-schema.json`）は 107 パス・180 スキーマ。リソース: account_items / deals / manual_journals / journals / wallet_txns / walletables / transfers / taxes / partners / items / sections / segments / tags / fixed_assets / reports(18) / receipts / invoices / quotations / approval_requests など。**取引 deal の明細**は account_item_id・tax_code・entry_side(debit/credit)・amount(税込)・vat・partner/item/section/tag/segment、**payments** は from_walletable_type（bank_account/credit_card/wallet/private_account_item）、**manual_journal** は `adjustment`（決算整理）と txn_number を持つ。freee 風 UI の裏のモデルとしてそのまま読める |
| freee/freee-mcp https://github.com/freee/freee-mcp（旧 him0/freee-mcp） | 約 513 | TypeScript | Apache-2.0 | 2026-10-27・活発 | 公式の MCP + Agent Skills。OAuth 2.0 + PKCE、複数事業所切替、OpenAPI でパス検証、会計・人事・請求書・工数・販売ほか 587 オペレーション。TS で freee API を叩く実装例 |
| freee/freee-accounting-sdk-{csharp,java,php,javascript} https://github.com/freee/freee-accounting-sdk-java ほか | 約 5〜24 | C# / Java / PHP / JS | MIT | **archived**（2023〜2024） | 公式 SDK は終了。PHP は Packagist でも abandoned 表示 |
| LayerXcom/freee-go https://github.com/LayerXcom/freee-go | 約 43 | Go | BSD-3-Clause | 2025-07-18 | 非公式クライアント |
| siketyan/freee-rs https://github.com/siketyan/freee-rs | 約 8 | Rust | MIT | 2026-10-26 | OpenAPI から自動生成 |
| studio4096/freee-api-axios https://github.com/studio4096/freee-api-axios | 0 | TypeScript | 未設定 | 2025-12 | 非公式 TS クライアント。license が無く利用に注意 |
| knishioka/freee-mcp https://github.com/knishioka/freee-mcp | 約 3 | TypeScript | MIT | 2026-10-12 | 同種の別実装（2025-05 作成。公式 freee-mcp の前身 him0/freee-mcp は 2025-01 作成）。公式があるため通常は不要 |

- 内部の仕訳設計を語った freee の技術ブログは今回見つからず。公開されている手掛かりは、Speaker Deck の個人発表（「取引・口座・明細という独自概念で記帳処理を前提に組み直した」）と freee ヘルプ（「取引は自動で複式簿記形式に変換して保存され、振替伝票で直接仕訳も入力できる」）（検索結果要約ベース）。

### 4.2 適格請求書発行事業者公表システム Web-API／法人番号 Web-API のクライアント

公式仕様（https://www.invoice-kohyo.nta.go.jp/web-api/index.html）: 機能は 3 つ（登録番号で取得／期間指定の差分取得／登録番号 + 日付で取得）。**アプリケーション ID が必須（無料）**。インボイス用 ID（インボイス・法人番号の両 API）と法人番号用 ID（法人番号 API のみ）の 2 種。インボイス用は仮登録後に「公表情報の取得・利用方法を記した書類」を提出して審査（法人番号用は発行まで約 1 か月と記載）。検証環境あり（インボイス用 ID が必要）。利用者のサービスには「本 Web-API 由来で国税庁は保証しない」旨の表示が必要。2026-09-21 に利用規約が一部改正（検索結果）。

| プロジェクト（URL） | ★ | 言語 | ライセンス | 最終 push | 要点 |
|---|---|---|---|---|---|
| nisyuu/kendama https://github.com/nisyuu/kendama（旧 uichi/kendama） | 約 7 | Ruby | MIT | 2026-07-12 | OpenAPI Generator 製。`GET /1/num`（登録番号）、`/1/diff`（差分）、`/1/valid`（登録番号 + 日付）。**`openapi/` に定義ファイルを同梱**しているため、`openapi-typescript` 等で TS クライアントを生成する足がかりになる |
| nisyuu/kendama-python https://github.com/nisyuu/kendama-python | 0 | Python | MIT | 2026-07-06 | 同上の Python 版 |
| SUGUKURU-CO-LTD/mcp-houjin-bangou https://github.com/SUGUKURU-CO-LTD/mcp-houjin-bangou | 約 1 | TypeScript | MIT | 2026-10-26 | 法人番号 Web-API の MCP。`lookup_corporate_by_number`、`search_corporate_by_name`、`lookup_invoice_issuer`、`validate_corporate_number`（ローカルでチェックデジット検証）、`normalize_company_name`。ローカルモードは `NTA_APPLICATION_ID` か PostgreSQL。インボイス照会が生 API かダウンロードデータかは README から判別できず |
| yoshitokameyama/japan-data-mcp https://github.com/yoshitokameyama/japan-data-mcp | 0 | Python | MIT | 2026-08-23 | e-Stat・法人番号・不動産・インボイスの MCP。インボイスは法人番号と同じ `CORP_APP_ID` を共用（`check_invoice_registration`、`validate_invoice_on_date`、`search_invoice_by_name`） |
| tk-aria/invoice-lookup https://github.com/tk-aria/invoice-lookup | 0 | Rust | 未設定 | 2026-03-15 | 公表サイト照会の Rust crate |
| chanshige/houjin-bangou https://github.com/chanshige/houjin-bangou | 約 1 | PHP | MIT | 2022-03-15 | 法人番号 Web-API Ver.4 のラッパー（インボイスは対象外・長期更新なし） |
| MasakiNiwa/Invoice https://github.com/MasakiNiwa/Invoice | 0 | TypeScript（React/Vite） | MIT | 2026-10-10 | 請求書画像・PDF から T 番号を OCR し、チェックデジット検証と公表サイトへのリンクを出す PWA。**Web-API は呼ばない**（README から判別できず） |

### 4.3 消費税・インボイスの計算／検証ライブラリ

| プロジェクト（URL） | ★ | 言語 | ライセンス | 最終 push | 要点・借りる点 |
|---|---|---|---|---|---|
| ashkobo/japan-invoice-mcp https://github.com/ashkobo/japan-invoice-mcp | 0 | JavaScript（npm、MCP + ライブラリ） | MIT | 2026-10-15 | オフライン純計算。T 番号／法人番号のチェックデジット検証と正規化（全角・ハイフン）、**税率ごとに 1 回だけ端数処理**（切捨て・四捨五入・切上げ）、税込／税抜、整数円演算、明細ごと丸めた場合との差を警告、源泉徴収（報酬・料金）、適格請求書／適格簡易請求書の必須項目検査。API: `parseNumber` / `invoiceTax` / `withholdingTax` / `grossUp` / `checkInvoice` |
| foovar-toku/jp-invoice https://github.com/foovar-toku/jp-invoice | 0 | PHP 8.2+（BCMath） | MIT | 2026-08-19 | 税率ごとの端数処理、浮動小数を使わず整数または数値文字列。例: 105 円 × 3 行（10%）は行ごとに丸めると 30 円、合計で 1 回丸めると 31 円 |
| Lonshaus/aoiko の `src/domain/consumption-tax.ts` / `src/domain/invoice.ts` / `tax-schema/2026/invoice-transitional.ts` | 0 | TypeScript | AGPL-3.0 | 2026-10-27 | 原則・簡易・2 割特例／3 割特例の試算、経過措置 80/70/50/30%。期間限定の特例を**データとして持つ**設計の参考 |
| se1987/tsumiki-kaikei https://github.com/se1987/tsumiki-kaikei | 0 | PL/pgSQL | MIT | 2026-07-27 | `tax_categories`（申告書の集計区分）と `tax_relief_rules`（税率・期間・特例）を分離。一般・簡易・2 割（3 割）方式。未対応: 95% 以上の全額控除ケース以外、国税／地方税の分離と端数、e-Tax 出力 |

- 二次情報（Qiita 2026-08）: 海外 ERP は消費税を明細ごとに丸めるものが多く、適格請求書の「税率ごと 1 回」ルールと合わない。月次合算請求も標準では無いことが多い。

### 4.4 電子帳簿保存法

- 国税庁 Q&A（業務システム・ERP を使うケース、https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/pattern/04.htm）: **訂正削除の履歴は全取引について確保が必要**で、集計済みの会計 DB だけを保存しても要件を満たさない（販売系・購買系・マスタ DB の履歴も対象）。見読可能性は「整然とした形式及び明瞭な状態で速やかに出力」。（相互関連性・検索機能・システム関係書類の節は取得した本文に含まれず未確認。）
- JIIMA の「電子帳簿ソフト法的要件認証」制度がある（検索結果要約）。**認証を受けた OSS は見つからなかった**（Qiita 2026-08 も同結論）。

| プロジェクト（URL） | ★ | 言語 | ライセンス | 最終 push | 要点 |
|---|---|---|---|---|---|
| kim-parkchik/domble https://github.com/kim-parkchik/domble | 0 | TypeScript + Rust（Tauri 2、Bun、SQLite/SQLCipher） | AGPL-3.0 | 2026-10-28（10-24 作成） | `entry_history` / `master_history` を持ち、**SQLite トリガーで UPDATE/DELETE を禁止**、strict モードでは**ハッシュ連鎖 `audit_chain`** で改ざん検知。会計ロジックは `src/lib/accounting.ts` ほかの純粋関数。国税庁の記載例に突合してテスト、XML は公式 XSD で検証。作者自身の監査で提出を妨げる未対応が多数（v0.2、macOS のみ想定） |
| hideyukiMORI/nene-vault https://github.com/hideyukiMORI/nene-vault | 0 | PHP 8.4（NENE2）+ React/Vite、SQLite（MySQL 可） | MIT | 2026-10-26 | 受領書類のアーカイブ。検索（日付・金額・取引先・書類種別）、**追記専用の監査ログ（変更前後の JSON 差分、削除不可）**、ファイルごとの SHA-256、保存期間 7〜10 年、無効化（void）と復元。税理士の確認（2026-05-31）を「承認済み」と記載、JIIMA 認証は主張していない |
| shuji-bonji/e-shiwake https://github.com/shuji-bonji/e-shiwake | 約 11 | TypeScript（SvelteKit 2 / Svelte 5、IndexedDB（Dexie）、PWA） | MIT | 2026-09-05 | 検索 3 項目（日付・金額・取引先）を全年度横断・AND 検索、添付 PDF を `{日付}_{種別}_{摘要}_{金額}円_{取引先}.pdf` へ自動命名、証憑と仕訳のステータス管理。訂正削除履歴の記述は無し |
| Lonshaus/aoiko https://github.com/Lonshaus/aoiko | 0 | TypeScript（Svelte + Vite + Tauri、PWA） | AGPL-3.0 | 2026-10-27 | 訂正仕訳（`domain/reverse.ts`）と元仕訳を残す監査履歴、年度ロック（`year-lock.ts`）、申告済み年度ガード（`filed-year-guard.ts`） |
| roundshape/denchokun_electron https://github.com/roundshape/denchokun_electron | 0 | TypeScript（Electron + React） | MIT | 2025-12-29 | 電帳法向けの台帳管理。初期段階（コンプライアンス記述なし） |

### 4.5 e-Tax（財務諸表 CSV／XBRL、申告書 XTX）

**法人の財務諸表（国税庁の公開仕様）**: 法人税申告に添付する財務諸表は XBRL または **CSV**（現行 **HOT010 Ver.3.0**。https://www.e-tax.nta.go.jp/hojin/gimuka/csv_jyoho4.htm）。会計ソフトの出力に e-Tax の勘定科目コードを付ける方法、または業種別の Excel「標準フォーム」を使う方法。ルール: **Shift-JIS**、JIS 第 1・第 2 水準のみ、金額はカンマなし・負数は半角マイナス、ファイル名は 書式 ID + バージョン + 表略称（BS / PL / SC / NT / SS / SE / SR）、1 ファイル 1 表、同時提出は法人名・事業年度が一致。作成後に「CSV ファイルチェックコーナー」で検査し、e-Tax ソフトに取り込む（CSV は XBRL へ変換して送信される）。勘定科目コードは約 6,400 科目の表があり、**9 桁（業種番号 2 桁 + 区分番号 3 桁 + 4 桁整数。例 `10A100020` = 現金及び預金）**。表にない独自科目は親コードに枝番を付ける（例 `10A100020-1`）（検索結果要約ベース）。CSV は 5 列構成（Qiita・検索結果要約。要仕様書確認）。

| プロジェクト（URL） | ★ | 言語 | ライセンス | 最終 push | 要点・借りる点 |
|---|---|---|---|---|---|
| nt1969m/eTaxtools https://github.com/nt1969m/eTaxtools | 0 | R | （未設定） | 2020-11-03 | 国税庁の Excel 標準フォームから e-Tax 用 CSV を作る R パッケージ。出力は CP932・CRLF（Qiita 記事: https://qiita.com/nt1969m/items/7edac99942a8c11fe32c）。**法人の財務諸表 CSV に最も近い OSS** だが古い |
| Lonshaus/aoiko https://github.com/Lonshaus/aoiko | 0 | TypeScript | AGPL-3.0 | 2026-10-27 | **個人事業主向け**。`.xtx` に確定申告書 KOA020 + 青色申告決算書 KOA210（白色は収支内訳書 KOA110）+ 不動産 KOA220/KOA130、消費税申告（一般・簡易・2 割）は別ファイル。**国税庁の XSD を `docs/xtx-spec/{general,shohi,shotoku,somu}` に同梱**し、`src/tax-schema/2026/` に form ごとのマッピング（`xtx-mapping-koa210.ts` など）と生成済みスキーマ JSON、税務署マスタを持つ。法人（`hojin`）の XSD は無い |
| kim-parkchik/domble https://github.com/kim-parkchik/domble | 0 | TypeScript + Rust | AGPL-3.0 | 2026-10-28 | `spec/etax/` の公式 XSD で XML を検証。個人向け |
| Arrenem/opentax https://github.com/Arrenem/opentax | 約 1 | TypeScript | AGPL-3.0 | 2026-10-21（10-14 作成） | 個人事業主向け。AI エージェントが MCP 経由で仕訳を**「確認待ち」で登録**し、人が Web UI で承認する流れ。Firestore + Cloud Storage。XTX 出力、証憑保管、監査履歴。Developer Preview |
| louie47690/zeicheck https://github.com/louie47690/zeicheck | 0 | TypeScript（CLI） | MIT | 2026-10-12 | e-Tax の xtx をルールで検証（個人事業主・給与所得者・マイクロ法人向けと記載）。**README のダウンロード／インストールリンクが全て tests 配下の同一 zip を指しており、インストールは非推奨**（要・自分でビルド確認） |
| kazukinagata/shinkoku https://github.com/kazukinagata/shinkoku | 約 366 | Python（Agent Skills） | MIT | 2026-09-09 | 個人事業主の確定申告を Claude Code 等のスキルで自動化（帳簿・消費税計算・e-Tax 入力をブラウザ自動化）。法人は対象外 |

- **法人税申告書（別表）の XML 生成 OSS は見つからなかった。** 国税庁は e-Tax 仕様書（XML 構造設計書・XSD）を公開しており、別表は XML 形式で送信する（検索結果要約）。年度ごとに様式が変わる。
- **法人の財務諸表は CSV で出せば足りる（e-Tax ソフトが XBRL に変換）ため、XBRL を自作する必然性は低い**（国税庁ページと Qiita の説明より。要検証）。XBRL 周りの OSS は EDINET 向けの読み取り系（teatime77/xbrl-reader など）や、ドイツ E-Bilanz 向け（quambene/taxel、Persblack/xbrl-cli）、英国 iXBRL（cybermaggedon/ixbrl-reporter）で、日本の e-Tax 向けではない。

### 4.6 勘定科目マスタ・仕訳ルール

| プロジェクト（URL） | ★ | 言語 | ライセンス | 最終 push | 要点・借りる点 |
|---|---|---|---|---|---|
| tsubasagit/kanjokamoku https://github.com/tsubasagit/kanjokamoku | 0 | TypeScript（npm） | MIT | 2026-03-31 | 勘定科目 113 件 + 取引先ルール 513 件（21 カテゴリ）。`classify(vendorName, amount?, persons?, customRules?)` が科目・税区分（課税仕入 10% など）・インボイス要否・源泉を返す。会議費と接待交際費を 1 人 1 万円で判定。e-Tax コードは無い。出典の記載なし |
| zeimu-ai/open-journal-rules https://github.com/zeimu-ai/open-journal-rules | 約 1 | TypeScript（npm `@zeimu-ai/open-journal-rules`） | Apache-2.0（README。GitHub は未検出表示） | 2026-06-13 | JSON + JSON Schema のデータセット: 摘要→勘定科目ルール 67、勘定科目 75、税区分 17、金額閾値 7、引用 49、簡易課税の事業区分 6、耐用年数 10、社保 27、源泉 4、等級 82、申告期限 5、業種テンプレート 13。ルールに `applicableEntity`（個人／法人／両方）と `applicableYear`。出典 URL が無いルールは受け付けない方針。`match()` / `resolveJournalEntry()` / `invoice-number` の検証 |
| Odoo `l10n_jp`（3.5） | — | CSV / XML | LGPL-3.0 | 2026-10-28 | 208 科目（e-Tax コード）、税 55 件、タグ、償却モデル。最も体系的 |
| se1987/tsumiki-kaikei（4.3） | 0 | PL/pgSQL | MIT | 2026-07-27 | `account_statement_map` / `statement_lines`（勘定科目→青色決算書の行へのマップ）、`aozora_income_statement` / `aozora_balance_sheet` |

### 4.7 日本の銀行・カード CSV、全銀

| プロジェクト（URL） | ★ | 言語 | ライセンス | 最終 push | 要点 |
|---|---|---|---|---|---|
| Lonshaus/aoiko の `src/parsers/` https://github.com/Lonshaus/aoiko | 0 | TypeScript | AGPL-3.0 | 2026-10-27 | **MUFG、MUFG カード、SMBC、SMBC カード、SBI 新生、PayPay（銀行／カード）、楽天カード、JCB、セゾン、ビュー、ライフ、au PAY カード**の CSV パーサーとサンプル CSV（fixtures）、追加用の `_template.example.ts`。重複検知はファイルハッシュ。ルール→AI の二段で勘定科目に割当 |
| zengin-code/source-data https://github.com/zengin-code/source-data（実装: zengin-js 約 84★、zengin-rb 約 100★） | 約 204 | Ruby（データは JSON/YAML） | 実装は MIT（source-data 自体の license 表示は未設定） | 2026-08-24 | 銀行コード・支店コードのデータセット（2014 年から継続更新）。口座マスタの銀行名・支店名補完に使える |
| Kyash/zengin-go https://github.com/Kyash/zengin-go | 約 4 | Go | MIT | 2026-07-02 | 全銀フォーマット（総合振込など）の読み書き |
| 個人のスクリプト群 | — | — | — | — | csv_sbi2yayoi_sol（住信 SBI→やよい青色）、yayoi_convert、Siwake、receipt-ledger（MF クラウド会計の仕訳インポート CSV）など、会計ソフト間の CSV 変換スクリプトが散在（いずれも ★0〜1） |

- Beancount の importer（beangulp / beancount-reds-importers 等）は ING-DiBa・DKB・Volksbank など欧州の銀行向けで、**日本の銀行向けは見つからなかった**（awesome-beancount の国別一覧にも日本なし）。

### 4.8 個人事業主向けの会計 OSS（設計の参考になるもの）

| プロジェクト（URL） | ★ | 言語・スタック | ライセンス | 最終 push・状態 | 要点・借りる点 |
|---|---|---|---|---|---|
| Lonshaus/aoiko https://github.com/Lonshaus/aoiko | 0 | TS（Svelte/Vite/Tauri、Vitest + Playwright）、フロントのみ・PWA | AGPL-3.0 | 2026-10-27（466 コミット、2026-08 作成） | 複式簿記、訂正仕訳、取込（銀行・カード CSV、レシート OCR、注文ページ貼付）、減価償却（定額・200% 定率・旧定率・リース・一括 3 年・少額特例）、消費税試算、請求書・見積（登録番号、税率別内訳）、BS/PL、XTX、バックアップ（File System Access API / OPFS）。`src/domain/`（journal・reverse・year-lock・consumption-tax・depreciation・carryover・inventory・cash-flow・amended・bad-debt-reversal・interim-filing など） |
| kim-parkchik/domble https://github.com/kim-parkchik/domble | 0 | Bun + Tauri 2 + React/TS、SQLite（SQLCipher 任意） | AGPL-3.0 | 2026-10-28（18 コミット） | 振替伝票で複合仕訳、明細に科目・補助科目・税コード・インボイス区分、変更履歴テーブル + トリガー + ハッシュ連鎖 |
| rubydogjp/openkk（オープン会計）https://github.com/rubydogjp/openkk | 約 1 | TS ライブラリ + React UI（packages: client-domain「フレームワーク非依存の純粋な型・計算」、client-ui）、SQLite OPFS | MIT | 2026-10-26 | ドメイン層を UI から分離。アーキテクチャ・DB スキーマ文書あり（architecture.md など。未精読） |
| onihei/kanean https://github.com/onihei/kanean | 0 | Electron + TS モノレポ（pnpm/turbo）、SQLite（control.sqlite + 帳簿ごとの books/{id}.sqlite） | AGPL-3.0 | 2026-08-31 | 青色申告・簡易課税・固定資産・家事按分。帳簿ごとに SQLite を分ける構成 |
| shuji-bonji/e-shiwake https://github.com/shuji-bonji/e-shiwake | 約 11 | SvelteKit 2 + TS、IndexedDB（Dexie）、PWA | MIT | 2026-09-05（149 コミット） | 仕訳に消費税区分（課税売上/仕入 10%・8%、非課税、不課税、免税）、科目ごとの既定税区分と一括更新、消費税集計（免税・簡易の判定）、固定資産台帳、請求書、WebMCP（17 ツール）、家事按分 |
| Arrenem/opentax https://github.com/Arrenem/opentax | 約 1 | TS、Firebase | AGPL-3.0 | 2026-10-21 | AI 登録→人の承認、スコープつき失効可能トークン、XTX |
| se1987/tsumiki-kaikei https://github.com/se1987/tsumiki-kaikei | 0 | PostgreSQL（PL/pgSQL） | MIT | 2026-07-27 | テーブル: accounts / transactions / entries / fixed_assets / asset_depreciation_postings / inventory / purchase_lots / tax_categories / tax_relief_rules / consumption_tax_worksheet / account_statement_map など。**commit 時の貸借一致検証（deferred constraint trigger）**、確定後の編集禁止、posted→voided と逆仕訳、追記専用の監査ログ、金額は整数円。学習・検証用と明記 |
| knishioka/simple-bookkeeping https://github.com/knishioka/simple-bookkeeping | 約 2 | Next.js 14 + Prisma + Supabase(PostgreSQL, RLS)、pnpm モノレポ | MIT（README） | **archived 2026-05-25** | データモデル文書: AccountingPeriod（年度・重複禁止・仕訳日付は期間内）、Account（種別・親子）、JournalEntry（status draft/approved/locked）+ JournalEntryLine（借貸・税率）、Partner、FixedAsset + Depreciation、TaxSetting（率・種別・有効期間）、BankAccount、AuditLog。論理削除。TS + Prisma + Postgres の素直な叩き台 |
| 34j/aoiro https://github.com/34j/aoiro | 約 1 | Python、CSV ベースの CLI（ベクトル化会計） | MIT | 2026-10-26（v1.0.2 は 2026-02-24） | 外貨の損益を自動計算（みずほ銀行の中値）、源泉徴収。決算書そのものは作らず作成コーナーへ誘導 |
| hanabishi-code/aoringo-choubo https://github.com/hanabishi-code/aoringo-choubo | 0 | JavaScript、Mac オフライン | MIT | 2026-10-06 | 個人事業主向け複式簿記アプリ（詳細未確認） |
| TakeshiOkamoto/mpp_fsjs ほか https://github.com/TakeshiOkamoto/mpp_fsjs | 約 7 | Rails / Laravel / Django / CakePHP 版 | MIT | 2020〜2022 | 青色申告決算書＆仕訳帳システム（古い） |
| sagami1991/aoiroshinkoku-sheet-gas https://github.com/sagami1991/aoiroshinkoku-sheet-gas | 約 22 | TypeScript → GAS（Google スプレッドシート） | 未設定 | 2023-01-14 | 仕訳帳から各種帳簿を作る |
| arowM/haskell-bookkeeping-jp https://github.com/arowM/haskell-bookkeeping-jp | 約 5 | Haskell（Hackage `bookkeeping-jp`） | MIT | 2020-01-20 | 日本の簿記向けヘルパ（CSV、個人事業）。更新停止 |

### 4.9 プレーンテキスト会計（beancount / hledger / ledger-cli）の日本での事例

**探索範囲**: 日本語・英語の WebSearch（standard 6 回 + extended 4 回）、Zenn / Qiita / note / はてなブログのドメイン限定検索、GitHub のリポジトリ検索（topic・description・README）。**「日本の法人の経理を beancount / hledger で行っている個人開発者のブログ・repo」は見つからなかった**。見つかったのは次の個人（事業主・同人・家計）の事例で、法人・消費税・インボイス・決算書（BS/PL/株主資本等変動計算書/注記表）の扱いを書いたものは無い。

| 事例（URL） | 種別 | 要点 |
|---|---|---|
| 「青色申告に hledger を使い始めた話」yayugu、2025-02-25 https://vector.hateblo.jp/entry/2025/02/25/221245 | ブログ（個人事業主） | 年ごとに 1 ファイル。大項目は英語（assets/expenses/revenue/liabilities を alias で a/e/r/l に短縮）、中項目は日本語（地代家賃・旅費交通費・事業主借 など）。**消費税／インボイスは未対応**、**減価償却は hledger で計算できず手計算**、CSV 取込ルールは自作。`hledger bal -M`、`hledger is --pivot payee` で決算書の数字を確認。「人に勧める方法ではない」と本人が述べる |
| 「Ledger で始める同人経理」nixeneko、2023-01-21 https://nixeneko.hatenablog.com/entry/2023/01/21/000000 | ブログ（個人） | Ledger CLI 3.2.1。**Beancount v2 は科目名が ASCII のみ、hledger は Windows 版でエラーのため Ledger を選択**。年ごとの journal。科目は 資産/負債/純資産/収益/支出 の日本語。在庫は commodity と `@` / `{}` で原価計算。消費税・決算書の記述なし |
| yosiopp/ledger-aoiro https://github.com/yosiopp/ledger-aoiro | repo（個人） | hledger による青色申告テンプレート。科目の最上位を A/L/E/R/X（hledger の type）で統一し、未定義科目を検査。Docker + Claude Code Skills。**消費税の記載なし**。★0、7 コミット、ISC（README） |
| Qiita 調査記事（sukimaengineer、2026-08-29）https://qiita.com/sukimaengineer/items/b0b6acf35b3ffae6770a | 二次情報 | 「Beancount / hledger / Ledger は有志が青色申告に使った事例はあるが、消費税・減価償却は自作」「個人・小規模は Git 管理の Beancount/hledger、在庫・請求のある法人は Odoo/ERPNext、税制追随を重視するなら freee / MF を主帳簿にして分析用に副帳簿」との整理 |
| Qiita「テキストで複式簿記するツール ledger のメモ」(syoyo)、「Beancount/Fava で自分の出費を可視化する（できなかった）」(kikeg) | 個人（家計） | 家計簿用途（検索結果のタイトルと要約のみ。内容は未精読） |
| beancount.io のブログ「Japan's Qualified Invoice System…」2026-07-27 https://beancount.io/blog/2026/07/27/japan-qualified-invoice-system-2026-deductibility-cut-guide | 商用ベンダーの解説 | インボイス制度の一般説明（免税事業者等からの仕入の控除 80%→50%）。実装例ではない。数値は国税庁で要確認 |

---

## 5. 設計記事

読めた範囲の要点。「（検索結果要約ベース）」は本文を直接読めていないもの。

### 5.1 複式簿記のデータモデル設計

| 記事（URL） | 要点 |
|---|---|
| Martin Fowler「Accounting Patterns」（Analysis Patterns の会計章の改訂版）https://martinfowler.com/apsupp/accounting.pdf | 目次: Account / Accounting Transaction（2 脚か多脚か）/ Accounting Entry / Event / Posting Rule / Secondary Posting Rule / 訂正 3 パターン（Replacement・Difference・Reversal Adjustment）。**PDF 本文はフォントの都合で抽出できず**、下記の個別パターンページ（HTML）を読んだ |
| Fowler「Accounting Transaction」https://martinfowler.com/eaaDev/AccountingTransaction.html | 取引 = 2 つ以上の entry で**合計 0**。2 脚を既定にし、多脚は組み立て（Proposed Object で積む→残高検査→account へ post→取引を不変化）が難しい。entry は必ず取引経由で作る |
| Fowler「Accounting Entry」https://martinfowler.com/eaaDev/AccountingEntry.html、「Event Sourcing」https://martinfowler.com/eaaDev/EventSourcing.html | ページの存在のみ確認（内容未精読）。entry を発生させた業務イベントへリンクする設計 |
| Square「Books, an immutable double-entry accounting database service」（2019-10-16）https://developer.squareup.com/blog/books-an-immutable-double-entry-accounting-database-service/ | book（名前つきの残高の器）、journal entry（金額が 0 に収束）、book entry（journal と book を結ぶ符号付き金額。**借方正・貸方負の独自規約**）。**journal / book entry は追記のみ、可変なのは books の現在残高だけ**。book ごとの単調増加 version。誤りは補償エントリで訂正。テナントは「shelf」で分離。Spanner（約 20TB を 3 人で運用） |
| Modern Treasury「Accounting for Developers」（eBook、2022-08-17）https://www.moderntreasury.com/accounting-for-developers | 勘定・借貸・正常残高・不変の取引。ledger / account / transaction / entry の 4 オブジェクト、リレーショナルスキーマ例（accounts, transactions, entries。取引ごとに借方 = 貸方を強制）、不変取引から残高を計算する。誤りの訂正方法は扱わない |
| Modern Treasury「How to Scale a Ledger」Part II / IV / V https://www.moderntreasury.com/journal/how-to-scale-a-ledger-part-iv ほか | （検索結果で存在を確認。本文は未精読） |
| pgrs.net「Double-Entry Ledgers: The Missing Primitive in Modern Software」（2025-06-17）https://pgrs.net/2025/06/17/double-entry-ledgers-missing-primitive-in-modern-software/ | accounts / transfers / entries / currencies。符号付き数値で統一、追記のみ、1 transfer の entry は原子的に書き合計 0（作らず移動するだけの組み込み検査）、返金は逆向きの新 transfer、ledger を業務ロジックから切り離したインタフェースの後ろに置く |
| pgrs.net「pgledger: ledger implementation in PostgreSQL」（2025-03-24）https://pgrs.net/2025/03/24/pgledger-ledger-implementation-in-postgresql/ | （検索結果のみ） |
| Stripe「Ledger: Stripe's system for tracking and validating money movement」（2024-02-16）https://stripe.com/blog/ledger-stripe-system-for-tracking-and-validating-money-movement | 不変のイベントログ、残高の移動（状態機械）としてモデル化、データ品質基盤。「99.9999% の説明可能性」は Stripe 自身の主張（検索結果要約ベース） |
| TigerBeetle docs（data modeling / account / correcting transfers）https://docs.tigerbeetle.com/coding/data-modeling/ ・ https://docs.tigerbeetle.com/reference/account/ ・ https://docs.tigerbeetle.com/coding/recipes/correcting-transfers/ | 3.11 参照 |
| Beancount「The Double-Entry Counting Method」https://beancount.github.io/docs/the_double_entry_counting_method/ | A + L + E + X + I = 0 の符号規約。Equity は Previous Earnings（前期繰越）・Current Earnings（当期）・Opening Balances。期末の clearing = 前期までの損益を期首日付の取引で Previous Earnings へ移す |
| 設計者の発言「基本のキ『簿記のデータモデル』を学ぼう」（2022-09-17）https://dbconcept.hatenablog.com/entry/2022/09/17/160851 | 勘定科目（1 社約 100）、仕訳見出し（1 仕訳の金額）、仕訳明細（科目・貸借区分・金額）、科目別月次サマリ（残高モデル）。試算表と総勘定元帳は派生ビュー。符号付き金額は使わず正常残高側で加減算。**修正は追加のみ（赤伝で打ち消して再計上＝赤黒訂正）**。科目マスタとサマリは更新されるので不変ではない。自然キー（複合キー）を重視 |
| Qiita「［DB/SQL］要件をテーブルに落とし込む手法のメモ書き（複式簿記のテーブル設計を例に）」https://qiita.com/tanakadaichi_1989/items/09e0ce35f3ebc9afc352 | PostgreSQL で journal / journal_details / accounts_title の 3 テーブルを概念→物理の順に説明。**コードに誤記あり**（`CHECH`、`account_type` と `accounts_type` の不一致、借方金額に貸方列を使うクエリ）。そのまま写さない（検索結果要約ベース） |
| はてなブログ「データベース～仕訳」（2024-12-14）https://giogiogiogio.hatenablog.com/entry/2024/12/14/213014 | 仕訳を勘定口座ごとのテーブルへ転記する考え方（検索結果要約ベース） |
| Mercari Engineering「Microservices と会計システム」（2019-09-19）https://engineering.mercari.com/blog/entry/2019-09-19-113909/ | 各マイクロサービスの業務イベントを受けて売掛・買掛を集計し ERP 入力用データを出す。**イベント→仕訳の対応を matter_id（借貸科目と許容する消費税区分を持つ）で管理**し、Spanner に保存する前にマスタで検証。1 イベント複数仕訳（ポイント併用など）。更新・削除せず、削除は専用 IF の依頼を別テーブルに記録。集計の再実行で過去が変わる問題にはスナップショットで再現。Reconcile API で不一致 3 種（項目差・サービス側のみ・会計側のみ）を検出。J-SOX の ITGC（バックアップ・再現性・変更承認）。追記型 DB（QLDB 等）が会計に合うと示唆 |

### 5.2 仕訳の不変性（immutable journal）と訂正仕訳

| 記事・実装（URL） | 要点 |
|---|---|
| Fowler「Reversal Adjustment」https://martinfowler.com/eaaDev/ReversalAdjustment.html | 原本を変えず、誤り 1 件につき**「元日付・逆符号の取消」+「正しい新 entry」**を追加。取消は元イベントに紐付けるので訂正の訂正で逆転を重ねない。欠点は件数が約 3 倍になり、取消の対を通常の一覧から除く必要 |
| Fowler「Difference Adjustment」https://martinfowler.com/eaaDev/DifferenceAdjustment.html | 差額 1 本で直す。件数は少なく 1 本で複数の誤りを直せるが、影の口座（Parallel Model）が要り実装が難しく、監査上の明示性が下がる。「Reversal → Difference への移行は容易、逆は困難」 |
| Fowler「Replacement Adjustment」https://martinfowler.com/eaaDev/ReplacementAdjustment.html | 誤った entry を削除して作り直す。最も単純だが履歴が消える。支払など後続の行為がある場合は不適。Event Sourcing なら再生成で履歴を補える |
| Fowler「Bitemporal History」https://martinfowler.com/articles/bitemporal-history.html | 実世界の時刻（actual）と記録時刻（record）の 2 軸。訂正は actual の歴史を変えるが**記録の歴史は追記のみ**。後日の訂正・修正申告を「当時何を知っていたか」込みで説明できる（会計への適用は筆者の記述ではなく類推） |
| Modern Treasury「Enforcing immutability in your double entry ledger」https://www.moderntreasury.com/journal/enforcing-immutability-in-your-double-entry-ledger | 取引は pending の間は可変、posted 後は不変。status = pending / posted / archived。訂正は「逆取引 + 正しい取引」または「差額 1 取引」。可変な業務オブジェクト（Order）と会計の真実（Ledger Transaction）を分離し、複数の取引を 1 つの Order に紐付ける。DB レベルの強制（トリガー等）は記述なし |
| TigerBeetle「Correcting Transfers」https://docs.tigerbeetle.com/coding/recipes/correcting-transfers/ | 取引は不変。訂正は逆向きの新 transfer。訂正専用の `code`、元と同じ `user_data_128` で関連付け、レポート層で訂正後だけを見せる |
| Medici / Frappe Books / ERPNext / Odoo | 3 章参照: void = 逆仕訳 + 元へのリンク（Medici）、`reverted` / `reverts`（Frappe Books）、`is_cancelled` + `enable_immutable_ledger`（ERPNext）、`reversed_entry_id` + ハッシュ連鎖（Odoo） |
| 国税庁 Q&A（電子帳簿の保存）https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/pattern/04.htm | 訂正削除の履歴は全取引について確保が必要。会計 DB だけでは足りない（4.4） |
| DB トリガーによる強制の実例 | se1987/tsumiki-kaikei（Postgres: 貸借一致の deferred constraint trigger、確定後の編集禁止）、domble（SQLite: 履歴テーブル + UPDATE/DELETE 禁止トリガー + ハッシュ連鎖） |

### 5.3 期末締め（period close）

| 記事・実装（URL） | 要点 |
|---|---|
| Odoo「Year-end closing」https://www.odoo.com/documentation/18.0/applications/finance/accounting/reporting/year_end.html | 締め前: 銀行照合、下書き請求書の解消、仮勘定の整理、償却・繰延収益の計上。締め: 税レポートの確認、BS 科目の照合（売掛・買掛年齢表）。ロック日付 Lock Everything（例外を期限つきで作成可）、**Hard Lock は不可逆**で当期利益が 0 になったことを確認してから設定。当期純損益は特別科目に動的表示し、年度末に日付つきのその他仕訳で資本科目へ振替 |
| ERPNext「Period Closing Voucher」https://docs.frappe.io/erpnext/user/manual/en/period-closing-voucher | 損益残高を資本科目へ振り替える提出式の仕訳。古い年度から順に。**履歴は消さず、過去日付の入力も止めない**ので Accounts Frozen Upto 等で凍結。追加仕訳があれば同じ年度で PCV を再提出して残りだけ振替 |
| Beancount BQL「OPEN ON / CLOSE ON / CLEAR」https://beancount.github.io/docs/beancount_query_language/ | 期首より前を要約して期首残高に畳み、期末で損益を当期利益へ寄せる。帳簿に期末仕訳を焼かずレポート時に要約 |
| hledger「close」https://hledger.org/hledger.html | `--clopen` / `--migrate`（旧）/ `--retain` / `--assert`。年度ごとにファイルを分けて繰り越す運用。ソース https://hackage-content.haskell.org/package/hledger-1.42.1/docs/src/Hledger.Cli.Commands.Close.html（検索結果） |
| GnuCash「Closing Books」https://code.gnucash.org/wiki/Closing_Books | Close Book は期末日付の 2 本の取引（収益・費用をゼロにして資本へ）を作るだけで、削除すれば元に戻る。標準レポートは閉鎖取引を考慮しないので任意（検索結果要約ベース） |
| Bigcapital TransactionsLocking（コード）https://github.com/bigcapitalhq/bigcapital/tree/develop/packages/server/src/modules/TransactionsLocking | 区分別（all / sales / purchases / financial）の lockToDate + 理由 + 部分解除 |
| Mercari（5.1） | 月次締め: 前月分の訂正は翌月 1 日まで、2 日に集計、以降は翌月計上 |
| 一般解説（弥生・マネーフォワード等、検索結果） | 法人の決算は 日々の記帳→試算表→決算整理仕訳→決算書→（株主総会・取締役会の承認）→法人税申告書。**法人税・消費税の申告期限は事業年度終了日の翌日から 2 か月以内**（3 月決算なら翌 5 月末）。非上場会社の書類は 貸借対照表・損益計算書・株主資本等変動計算書・個別注記表。freee は決算整理仕訳を `manual_journal.adjustment` で区別（4.1） |

---

## 6. 出典 URL 一覧

stars・license・最終 push は GitHub REST API（`https://api.github.com/repos/<owner>/<repo>`、`/search/repositories`）で 2026-10-28 に取得。ファイル構成・モデル定義は `git/trees` / `contents` API と raw.githubusercontent.com の閲覧による。（検索）= 検索結果のみで本文未精読。

### 6.1 汎用会計 OSS

- Akaunting: https://github.com/akaunting/akaunting ／ ライセンス全文 https://raw.githubusercontent.com/akaunting/akaunting/master/LICENSE.txt ／ Double-Entry アプリ https://akaunting.com/apps/double-entry ／ モデル https://github.com/akaunting/akaunting/tree/master/app/Models/Banking ・ …/Document ・ …/Setting
- Bigcapital: https://github.com/bigcapitalhq/bigcapital ／ モジュール https://github.com/bigcapitalhq/bigcapital/tree/develop/packages/server/src/modules ／ 例: https://raw.githubusercontent.com/bigcapitalhq/bigcapital/develop/packages/server/src/modules/Accounts/models/AccountTransaction.model.ts ・ …/Ledger/LedgerStorageRevert.service.ts ・ …/TransactionsLocking/types/TransactionsLocking.types.ts ・ …/TaxRates/models/TaxRate.model.ts ・ …/BankRules/models/BankRule.ts ・ …/BankingTransactions/models/UncategorizedBankTransaction.ts ・ …/TransactionItemEntry/models/ItemEntry.ts ・ …/ManualJournals/models/ManualJournal.ts ／ https://raw.githubusercontent.com/bigcapitalhq/bigcapital/develop/docker-compose.yml
- Frappe Books: https://github.com/frappe/books ／ EOL 告知 https://github.com/frappe/books/issues/1566 ／ 後継 https://github.com/frappe/frappe-books ／ https://raw.githubusercontent.com/frappe/books/master/models/Transactional/LedgerPosting.ts ・ https://raw.githubusercontent.com/frappe/books/master/models/baseModels/AccountingLedgerEntry/AccountingLedgerEntry.ts ・ https://github.com/frappe/books/tree/master/schemas
- ERPNext: https://github.com/frappe/erpnext ／ https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/accounts/doctype/gl_entry/gl_entry.json ・ …/period_closing_voucher/period_closing_voucher.json ・ …/fiscal_year/fiscal_year.json ・ …/account/account.json ・ …/accounts_settings/accounts_settings.json ／ CoA テンプレート https://github.com/frappe/erpnext/tree/develop/erpnext/accounts/doctype/account/chart_of_accounts/verified ／ PCV https://docs.frappe.io/erpnext/user/manual/en/period-closing-voucher ／ 商用の日本向けアプリ（販売者ページ）https://ecosire.com/apps/erpnext/erpnext-japan-qualified-invoice
- Odoo: https://github.com/odoo/odoo ／ ライセンス https://raw.githubusercontent.com/odoo/odoo/master/LICENSE ／ `l10n_jp` https://github.com/odoo/odoo/tree/master/addons/l10n_jp ・ https://raw.githubusercontent.com/odoo/odoo/master/addons/l10n_jp/__manifest__.py ・ …/data/template/account.account-jp.csv ・ …/account.tax-jp.csv ・ …/account.fiscal.position-jp.csv ・ …/account.tax.group-jp.csv ・ …/account.depreciation.model-jp.csv ・ …/data/account_report_jct_return.xml ／ JP PINT https://github.com/odoo/odoo/tree/master/addons/l10n_jp_ubl_pint ／ コア https://raw.githubusercontent.com/odoo/odoo/master/addons/account/models/account_move.py ・ …/account_move_line.py ・ …/account_tax.py ・ …/company.py ・ …/account_lock_exception.py ／ 年度末ドキュメント https://www.odoo.com/documentation/18.0/applications/finance/accounting/reporting/year_end.html ／ OCA https://github.com/OCA/l10n-japan ／ 設定解説（検索）https://cybrosys.com/blog/an-overview-of-accounting-localization-for-japan-in-odoo-17
- GnuCash: https://github.com/Gnucash/gnucash ／ ライセンス https://raw.githubusercontent.com/Gnucash/gnucash/stable/LICENSE ／ SQL スキーマ https://wiki.gnucash.org/wiki/SQL ／ 日本語テンプレート https://github.com/Gnucash/gnucash/tree/stable/data/accounts/ja ／ Closing Books（検索）https://code.gnucash.org/wiki/Closing_Books

### 6.2 プレーンテキスト会計

- Beancount: https://github.com/beancount/beancount ／ ドキュメント https://beancount.github.io/docs/ ・ …/beancount_language_syntax/ ・ …/the_double_entry_counting_method/ ・ …/a_comparison_of_beancount_and_ledger_hledger/ ・ …/beancount_query_language/ ／ Fava https://github.com/beancount/fava ／ beangulp https://github.com/beancount/beangulp ／ beanquery https://github.com/beancount/beanquery ／ UTF-8 科目名（検索）https://ledger2beancount.readthedocs.io/compatibility/ ／ 請求書機能なし（検索）https://lwn.net/Articles/785553/
- hledger: https://github.com/hledgerorg/hledger ／ https://hledger.org/hledger.html ／ close のソース（検索）https://hackage-content.haskell.org/package/hledger-1.42.1/docs/src/Hledger.Cli.Commands.Close.html
- ledger-cli: https://github.com/ledger/ledger ／ https://raw.githubusercontent.com/ledger/ledger/master/LICENSE.md
- 日本の個人事例: https://vector.hateblo.jp/entry/2025/02/25/221245 ・ https://nixeneko.hatenablog.com/entry/2023/01/21/000000 ・ https://github.com/yosiopp/ledger-aoiro ・ https://qiita.com/sukimaengineer/items/b0b6acf35b3ffae6770a ・ （検索）https://qiita.com/syoyo/items/427ed6d76661cb190a6c ・ https://qiita.com/kikeg/items/3fa1a2d0366f307bfae4 ・ 商用ベンダーの解説（検索）https://beancount.io/blog/2026/07/27/japan-qualified-invoice-system-2026-deductibility-cut-guide

### 6.3 台帳ライブラリ

- Medici: https://github.com/flash-oss/medici ／ https://raw.githubusercontent.com/flash-oss/medici/master/README.md ／ https://www.npmjs.com/package/medici
- TigerBeetle: https://github.com/tigerbeetle/tigerbeetle ／ https://docs.tigerbeetle.com/coding/data-modeling/ ・ https://docs.tigerbeetle.com/reference/account/ ・ https://docs.tigerbeetle.com/coding/recipes/correcting-transfers/
- Formance Ledger: https://github.com/formancehq/ledger ／ v2 の LICENSE https://raw.githubusercontent.com/formancehq/ledger/v2.4.16/LICENSE ／ v2 README https://raw.githubusercontent.com/formancehq/ledger/v2.4.16/README.md ／ v3 README https://raw.githubusercontent.com/formancehq/ledger/main/README.md ／ ストレージのマイグレーション https://github.com/formancehq/ledger/tree/v2.4.16/internal/storage/bucket/migrations
- pgledger: https://github.com/pgr0ss/pgledger ／ https://raw.githubusercontent.com/pgr0ss/pgledger/main/README.md ・ https://raw.githubusercontent.com/pgr0ss/pgledger/main/pgledger.sql ／ node-pgledger https://github.com/duniyalr/node-pgledger
- 小型 TS: Lefra https://github.com/radzserg/lefra ・ ledgerkit https://github.com/themusashimaru/ledgerkit ・ clovis https://github.com/cloviscomputing/clovis ・ accounting-up https://www.npmjs.com/package/accounting-up ・ @companyio/accounting https://www.npmjs.com/package/@companyio/accounting ・ @mulmoclaude/accounting-plugin https://www.npmjs.com/package/@mulmoclaude/accounting-plugin ・ @fin.cx/skr https://www.npmjs.com/package/@fin.cx/skr
- 他言語: Cala https://github.com/GaloyMoney/cala ・ Blnk https://github.com/blnkfinance/blnk ・ Midaz https://github.com/lerianstudio/midaz
- 参考: LedgerSMB https://github.com/ledgersmb/LedgerSMB

### 6.4 請求書系

- Invoice Ninja https://github.com/invoiceninja/invoiceninja ／ https://raw.githubusercontent.com/invoiceninja/invoiceninja/v5-stable/LICENSE ／ https://raw.githubusercontent.com/invoiceninja/invoiceninja/v5-stable/app/Models/Invoice.php ・ …/CompanyLedger.php
- Crater https://github.com/crater-invoice-inc/crater ・ InvoiceShelf https://github.com/InvoiceShelf/InvoiceShelf

### 6.5 日本固有

- freee: https://github.com/freee/freee-api-schema ／ https://raw.githubusercontent.com/freee/freee-api-schema/master/v2020_06_15/open-api-3/api-schema.json ／ https://github.com/freee/freee-mcp ／ https://github.com/freee/freee-accounting-sdk-javascript ほか ／ https://github.com/LayerXcom/freee-go ・ https://github.com/siketyan/freee-rs ・ https://github.com/studio4096/freee-api-axios ・ https://github.com/knishioka/freee-mcp ／ ヘルプ（検索）https://support.freee.co.jp/hc/ja/articles/207362843
- 公表システム Web-API: https://www.invoice-kohyo.nta.go.jp/web-api/index.html ／ https://github.com/nisyuu/kendama ・ https://github.com/nisyuu/kendama-python ・ https://github.com/SUGUKURU-CO-LTD/mcp-houjin-bangou ・ https://github.com/yoshitokameyama/japan-data-mcp ・ https://github.com/tk-aria/invoice-lookup ・ https://github.com/chanshige/houjin-bangou ・ https://github.com/MasakiNiwa/Invoice
- 消費税・インボイス計算: https://github.com/ashkobo/japan-invoice-mcp ・ https://github.com/foovar-toku/jp-invoice
- 電帳法: https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/pattern/04.htm ／ https://github.com/hideyukiMORI/nene-vault ・ https://github.com/roundshape/denchokun_electron ・ JIIMA 認証（Qiita 経由）https://www.jiima.or.jp/certification/denshichoubo_soft/
- e-Tax: https://www.e-tax.nta.go.jp/hojin/gimuka/csv_jyoho4.htm ／ https://www.e-tax.nta.go.jp/hojin/financial_statements.htm（Qiita 経由）／ https://github.com/nt1969m/eTaxtools ・ https://qiita.com/nt1969m/items/7edac99942a8c11fe32c ／ https://github.com/Lonshaus/aoiko ・ https://github.com/kim-parkchik/domble ・ https://github.com/Arrenem/opentax ・ https://github.com/louie47690/zeicheck ・ https://github.com/kazukinagata/shinkoku ／ ドイツ・英国の XBRL: https://github.com/quambene/taxel ・ https://github.com/Persblack/xbrl-cli ・ https://github.com/cybermaggedon/ixbrl-reporter ／ EDINET 読み取り: https://github.com/teatime77/xbrl-reader
- 勘定科目・ルール: https://github.com/tsubasagit/kanjokamoku ・ https://github.com/zeimu-ai/open-journal-rules
- 銀行・全銀: https://github.com/zengin-code/source-data ・ https://github.com/zengin-code/zengin-js ・ https://github.com/zengin-code/zengin-rb ・ https://github.com/Kyash/zengin-go
- 個人事業主向け: https://github.com/rubydogjp/openkk ・ https://github.com/onihei/kanean ・ https://github.com/shuji-bonji/e-shiwake ・ https://github.com/se1987/tsumiki-kaikei ・ https://github.com/knishioka/simple-bookkeeping（データモデル https://github.com/knishioka/simple-bookkeeping/blob/main/docs/specifications/data-model.md）・ https://github.com/34j/aoiro ・ https://github.com/hanabishi-code/aoringo-choubo ・ https://github.com/TakeshiOkamoto/mpp_fsjs ・ https://github.com/sagami1991/aoiroshinkoku-sheet-gas ・ https://github.com/arowM/haskell-bookkeeping-jp
- 国税庁関連の一般解説（検索）: 法人税の電子申告・別表 XML https://www.e-tax.nta.go.jp/hojin/gimuka/r8_4go_outline_2026.pdf ほか

### 6.6 設計記事

- Fowler: https://martinfowler.com/apsupp/accounting.pdf ・ https://martinfowler.com/eaaDev/AccountingTransaction.html ・ https://martinfowler.com/eaaDev/AccountingEntry.html ・ https://martinfowler.com/eaaDev/ReversalAdjustment.html ・ https://martinfowler.com/eaaDev/DifferenceAdjustment.html ・ https://martinfowler.com/eaaDev/ReplacementAdjustment.html ・ https://martinfowler.com/eaaDev/EventSourcing.html ・ https://martinfowler.com/articles/bitemporal-history.html
- Square: https://developer.squareup.com/blog/books-an-immutable-double-entry-accounting-database-service/
- Stripe（検索）: https://stripe.com/blog/ledger-stripe-system-for-tracking-and-validating-money-movement
- Modern Treasury: https://www.moderntreasury.com/accounting-for-developers ・ https://www.moderntreasury.com/journal/enforcing-immutability-in-your-double-entry-ledger ・ （検索）https://www.moderntreasury.com/journal/how-to-scale-a-ledger-part-iv ・ https://moderntreasury.com/journal/how-to-scale-a-ledger-part-v ・ https://moderntreasury.com/journal/how-to-scale-a-ledger-part-ii
- pgrs.net: https://pgrs.net/2025/06/17/double-entry-ledgers-missing-primitive-in-modern-software/ ・ （検索）https://pgrs.net/2025/03/24/pgledger-ledger-implementation-in-postgresql/
- 日本語: https://dbconcept.hatenablog.com/entry/2022/09/17/160851 ・ https://engineering.mercari.com/blog/entry/2019-09-19-113909/ ・ （検索）https://qiita.com/tanakadaichi_1989/items/09e0ce35f3ebc9afc352 ・ https://giogiogiogio.hatenablog.com/entry/2024/12/14/213014

### 6.7 未確認・今後の確認候補

- Bigcapital が日本の銀行で使える銀行接続手段（Plaid は日本非対応の可能性）。
- Beancount v3 で `資産:現金` のような日本語科目名が通るかの実機検証。
- Odoo `l10n_jp` のレポート UI（付表の出力）が Community で動くか Enterprise 必須か。
- Formance Ledger v3 のライセンス（main に LICENSE ファイルなし）。
- freee の `taxes`（税区分コード）一覧の値と名称（API 実行が必要）。
- 法人税申告書（別表）の XML 仕様と eLTAX（地方税）の扱い。
- JP PINT（デジタルインボイス）対応 OSS（Odoo `l10n_jp_ubl_pint` 以外は latonaio の古い試作のみ確認）。
