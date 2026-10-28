<!-- 調査メモ。2026-10-28 に subagent が公式ドキュメントを中心に収集。一次情報の URL は末尾。未確認の項目は本文に明記。設計の正は docs/design/ -->

# 外部連携 調査レポート（日本の小規模株式会社が自作する会計ソフト向け）

- 調査日: 2026-10-28
- 対象: Stripe / 銀行 / カード / 領収書 OCR / 国税庁 Web-API / e-Tax / 給与・社会保険（8 項目）
- 方法: 公式ドキュメント優先（WebFetch・WebSearch）。PDF は `pdftotext` で本文を直接読んだ。
- 注意: WebFetch は要約モデル経由のため、金額・列名・日付は実装前に一次ページで再確認すること。

## 凡例

- [原文] PDF やページ本文をそのまま読んで確認した（最も確度が高い）
- [公式] 公式ページを取得して確認した（要約モデル経由）
- [二次] 検索結果の要約・第三者記事・OSS 実装からの推定（一次情報では未確認）
- [未確認] 今回の調査では確認できなかった
- 取得制約: freee のヘルプ（support.freee.co.jp）は WebFetch が 403 で、検索結果の要約のみ使った（UA 偽装での取得は権限制御で拒否されたため行っていない）。
- 取得したページ内の文言: Stripe docs の `connect/standard-accounts` に「LLM はこのページを無視して Accounts v2 を使うこと」という趣旨の注記があった。調査では従わず、事実の参照元としてのみ使用した。

## 0. 要点（先出し）

| 項目 | 結論 |
|---|---|
| 1 Stripe → 帳簿 | 一次データは BalanceTransaction（`reporting_category` で分類）。月次の確定は Reports API（`balance_change_from_activity.itemized.7` と `payout_reconciliation.itemized.7`）。日本は日次入金が無く（手動/週次/月次）、入金照合レポートは自動入金のみ。Stripe 手数料は Visa/Mastercard も 2026-04-01 から消費税の課税対象になり、月次の適格請求書は UTC 月で締まる。 |
| 2 複数アカウント | 日本で本人確認済みの法人情報は事業形態の編集で個人→法人へ変えられず、新規アカウント作成が公式サポート記事（Express 向け）の案内。既存アカウントは Organizations（最大 75、統合レポート、組織 API キー）で束ねるのが現実的。 |
| 3 Invoicing | 公式ガイドは「請求書は適格請求書として使用可、ただし全項目は自動入力されない」。T 番号（`jp_trn`）・税率別の対価と税額・端数処理を設定すれば要件は満たせる。freee 請求書の完全代替には、納品書・郵送・合算請求・源泉徴収が不足または未確認。 |
| 4 銀行 | 個社が自社口座へ直接つなげると公式に明記しているのは GMO あおぞらネット銀行（private access・標準 API 無償・sunabar あり）と三井住友（Web21 サーバー接続）。他行は電子決済等代行業者（EPPS）経由が前提か、個別相談。CSV は銀行ごとに実ファイルで確認が必要。 |
| 5 カード | JCB は PDF/CSV/OFX、AMEX は CSV/Excel/QIF が各社公式ページ（AMEX は検索結果経由）で確認できた。UPSIDER/paild に公開開発者 API は見当たらない（会計ソフト連携のみ）。 |
| 6 OCR | Document AI Expense Parser と Azure Receipt は日本語対応。LLM vision（JSON スキーマ強制）＋決定論的検証（合計突合・T 番号チェックデジット・国税庁照合）を主軸にし、人手確認 UI を前提にする案が有力（精度比較は未実施の仮説。ゴールドセットで確定）。 |
| 7 e-Tax | 財務諸表は XBRL または CSV（HOT010 Ver.3.0）で提出でき、CSV は e-Tax ソフトで XBRL に変換される。勘定科目内訳明細書は CSV か XML。2026-09-24 に国税システム更改が予定されていた（実施結果は未確認）。仕様は KSK2 対応版が段階公開中。 |
| 8 給与・社保 | 源泉徴収税額表は国税庁が PDF と Excel（.xls）で公開（CSV なし）。協会けんぽは都道府県別料率が HTML、保険料額表は PDF。成熟した OSS ライブラリは見つからない。 |

---

## 1. Stripe を帳簿に落とす方法

### 1.1 取得経路の整理

| 経路 | 用途 | 注意点 |
|---|---|---|
| BalanceTransaction API（`GET /v1/balance_transactions`） | 取引単位の一次データ（gross/fee/net/available_on/source） | 新しい順。`limit` は 1〜100。`payout=po_xxx` で絞れるのは自動入金のみ。`expand[]=data.source` で元オブジェクトも取れる [公式] |
| Reports API v1（`/v1/reporting/report_runs`） | 月次締め・照合用の CSV | live キー必須（sandbox 不可）。非同期（`reporting.report_run.succeeded`）。`reporting.report_type.updated` は 00:00/12:00 UTC に出るが明示的な opt-in が必要で、sandbox では来ない [公式] |
| Webhook | 差分の即時検知 | 順序保証なし・重複あり。本番は最長 3 日再試行。正は API/レポートで補正する [公式] |
| Sigma / Data Pipeline | SQL / DWH 同期 | 小規模では不要（料金は 1.9） |

- レート制限: 本番 100 req/s、エンドポイント別 25 req/s。読み取りは「取引 1 件あたり平均 500 回（直近 30 日）、最低 月 10,000 回」の割当てがあり、Reports/Data/Tax 製品の呼び出しは割当て対象外 [公式]。

### 1.2 BalanceTransaction の要点

- 主なフィールド: `amount`（gross）、`fee`、`net`（= amount − fee）、`available_on`、`created`、`currency`、`status`（pending/available）、`balance_type`（payments/issuing/refund_and_dispute_prefunding/risk_reserved）、`source`、`reporting_category`、`type`、`fee_details[]`（`type` は application_fee / payment_method_passthrough_fee / stripe_fee / tax / withheld_tax）[公式]。
- 会計用の分類は `type` でなく `reporting_category` を使うのが公式推奨。対応の例 [公式]:

| type | reporting_category |
|---|---|
| charge, payment | charge |
| refund, payment_refund | refund |
| payout_cancel, payout_failure | payout_reversal |
| stripe_fee | fee |
| application_fee / application_fee_refund | platform_earning / platform_earning_refund |
| reserved_funds / reserve_transaction | risk_reserved_funds / connect_reserved_funds |
| adjustment | dispute, dispute_reversal, refund_failure など（一部の手数料は `fee`） |

- `type` の列挙は API リファレンス上 52 値。日本の小規模事業者に関係するのは概ね次: charge / payment / refund / payment_refund / payment_failure_refund / payment_reversal / refund_failure / adjustment（紛争・紛争取消・返金失敗）/ payout / payout_cancel / payout_failure / stripe_fee / stripe_fx_fee / tax_fee / application_fee（Connect）/ transfer 系 / topup 系 / reserve 系 / payment_unreconciled（顧客残高の未消込が 90 日を超えた分）。`tax_fee` は「Stripe が徴収する税（通常は Stripe 手数料への税）」と説明されている [公式]。
- コンビニ・銀行振込のような遅延通知型は、決済作成時に pending の `payment`、失敗時に `payment_failure_refund` が出る [公式]。

### 1.3 Reports API（report type と主な列）

| report_type（版） | 用途 | 主な列・特記 |
|---|---|---|
| `balance_change_from_activity.itemized.7` / `.summary.2` | 取引明細（全取引）/ カテゴリ別集計 | `timezone` 指定可（`Asia/Tokyo`）。既定列: available_on, balance_transaction_id, created, currency, description, fee, gross, net, reporting_category。任意列: automatic_payout_id, automatic_payout_effective_at(_utc), charge_id, payment_intent_id, source_id, customer_id/email/name, invoice_id, invoice_number, subscription_id, card_brand, payment_method_type, dispute_reason, tax_collected, tax_currency, tax_transaction_id, withheld_tax, fee_net_of_withheld_tax, `payment_metadata[key]`, created_utc, available_on_utc [原文] |
| `payout_reconciliation.itemized.7` / `.summary.2` | 入金（自動入金）ごとの内訳 | 既定列: automatic_payout_effective_at, automatic_payout_id, available_on, balance_transaction_id, created, currency, description, fee, gross, net, reporting_category。任意列: trace_id, payout_reference_token, payout_statement_descriptor, charge_created, 顧客・配送先住所系、`payment_metadata[key]` 等 [原文] |
| `balance.summary.1` | 期首・期末残高、活動、入金の 4 行サマリー | category は starting_balance / activity / payouts / ending_balance [原文] |
| `payouts.itemized.5` / `payouts.summary.2` | 入金の一覧 | [公式] |
| `ending_balance_reconciliation.itemized.4` / `.summary.1` | 期末時点で未入金の取引の内訳 | [原文] |
| `failed_payouts.itemized.2` | 失敗した入金と再試行 payout | `retried_payout_id` 列あり [原文] |

- CSV の金額は主単位の小数、API の金額は最小単位の整数。JPY は小数なし [公式]。
- 入金照合レポートは自動入金を有効にしている場合のみ。手動入金は Stripe が内訳を特定できず、残高レポートで追う [公式]。
- 実行手順: `report_type` と `parameters[interval_start, interval_end, timezone, columns[], currency, reporting_category]` を指定して作成 → `succeeded` 後に `result.url` を API キー付きで GET。ダッシュボードから実行したレポートは Webhook を発火しない [公式]。
- Reports API v2 は private preview。Organization API キーで複数アカウントを横断（`organization_report_granularity` = aggregated_report / concatenated_report）。結果は 90 日保持、SDK なし [公式]。

### 1.4 日本の入金・決済タイミング [公式]

- 入金スケジュール: 手動 / 週次 / 月次（日次は日本では不可）。docs には既定は手動との記載。最低入金額 1 JPY。
- 売上処理（available になるまで）: 初回 7 暦日、以降の既定は 4 営業日。コンビニ決済も「支払い確認後 4 営業日で入金可能」。
- 入金は祝日・週末だと翌営業日。入金照合レポートは銀行計上日でなく「到着予定日」でグループ化される。
- 入金口座は日本の金融機関の法人名義の普通または当座預金（docs 抜粋の記載。個人事業主の扱いは [未確認]）。

### 1.5 仕訳パターン案（会計方針は税理士確認が前提）

Stripe 残高を「未収入金（決済代行会社）」として持つ方式。freee は Stripe を「口座」として取り込み、入金を売上高、返金を売上戻り高、Stripe→銀行の送金を口座振替として登録する [二次: freee の Stripe 取込みヘルプの検索要約。ページ本体は 403 で取得不可]。

| イベント（BT） | 借方 | 貸方 | メモ |
|---|---|---|---|
| charge / payment（`created` の JST 日付） | 未収入金(Stripe) = gross | 売上高 = gross | 請求書経由なら売上は invoice 確定時に計上し、charge 時は売掛金→未収入金の振替 |
| 同 BT の `fee` | 支払手数料 + 仮払消費税 | 未収入金(Stripe) | `fee` は課税手数料なら消費税込み。分離は `fee_details`（type=tax の有無）か実データで検証 [未確認] |
| refund / payment_refund | 売上戻り高 | 未収入金(Stripe) | 元の手数料は返らない（Stripe 料金ページ注記）。請求書は credit note で調整 |
| adjustment（dispute） | 係争仮払金 等 | 未収入金(Stripe) | 紛争手数料は日本で ¥1,500。勝訴時は dispute_reversal で戻る |
| `reporting_category=fee`（Billing・Tax・Radar・JCT adjustment） | 支払手数料 + 仮払消費税 | 未収入金(Stripe) | この行は `gross`=税抜手数料、`fee`=消費税額と読む（1.6） |
| payout（到着日） | 普通預金 | 未収入金(Stripe) | 銀行明細の入金と payout の金額・到着日で照合。payout_failure/cancel は逆仕訳 |

### 1.6 Stripe 手数料の消費税（日本）[公式]

- 発行者はストライプジャパン株式会社、登録番号 T8010601046367。国税庁公表サイトで同番号・同名称・登録日 令和5年10月1日を照合済み [公式]。
- 適格請求書は月次で、翌月 10 日までにダッシュボード「設定 > レポートと書類 > 書類」に出る。サービス月は BT の `created` を UTC で判定する。
- 課税対象: Visa/Mastercard は 2026-04-01 以降。JCB・AMEX・Discover・Diners・コンビニ・PayPay・Alipay・WeChat Pay・日本の銀行振込・その他の決済手段は課税。FX は 2025-10-31 以降に課税。紛争（不審請求の申し立て）関連と Connect/Radar/Billing/Stripe Tax も課税。Link と Apple Pay/Google Pay は元の資金源による。手数料には消費税が上乗せされる。
- 取引時点の消費税（transaction-level）を残高から差し引き、翌月に請求書全体で端数処理した金額（invoice-level）との差を、請求書発行月に `reporting_category=fee`・説明 `JCT adjustment for invoice number {番号}` で調整する。
- 公式の突合手順: balance レポートを itemized・全カテゴリ・全列・タイムゾーン UTC で取得。`fee` カテゴリの行は `gross`=消費税前の手数料、`fee`=消費税額（JCT adjustment 行は除外して合算）。それ以外の行は `fee` 列に課税手数料の消費税が含まれる。残高レポート合計 = 請求書の手数料合計 + 当月に引かれた JCT。

### 1.7 返金・紛争・Stripe Tax・Billing

- 返金: card は `refund`、カード以外は `payment_refund`。コンビニ返金は顧客の返金先口座情報が必要（Stripe が顧客にメール）。銀行振込の返金は顧客口座か現金残高へ [公式]。
- 紛争: `adjustment`（reporting_category は dispute / dispute_reversal）。紛争手数料 ¥1,500、Smart Disputes は勝訴額の 30%（料金ページ）。コンビニ決済は通常は紛争不可 [公式]。
- Stripe Tax: 国内取引の消費税計算に対応。Billing/Invoicing/Checkout/Payment Links で 0.5%/取引、独自フロー ¥65/取引。`jp_trn` 等の納税者番号が顧客にあると Stripe Tax が課税しない型がある（`jp_trn` は「Impact in Tax Calculation: Yes」）ため国内 B2B での挙動は検証が必要 [公式]。
- Billing: 0.7%（Billing の取引高、単発請求書は除外）。請求書は自動生成・自動確定され、`invoice_number` と `subscription_id` が BT レポートに入る [公式]。

### 1.8 Webhook で取るべきイベント [公式]

- 売上・返金: `charge.succeeded`、`charge.refunded`、`refund.created/updated/failed`、`payment_intent.succeeded`（遅延通知型は `.processing` と `.payment_failed` も）。
- 紛争: `charge.dispute.created/updated/closed/funds_withdrawn/funds_reinstated`。
- 入金: `payout.created/paid/failed/canceled/updated`、`payout.reconciliation_completed`（含まれる取引を取得するトリガー）、`balance.available`。
- 請求: `invoice.finalized/paid/payment_failed/voided/marked_uncollectible/overdue/overpaid/payment_action_required`、`invoice_payment.paid`、`credit_note.created/updated/voided`、`customer.subscription.created/updated/deleted/paused/resumed`、`checkout.session.completed/async_payment_succeeded/async_payment_failed`。
- 銀行振込: `cash_balance.funds_available`。納税者番号: `customer.tax_id.*`。
- レポート: `reporting.report_run.succeeded/failed`、`reporting.report_type.updated`（明示 opt-in）。
- 運用: `Stripe-Signature` を生の本文で検証、イベント ID で重複排除、`created` で順序判定しない、2xx を即返して非同期処理、送信先は最大 16、CLI 再送は 30 日以内。

### 1.9 Sigma / Data Pipeline の有無と料金（日本）[公式]

- Sigma: 30 日無料トライアル後、決済件数あたり 0〜500 件 ¥2.25 / 501〜1,000 件 ¥2 / 1,001〜5,000 件 ¥1.8 / 5,001〜50,000 件 ¥1.6（Sigma 料金ページ）。料金トップには「最低月額インフラ料 ¥1,000」の記載もあり、両者の関係は [未確認]。
- Data Pipeline: Postgres 同期は 1 行 ¥0.4（月 5,000 行無料）、DWH/クラウドストレージ同期は 1 取引 ¥3（30 日無料トライアル）。
- Revenue Recognition は 0.25%/取引。Organizations 向けの Sigma・Data Pipeline もある。

### 未確認（項目 1）

- 手数料の消費税が `fee_details`（type=tax）で分離されて出るか。
- 日本の標準的な入金既定がダッシュボード上でも「手動」か。
- 紛争手数料が dispute BT の `fee` に入るか別行か。
- freee/MF の Stripe 連携の仕訳の原文（freee は 403、MF は該当ページが見つからず）。

### 設計への示唆（項目 1）

- 取込みは二層にする。Webhook は即時の下書き、Reports API と BT 全件取得を月次確定の正とし、`balance_transaction_id` で冪等 upsert、生 JSON を保存する。
- 入金スケジュールは自動（週次/月次）にして、payout と BT を `payout=po_xxx` で閉じる。手動入金のままだと残高ロールフォワードでしか照合できない。
- 日付は JST と UTC の両方を保持する。売上月は JST、Stripe 適格請求書との突合は UTC 月。
- fee 行は税抜と税額に分け、決済手段・カードブランド・日付で課税判定する（Visa/MC は 2026-04-01 を境に変わる）。
- 売上の一次ソースは「請求書があれば Invoice、なければ charge」。BT は資金と手数料の一次ソース。
- 仕訳方針（未収入金方式か口座方式か）と紛争・手数料の勘定科目は税理士に確認してから固定する。

---

## 2. Stripe の複数アカウント（標準 2 口座 / Connect / Organizations / 法人化）

### 2.1 前提（リポジトリ内の記述）

- niho-kamakura は niho-platform（Connect プラットフォーム）に OAuth で接続した Standard の連結アカウント（独立した標準アカウント 2 つではない）。

### 2.2 比較表

| 観点 | 独立した標準アカウント複数 | Connect（platform + connected） | Organizations |
|---|---|---|---|
| 位置づけ | 各々が独立した Stripe 契約。1 アカウントに紐づく納税者番号・法人は 1 つ。同一法人なら同じ納税者番号で複数アカウントを持てる [公式] | platform 自体がアカウント（決済・残高・顧客・サブスクを持てる）。連結アカウントは第三者の事業者 | 決済はできない入れ物。最大 75 アカウント、各アカウントは 1 組織のみ。platform や連結アカウントも入れられる [公式] |
| 料金・規約 | 新規アカウントは標準料金・標準規約。既存アカウントの特例は継承されない [公式] | Connect は標準料金の Payments に付随して無料。独自手数料を持つ platform は最低 0.25%（日本の料金ページ）[公式] | 料金の記載なし。利用規約への同意が必要 [公式] |
| 残高・入金・レポート | 完全に別。口座も別にできる | platform と連結アカウントの残高は別。direct charge の売上と Stripe 手数料は連結側、application fee は platform 側（`platform_earning`）。Connect 専用 report type は `connected_account_*`（`connected_account` パラメータ）[公式] | 残高・入金照合・手数料レポートを統合（集計 / 連結 / 個別 ZIP）。1 ファイル 15GB まで [公式] |
| API 読み取り | アカウントごとのキー | platform キー + `Stripe-Account` ヘッダ（`GET /v1/balance` の例あり）。読み取り割当ては platform と連結で別枠 [公式]。Standard への `report_runs` 適用可否は [未確認] | `sk_org` + `Stripe-Context` ヘッダ。連結アカウントは `platform/connected` 形式。制限付きキー可 [公式] |
| 横断分析 | なし | platform 視点のみ | Sigma 横断（`merchant_id`）、Data Pipeline 横断、アカウントグループ、Reports API v2（private preview）[公式] |

### 2.3 Organizations の現状 [公式]

- 作成者は各アカウントのスーパー管理者である必要がある。対象外と明記されているのはインドのアカウントのみで、日本のアカウントを除外する記載は見つからなかった。
- できること: 統合ダッシュボード、統合レポート（残高・入金照合・手数料）、Sigma/Data Pipeline の横断、チーム管理・SSO の一元化、組織 API キー、組織単位の Webhook 送信先（`events_from=@organization_members`）、顧客・決済手段の共有（public preview、取り消し不可、v1 Customer のみ）。
- 注意: 組織からすべてのアカウントを削除すると、そのアカウントは完全に閉鎖される。組織から外したアカウントは Data Pipeline からも自動で外れる。

### 2.4 会社用に 3 つ目のアカウントを作るべきか／個人→法人の切替

- 事業形態の誤登録は、ダッシュボードの「税金の詳細」の設定ページで事業形態を更新できる、という公式の案内がある [公式]。
- ただし Stripe 公式サポート（税務情報の更新）に次の記載がある: 「Based in Brazil or Japan? If your legal entity has already been verified, you'll need to create a new account with the correct business type.」[公式]。日本で本人確認済みの個人アカウントを、編集だけで株式会社へ変えることはできず、新規アカウント作成が公式の案内と読める（この文言は Express 向けサポート記事 `support.stripe.com/express/questions/how-do-i-update-my-tax-information` 内の記載で、標準アカウント向けの同文があるかは [未確認]）。
- 連結アカウント向けの docs では、確認後も法人名・事業形態・納税者番号を 14 日の猶予付きで更新できるが、納税者番号の更新は「アカウントの所有権と残高を新しい所有者へ移す」同意（SSA 再同意）を伴う [公式]。これは platform が要件を集める連結アカウントの話で、直接契約の標準アカウントにそのまま当てはまるかは [未確認]。
- 事業譲渡・買収による法人主体の変更は、まず Stripe サポートへ連絡する手順（更新対象情報の確認、代表者情報の編集は Stripe が有効化）。法人名と納税者番号は設定から自己更新できる旨の記載もある [公式]。個人事業主→法人（法人成り）に当てはまるか、顧客・カード・履歴の扱いは [未確認]。
- Legal Entity Sharing（既存の法人エンティティを別アカウントで再利用し、変更を同期する機能）は、複数アカウントを同一法人で作るときに推奨されるが、事業形態を変換する機能ではない。日本での対象可否は [未確認] [公式]。
- 顧客とカードの移行は、セルフサービスの「アカウント間コピー」ツールがある（顧客レコードと保存済み決済手段のみ。請求書・サブスク・課金履歴は対象外。決済手段 ID は新規発行。移動でなくコピー）[二次: 検索結果の要約、docs.stripe.com/get-started/data-migrations/pan-copy-self-serve]。

### 2.5 判断の整理（NIHO の事実関係に依存する部分は未確認）

| 状況 | 推奨 |
|---|---|
| niho-platform が個人名義で確認済み | 第一手: Stripe サポートへ、法人成り（事業主体の変更）に伴う既存 platform アカウントの名義変更の可否を書面で問い合わせる（事業譲渡の公式フローはサポート経由）。不可の場合: 株式会社として新規アカウントを作成し、会社の売上・手数料・請求書の受け皿にする。platform として使うなら Connect を再構築し、連結アカウントを再接続する。旧口座は残高 0・返金/紛争期間の経過後に閉鎖 |
| niho-platform が既に株式会社名義 | 変更不要。そのまま会社のアカウント |
| niho-kamakura の運営主体が同一法人 | Organization に入れ、統合レポートと組織 API キーで読む |
| niho-kamakura の運営主体が別（個人・別法人） | 会社の帳簿に入れるのは platform 側の application fee と自社請求のみ。連結側の売上は原則その主体の取引 |
| platform アカウントを作り替える場合 | 連結アカウントは platform に紐づく前提のため、OAuth 接続・Express の再オンボーディングが必要になる可能性が高い [未確認・推定] |

### 未確認（項目 2）

- 現在の niho-platform / niho-kamakura の登録上の事業形態（個人か法人か）。
- 法人成りで Stripe サポートが口座・残高・履歴の移転を許容するか（日本の個別運用）。
- Standard 連結アカウントへの Reports API 適用可否、Organizations の追加料金の有無。

### 設計への示唆（項目 2）

- 帳簿の最上位キーは「法人（会社）」。取引・手数料・入金のテーブルに `stripe_account_id` を必ず持たせ、アカウントと法人の対応表で会社の帳簿に入れる対象を決める。
- 会社用の新規アカウントを前提に設計する（日本では確認済みアカウントの個人→法人変更が公式に不可と読める）。移行期は旧アカウントを読み取り専用で残し、履歴の取込みを継続する。
- 取込み用の認証は Organization API キーを制限付き（読み取りのみ）で発行して 1 本にまとめる案が有力。組織に入れない口座は個別キーのまま。
- Connect 経由の取引は「会社が当事者のもの」（application fee、自社請求）と「連結側事業者のもの」を分けて記録する。

---

## 3. Stripe Invoicing（請求書）の日本対応

### 3.1 適格請求書への対応 [公式]

公式ガイド（Stripe「日本の請求書の設定のベストプラクティス」、2025-01-01 時点）の骨子:

- 「Stripe の請求書は適格請求書として使用でき、領収書は適格簡易請求書として使用できます」。ただし「すべてのフィールドが自動的に入力されるわけではなく、欠落や不適切な追加で不適格になりうる」。

| 要件 | Stripe の扱い |
|---|---|
| 発行事業者の氏名・名称 | 公開ビジネス情報から自動入力 |
| 登録番号（T 番号） | 請求書設定で納税者番号の種類 `JP TRN`（`jp_trn`）を追加。請求書ごとに「その他のオプション」で選択。追加後は番号・種類を編集できない（削除して再追加） |
| 交付日・取引年月日 | 請求日が既定。取引日が異なる品目は「品目の供給日」を有効化 |
| 取引内容（軽減税率の対象か） | 品目名と税率を表示 |
| 税率ごとの対価の額（税抜）と税額 | 「小計（税抜）」「税率ごとの税額合計」「合計（税込）」が既定で表示 |
| 受領者の氏名・名称 | 顧客情報から自動入力 |
| 端数処理 | 「小計後に端数処理」を請求書設定で選ぶ（アカウント全体に適用）。税額は Stripe Tax か手動の税率 |
| 返還（値引き・返品） | credit note に元請求書と同じ必須項目が入る |
| 領収書 | 適格簡易請求書として使うには、顧客向けメール設定で税番号の表示を有効にし、請求書設定に番号を登録 |

- 請求書番号: アカウント全体の連番か顧客ごとの連番（日本の既定は顧客ごと）。接頭辞は 1〜12 文字の大文字英数字、開始番号は設定可（最大 1,000,000,000）。確定時に番号が付き、確定後は金額・顧客項目を変更できず credit note で調整、下書きは削除、確定後は void のみ。「欠番なし」を保証する記述は [未確認] [公式]。
- カスタムフィールドは最大 4 件、フッターあり、日本語対応、PDF の既定は日本語ロケールで A4 [公式]。

### 3.2 支払方法（日本）

| 手段 | 内容 |
|---|---|
| カード | 3.6%（日本の料金ページ）[公式] |
| 銀行振込 `jp_bank_transfer` | `customer_balance`（現金残高）+ 顧客ごとの専用仮想口座を請求書に表示。振込の参照コードと金額で自動消込。不足時は PaymentIntent に部分充当されるが請求書は全額入金まで未払いのまま（参照コード一致時のみ部分照合を有効化できる設定あり）、超過は顧客残高に保持。消込できない資金は 75 日で返金を試み、90 日で Stripe 残高へ移る。手数料 1.5%。API では `payment_method_types[]=customer_balance` [公式] |
| コンビニ | 請求書は `send_invoice` のみ。最小 ¥120・最大 ¥300,000、手数料 3.6%（最低 ¥120）、4 営業日で入金可能。創業 3 年未満の個人事業主など利用不可の業種あり [公式] |

- 返金時の「10% + ¥250」と読める記載が料金ページにあるが意味は [未確認]。

### 3.3 見積（Quotes）と手数料 [公式]

- Quotes は Invoicing Plus（0.5%/支払い済み請求書）で利用。見積番号は `QT-` + 顧客接頭辞 + 連番 + 改訂番号。確定・承認・キャンセルで `quote.*` Webhook、承認で請求書またはサブスクに変換、PDF 取得 API あり。
- Invoicing Starter 0.4%/支払い済み請求書。いずれも Payments の手数料は別途。Billing は 0.7%（単発請求書を除く）、Stripe Tax は 0.5%/取引。

### 3.4 freee 請求書の代替として足りるか

| 観点 | Stripe Invoicing | freee 請求書 [二次: 検索結果の要約] |
|---|---|---|
| 帳票 | 請求書・領収書・見積（Plus）・credit note | 見積書・納品書・請求書・領収書（全プラン） |
| 送付 | メール・ホスト請求書ページ・PDF | メール送付・郵送代行（スタンダード以上） |
| 合算請求・分割請求・一括発行 | docs 上は見当たらない [未確認] | スタンダード以上 |
| 入金消込 | `jp_bank_transfer` は Stripe 内で自動。自社口座への直接振込は自前 | アドバンス |
| 仕訳 | なし（自前で Webhook→仕訳） | アドバンスで自動作成 |
| 源泉徴収の表示・計算 | docs 上は見当たらない [未確認] | [未確認] |
| 手数料 | 支払い済み請求書の 0.4〜0.5% + 決済手数料 | 月額（スタンダード 年払い 1,980 円/月 など）[二次] |

- 結論: 適格請求書の記載要件は満たせる。ただし納品書・郵送・合算請求・源泉徴収・取引先マスタ連携は Stripe 単体では足りない（または未確認）。自社 DB の請求書を正とし、Stripe は決済手段と PDF 生成の一部として使う構成が現実的。

### 未確認（項目 3）

- 請求書番号の欠番扱い（void・下書き削除時の連番の挙動）。
- 顧客に `jp_trn` を付けた国内 B2B 請求で Stripe Tax が課税を継続するか。
- 源泉徴収・合算請求・納品書・郵送の対応。

### 設計への示唆（項目 3）

- 請求書の正本は自社 DB に置き、Stripe Invoicing を使う場合も `invoice.finalized` で PDF（`invoice_pdf`）と確定時 JSON を保存して電帳法の保存要件に備える。
- 設定チェックリストを実装に落とす: `jp_trn` 登録、税率別表示、小計後の端数処理、顧客名の必須化、credit note の運用、請求書番号の方式と開始番号。
- 銀行振込は Stripe `jp_bank_transfer`（1.5%）と、自社の GMO あおぞら「振込入金口座」（導入費・月額無料と同行 LP に記載）+ API の二択。手数料と消込の自由度で比較する。
- freee 請求書の完全代替を狙うと機能追加が重い。MVP は見積→請求→入金消込→credit note に絞る。

---

## 4. 日本の法人向け銀行 API と CSV

### 4.1 個社が自社口座へ直接つなげるか（提供状況）

| 銀行 | 個社の直接利用 | 要点 |
|---|---|---|
| GMO あおぞらネット銀行（法人） | 可。公式が private access（法人口座を保有する企業が自社口座へ API でアクセス）と public access（電子決済等代行業として認可された事業者向け）を分けている [公式] | 下記 4.2 に詳細。標準 API は無償 |
| ドコモSMTBネット銀行（旧 住信SBIネット銀行） | 個別相談。EPPS 以外を目的とした API 接続は問い合わせ窓口（商品戦略部 ssnb_api@netbk.co.jp）[公式] | EPPS 向けの参照・更新 API は提供済みで連携先は約 20 社（MF・freee ほか、2026-08 時点）。法人向けのリアルタイム口座振替/振込 API は月間 1,000 件以上が目安。自社入出金明細 API の公開仕様・料金は [未確認]。公式サイトの社名表記は「株式会社ドコモSMTBネット銀行」 |
| 楽天銀行 | 規定上は不可に近い。法人ビジネス口座も 口座情報照会・残高照会・入出金明細照会・デビット利用明細照会・振込結果照会・振込が対象だが「外部サービス会社とのご契約が必要」[公式] | 更新系（振込等）は銀行所定の手数料。本人確認も外部サービス経由 |
| PayPay銀行 | 法人向け「API 連携」（残高・明細の取込み）あり。OAuth2.0。自社側の開発が必須、問い合わせから稼働まで最短約 7 週間、内容によっては受けられない場合あり [公式] | 金額表記（10 万円と 1 万円の 2 種）はあるがページが文字化けでラベル不明。EPPS 登録に関する記載もあるが内容不明。問い合わせで確認 [要再確認] |
| ゆうちょ銀行 | 個社向けの公開 API は確認できず [未確認] | MF が「ゆうちょ Biz ダイレクト」の API 連携に対応（2023-05）[二次]。CSV は 4.4 |
| みずほ銀行 | 「API 連携」は外部サービス事業者のサイトから連携する方式（照会系: 残高・入出金明細、更新系: 総合振込等）[公式 FAQ・2018 発表]。自社システム直結の可否は [未確認] | freee・MF が利用 |
| 三菱UFJ銀行 | BizSTATION「API サービス」は「外部サービス会社とのご契約が必要」[公式]。契約料・基本料は無料、従量なしと銀行ページに記載。開発者ポータルあり | 検索要約には EPPS 登録が必要な場合あり・申込から 3〜4 か月とあるが、ページ原文では確認できず [未確認] |
| 三井住友銀行 | 可。Web21「API 連携/サーバー接続サービス」は自社システムが自社口座へ直接接続（参照: 残高・入出金明細・法人/利用者情報、更新: 振込依頼・承認・給与賞与振込依頼）。第三者が業として使う場合は不可（別の「API 接続サービス」）[公式] | Web21 エキスパートタイプの契約が必要、審査あり、料金は非公開（問い合わせ 0120-286-202） |

### 4.2 GMO あおぞらネット銀行の詳細 [公式・原文]

- 契約: 申込フォームまたは open-api@gmo-aozora.com → ヒアリングシート → 接続審査 → API 利用契約書・API 利用申込書 → 開発環境で接続テスト → 本番環境情報。契約までは目安 2 か月以内（private access の申込の 25% は 1 週間で契約）。接続基準を満たした法人口座保有者に限定され、口座開設自体も審査で断られる場合がある。
- 費用: スタンダード API（無償）28 種、オプション API（有償）7 種（本人確認情報照会、振込入金口座の入金限度額設定、振込事前設定口座の一覧/操作、即時振替 3 種）。有償 API の価格は非公開。2026-05-01 時点の一覧。
- 無償 28 種の内訳: 口座（口座一覧・残高・入出金明細・振込入金明細・Visa デビット取引明細）、振込/振替（状況・結果照会、手数料事前照会、振込依頼、取消、つかいわけ口座間振替）、総合振込 5 種、振込入金口座（バーチャル口座）6 種（一覧・入金明細・発行・状態変更・追加名義設定・解約申込）、デビット 2 種、イベント通知（Webhook）4 種（配信制御・配信状況・振込入金口座 入金明細通知・未送信明細取得）。
- 技術: REST/JSON、TLS 1.2 以上、OAuth2.0 + OpenID Connect。本番 `https://api.gmo-aozora.com/ganb/api/corporation/v1`、開発 `stg-api.gmo-aozora.com`。リクエスト制限は client_id 単位で値は接続通知書に記載（非公開）、超過時は HTTP 429（`WG_ERR_154`）。仕様書は 1.21.0（2026-09-14 版）。
- 入出金明細照会 `GET /accounts/transactions`（`x-access-token`）: クエリ `accountId`（円普通預金のみ）, `dateFrom`, `dateTo`, `nextItemKey`。応答 `hasNext`, `nextItemKey`, `count`, `transactions[]`（`transactionDate`, `valueDate`, `transactionType` 1=入金/2=出金, `amount`, `remarks`(255 文字まで), `balance`, `itemKey`(μs タイムスタンプ), `transferRequestInfo`{`applyNo`, `acceptNo`, `transferRequestKey`}）。
- 全銀フォーマット入出金明細照会 `GET /accounts/transactions/zengin-format`（1.21.0 で一般提供）: 口座情報（銀行コード 0310 等）、取引前後残高、入出金件数/合計、明細（勘定日は和暦 YYMMDD、取引区分 10/11/14/18、振込依頼人名カナ、仕向銀行/支店カナ、EDI 情報）。
- sunabar（API 実験場）: GMO あおぞらの口座保有者（個人・個人事業主・法人）は審査なしで利用。ID/パスワードはサービスサイトの「お客様情報（申込・設定）」の「開発者向け」タブ。残高 0 円から開始しシミュレータで入金。Webhook は未提供、アクセストークンは 30 日ログインしないと失効。本番は法人のみ [公式]。
- バーチャル口座（振込入金口座）: 導入費用・月額利用料は無料と同行 LP に記載（上限口座数の記載は古いページ由来で [未確認]）。発行 API と入金明細通知でリアルタイム消込が可能。

### 4.3 電子決済等代行業（EPPS）とアグリゲーション

- 銀行法上の電子決済等代行業は「預金者の委託を受けて」為替取引の指図伝達や口座情報の取得・提供を行う営業（解説サイトの条文抜粋では第 2 条第 21 項。銀行側文書には改正前の第 17 項表記も残る）[二次]。自社口座を自社が参照する private access は EPPS の枠組みと分けて案内されている（GMO・SMBC）が、法解釈の一次資料（銀行法・金融庁の監督指針）は未取得 [未確認]。
- 他社の口座を預かって取得・提供する機能（顧客の銀行口座を取り込む SaaS 化）を将来作る場合は、自社が EPPS 登録するか、登録済み事業者の API を使う設計が必要になる見込み [推定]。
- Moneytree LINK: アカウントアグリゲーション型の金融データ API。「LINK API Private」は複数口座を自社システムに連携する用途。導入 130 社超（2026-03 時点）、料金は非公開で問い合わせ [公式]。EPPS の表示ページがある（登録番号は未取得）。
- freee・MF は各社が銀行と個別契約して自社サービス内で取得する方式。外部向けの汎用アグリゲーション API としての提供有無は未調査 [未確認]。

### 4.4 入出金明細 CSV の列レイアウト

| 銀行 | 根拠 | 列・仕様 |
|---|---|---|
| GMO あおぞら（法人） | [原文] 法人口座ご利用ガイド 第 6 章 | 出力は「全銀固定長」「全銀 CSV」「当社 CSV」（PDF も可。ネットバンキングの入出金明細画面の印刷マーク、または「ファイル出力」から期間指定）。全銀 CSV はヘッダ(1)・データ(2)・トレーラ(8)・エンド(9)。データレコード: データ区分, 照会番号, 勘定日(YYMMDD・和暦), 起算日, 入払区分(1入金/2出金), 取引区分(10現金/11振込/14振替/18その他/19訂正), 取引金額, うち他店券金額, （交換呈示日〜僚店番号は未使用）, 振込依頼人コード, 振込依頼人名または契約者番号, 仕向銀行名, 仕向店名, 摘要内容, EDI情報, ダミー。ヘッダに口座番号・口座名(カナ)・取引前残高、トレーラに入出金件数/合計・取引後残高。「当社 CSV」の項目定義はこの章に無い [未確認] |
| ドコモSMTBネット銀行（旧住信SBI） | [二次] OSS（blnx）のパーサ実装 | `日付, 内容, 出金金額(円), 入金金額(円), 残高(円), メモ`。日付は `YYYY/MM/DD`。cp932 を先に試す実装。外貨口座は列名の単位が (USD)。銀行公式の列定義は未取得。公式の古い案内では 1 回 999 件まで（2013 年）、2021 年から CSV に加え PDF も可 |
| 楽天銀行 | [二次] OSS（blnx）のサンプル/パーサ | `取引日, 入出金(円), 取引後残高(円), 入出金内容`。取引日は `YYYYMMDD`、入出金は符号付き（出金は負）。utf-8/cp932/euc-jp/sjis を順に試す実装。公式案内では口座開設日〜前日までダウンロード可（2021 年） |
| PayPay銀行 | [公式] 法人向け「振込専用口座 利用方法」ページ（文字化けあり、要再確認） | 操作日(年)・(月)・(日)、操作時刻(時)・(分)・(秒)、取引順番号、お支払金額（出金）、お預り金額（入金）、摘要、残高。通常の普通預金明細 CSV と同一かは [未確認]。取引明細は過去 5 年保存 |
| ゆうちょ（Biz ダイレクト） | [原文] 操作説明書 18.4 | 取引日, 入出金区分(「受入」/「払出」), 取引内容, 送金人名等, 受入明細番号, 取扱口数, 取引金額, 現在(貸付)高, EDI 情報等。CSV は取引日の降順。1 CSV 最大 30,000 件。照会範囲: 通常口座は最大 23 か月（2021-04-01 以降）、振替口座は 14 か月前の 1 日から |
| ゆうちょダイレクト（個人向け） | [公式] FAQ | 1 回最大 30,000 件。総合口座 2 か月・振替口座 15 か月・ダイレクト+ 20 年。3,000 件ごとに分割、最大 10 ファイル。列名は [未確認] |

### 未確認（項目 4）

- 住信SBI・楽天・PayPay・GMO「当社 CSV」の公式な列定義（銀行が仕様として公開しているか不明。実ファイルで確定する）。
- みずほ・三菱UFJの自社システム直結可否、PayPay の費用ラベルと EPPS 要件、三井住友 Web21 の料金。
- 自社口座アクセスが電子決済等代行業に当たらないことの法的一次資料。

### 設計への示唆（項目 4）

- 第 1 候補は GMO あおぞら（private access）。契約まで最大 2 か月かかるので、口座開設と接続審査の申込を早め、sunabar で並行開発する。sunabar には Webhook が無いので、本番の通知は別途検証する。
- GMO 以外は CSV 取込みを前提に、銀行別アダプタ（ヘッダ自動判別、cp932/UTF-8/BOM、符号付き金額か入出金別列か、日付形式、和暦）を作り、実ファイルを固定フィクスチャとして保存する。
- 内部モデルは `bank_transaction`（口座、計上日、起算日、符号付き金額、取引後残高、相手名、摘要、元 ID または行ハッシュ、生データ）に統一し、取引後残高の連続性チェックで取りこぼしを検知する。GMO は `itemKey` を冪等キーにする。
- 複数口座の将来拡張（顧客の口座を扱う SaaS 化）は EPPS の論点が出るため、今は自社口座のみに限定して設計する。

---

## 5. クレジットカード（法人カード明細と API）

### 5.1 明細ファイル

| カード | 取得できる形式 | 列・備考 |
|---|---|---|
| JCB（MyJCB） | 確定分は最長 15 か月分を PDF・CSV・OFX。未確定分は毎月 24 日前後の支払金額確定日以降 [公式] | 法人カード（JCB Biz）への適用と CSV 列名は [未確認] |
| 三井住友カード（Vpass、法人は WEB 明細） | 当月分は PDF・CSV・Microsoft Money 形式、過去分は PDF のみ [公式（検索結果）] | WEB 明細画面の「CSV 形式で保存する」から取得。CSV 列名は非公開で [未確認]（実ファイルで確定） |
| 楽天カード（e-NAVI） | CSV | OSS サンプルの列: 利用日, 利用店名・商品名, 利用者, 支払方法, 利用金額, 手数料/利息, 支払総額, ◯月支払金額, ◯月繰越残高, 新規サイン [二次]。楽天ビジネスカードで同一かは [未確認] |
| AMEX | ご利用履歴を CSV・Excel・QIF（PC は直近 24 か月）。確定後の明細書は PDF [公式（検索結果）] | 公式 FAQ で確認できる項目はご利用日・金額・店舗/会社名/場所・業種。CSV の列名は [未確認] |
| オリコ | [未確認] | |
| UPSIDER | 管理画面から CSV（レビュー記事）[二次] | freee・MF・MoneyLook BIZ と API 連携（パートナー経由）。公開の開発者 API は見当たらない |
| paild | [未確認] | MF クラウド会計と API 連携（2021-05）[二次]。公開の開発者 API は見当たらない |

### 5.2 API

- 公開の開発者 API を持つ法人カード: 今回の調査では確認できず [未確認]。UPSIDER・paild はいずれも会計ソフト/明細取得サービスとのパートナー連携のみ確認。
- Stripe Issuing の日本提供は確認できず [未確認]（BT 側に `issuing_*` の type と `balance_type`=issuing/corporate_card が存在することだけ確認）。
- 自社システムから複数カードを API で取りたい場合は、Moneytree LINK API Private（4.3）が現実的な選択肢。

### 設計への示唆（項目 5）

- 経理上は「利用日に未払金計上、引落日に預金と相殺」。取込み項目は利用日・確定（支払）月・店名・金額・支払区分・カード識別子。
- OFX（JCB）・QIF（AMEX）が使えるカードは構造化形式を優先し、他は CSV アダプタ + 固定フィクスチャ + ヘッダ自動判別（cp932/UTF-8、BOM、「◯月支払金額」のような可変ヘッダ）で対応する。
- カード会社は明細の一意 ID を出さないことが多い。重複排除は (利用日, 金額, 店名, 同日内連番) とファイルハッシュの併用にする。
- 実運用前に 3 か月分以上の実ファイルを収集して列変更の有無を確認し、列が変わったら取込みを止めて検知する。

---

## 6. 領収書 OCR と国税庁 適格請求書発行事業者公表システム Web-API

### 6.1 OCR / 構造化の選択肢

| 選択肢 | 日本語 | 出力 | 料金・制約 |
|---|---|---|---|
| Google Document AI Expense Parser | あり（`ja`。他は de/en/es/fr/nl）。GA [公式] | expense date, supplier name, total amount, currency などの汎用経費項目 | リージョンは asia-southeast1, australia-southeast1, eu, northamerica-northeast1, us（東京なし）。同期処理は 10 ページまで。料金は検索結果で「Expense parser: $0.10 / 10 ページ」と読めたが、旧ページは「$0.10 / count」の記載もあり [要確認]。Invoice Parser は日本語非対応 |
| Azure AI Document Intelligence（prebuilt-receipt） | あり。感熱レシートは `ja`、ホテルレシートは `ja-JP`。v4.0（2024-11-30）GA [公式] | MerchantName, MerchantPhoneNumber, TransactionDate, TransactionTime, Total, TotalTax, Items。v4.0 で ReceiptType, TaxDetails（NetAmount, Description, Rate）, CountryRegion が追加 | Japan East/West リージョンあり。無料枠 500 ページ/月。従量の公式価格ページは数値が動的表示で取得できず、第三者情報で約 $10/1,000 ページ [要確認]。prebuilt-invoice も `ja`/JPY 対応 |
| LLM vision（Claude） | 日本語レシートの読取り精度は未検証 [未確認]。画像理解・PDF 入力に対応し、構造化出力は GA（`output_config.format` の JSON Schema、制約付きデコード）[公式] | 任意スキーマ（T 番号、税率別内訳、支払方法、宛名、但し書き） | 画像トークン = ⌈幅/28⌉×⌈高/28⌉（1000×1000 で 1,296、上限 4,784）。画像 1 枚 10MB(base64) 以下、PDF は 600 ページ・32MB まで。例: $1/百万トークンのモデルで 1000×1000 画像 1,000 枚が約 $1.30（公式の試算）。JSON Schema の `minimum`/`maxLength` 等は非対応。画像は保存されず学習に使われない（FAQ）。低品質・回転・200px 未満の画像で誤読の可能性 |
| LLM vision（Gemini） | 日本語レシートの読取り精度は未検証 [未確認]（公式の日本語対応表は未取得） | JSON スキーマ指定の構造化出力（構造化出力ガイドは未取得）| PDF は 50MB/1,000 ページ、1 ページ 258 トークン、Files API は 48 時間保存 [公式]。価格はモデルごとに変動（検索結果では 2.5 Flash が入力 $0.30/百万トークン・出力 $2.50/百万トークンで、新規には後継モデル推奨との表記）[二次] |

- 1 枚あたりのコスト感: LLM は 1 枚 1,000〜2,000 入力トークン + 数百出力トークンで、1 枚 1 円未満〜数円。Document AI は 1 ページ約 $0.01（要確認）。

### 6.2 精度の論点（実装で潰すもの）

- 数字の読み違い（3/8、1/7、感熱の退色）と、税込/税抜・小計/合計の取り違え。
- 税率別内訳（8%/10%）と軽減税率マーク、端数処理の再現。
- T 番号（"T" + 13 桁）の読取りと、書類種別（レシート/領収書/請求書）の判別。
- 手書き、斜め、折り目、複数ページ、裏面、和暦・日付の曖昧さ。
- 同一レシートの二重取込み（画像ハッシュと「日付・金額・店名」の近似一致）。
- 対策: スキーマ制約 + 値域チェック + 合計突合（Σ品目 = 合計、税率別税額の合計）+ T 番号の検証（6.3）+ 低信頼は人手確認。評価は実レシート 100〜200 枚のゴールドセットでフィールド別正解率を測る。原本画像・抽出 JSON・モデル/プロンプト版を保存する。
- 電子帳簿保存法のスキャナ保存: 解像度 200dpi 以上、カラー（一般書類はグレースケール可）、取引年月日・金額・取引先での検索と範囲指定・組合せ検索、訂正削除の履歴（またはタイムスタンプ）[二次: 国税庁「電子帳簿保存法一問一答【スキャナ保存関係】」令和 6 年 6 月の検索結果要約。実装前に原文を確認]。

### 6.3 適格請求書発行事業者公表システム Web-API [原文・公式]

- 機能: `num`（登録番号指定）/ `diff`（取得期間指定の差分）/ `valid`（登録番号 + 日付指定: 指定日を基準日に直近の登録・取消・失効に紐づく情報）。
- 形式: `type` = 01 CSV / 11 XML / 21 JSON（文字コードは Unicode、JIS 第一〜第四水準）。
- エンドポイント（バージョンは `1`）:
  - `https://web-api.invoice-kohyo.nta.go.jp/1/num?id=<アプリケーションID>&number=T…,T…&type=21&history=0|1`（番号は最大 10 件）
  - `https://web-api.invoice-kohyo.nta.go.jp/1/diff?id=…&from=YYYY-MM-DD&to=YYYY-MM-DD&type=…&division=1|2&divide=N`（期間は最大 50 日、1 応答 500 件で分割し `divide` で続きを取得、`division` は 1=個人・2=法人）
  - `https://web-api.invoice-kohyo.nta.go.jp/1/valid?id=…&number=…&day=YYYY-MM-DD&type=…`（番号は最大 10 件）
- 応答ヘッダ: 最終更新年月日, 総件数, 分割番号, 分割数。
- 取得項目（リソース定義書 1.4 版の Web-API 提供項目、CSV のサンプル順）: 一連番号, 登録番号, 事業者処理区分, 訂正区分, 人格区分（1 個人/2 法人）, 国内外区分, 最新履歴, 登録年月日, 更新年月日, 取消年月日, 失効年月日, 本店又は主たる事務所の所在地（法人）と都道府県コード・市区町村コード, 所在地（公表申出）と各コード, 氏名又は名称, 国内において行う資産の譲渡等に係る事務所等の所在地と各コード, 主たる屋号, 通称・旧姓。カナ項目の有無と個人事業者の氏名の公表範囲は仕様書で要確認。
- アプリケーション ID: 13 桁、発行無料。インボイス用 ID はメールで仮登録 → 基本情報と「公表情報の取得・利用方法」の資料を添えて本登録 → 国税庁が審査（所要期間の記載なし）。法人番号用 ID は別（約 1 か月）。ID の譲渡・貸与・開示は禁止。
- テスト環境: `https://kensyo.invoice-kohyo.nta.go.jp/<version>/...`（架空データ。インボイス用 ID が必要）。
- 利用上の制約（利用規約）: 数値のレート制限は公表なし。利用が著しく集中した場合の制限（8 条 3 項）と短時間の大量アクセス禁止（9 条 1 項 3 号）。サービスとして公開する場合は「このサービスは、適格請求書発行事業者公表システムWeb-API機能を利用して取得した情報をもとに作成しているが、サービスの内容は国税庁によって保証されたものではない」の表示が必要。取得情報は個人情報保護法等に基づき管理し、漏えい等を防ぐ措置を取る（4 条の 2、12 条）。キャッシュ・自社 DB への保存の可否は規約に明記がなく、別の「公表サイト利用規約」の確認が必要 [未確認]。
- 一括ダウンロード: 全件データ（毎月 1 日〔休日除く〕に前月末時点で作成、翌日 6:00 以降公開）と差分データ（日次、過去 40 日分）。CSV/XML/JSON の zip + OpenPGP 署名ファイル。一部の氏名項目は値を削除して提供。ID の要否は記載なし。ローカルミラーの材料にできる。
- 登録番号の構成: 法人は「T + 法人番号 13 桁」、個人事業者などは「T + 法人番号と重複しない別の 13 桁」（マイナンバーは不使用）[二次: 国税庁基本通達 1-7-2 の検索結果要約]。
- 法人番号のチェックデジット [原文: 国税庁「法人番号 チェックデジットの計算」]: 13 桁の先頭 1 桁が検査用数字。下 12 桁について、最下位から数えて偶数桁の和 × 2 + 奇数桁の和 を 9 で割った余りを 9 から引いた値。検算: ストライプジャパン株式会社 `8010601046367` は検査用数字 8 で一致した。

### 6.4 参考: インボイスの判定に効く最近の税制変更 [公式: 国税庁 令和 8 年度税制改正特集]

- 免税事業者等からの課税仕入れの控除可能割合: 令和 8 年 10 月から 2 年間 70%、令和 10 年 10 月から 2 年間 50%、令和 12 年 10 月から 1 年間 30%、令和 13 年 10 月以降 0%。
- 2 割特例は令和 8 年 9 月 30 日が属する課税期間まで。免税事業者等からの仕入れは年（事業年度）1 億円超の部分が控除できない（令和 8 年 10 月 1 日以後開始の課税期間から）。

### 未確認（項目 6）

- Document AI の料金単位（10 ページあたりか 1 件あたりか）、Azure の円建て公式価格。
- 自社 DB への保存を含む公表データの再利用条件、アプリケーション ID の審査期間。
- 実レシートでの各方式の精度（ベンチマークは取得していない）。

### 設計への示唆（項目 6）

- 抽出器は provider 抽象にして、第一候補を LLM vision + JSON Schema 強制にする。これは精度比較の結果ではなく、スキーマの柔軟性（T 番号・税率別内訳・但し書き）に基づく仮説。Document AI/Azure と同じゴールドセットで比較して確定し、必要なら合計・日付・店名だけの二重チェックに使う。なお本調査の担当は Claude 系モデルのため、Claude に関する記述は公式 docs のみに依拠し、優劣の主張はしていない。
- 抽出後の検証層を必須にする: 税率別の合計突合、T 番号の形式 + 法人番号チェックデジット、国税庁照合、日付・金額の妥当性、重複検知。通らないものは人手確認キューへ。
- T 番号照合は、ローカル検証 → 全件+差分のミラー（利用可否を要確認）または `valid`（取引日基準で判定）の順。結果は取引日時点の登録状況として保存し、未登録事業者は仕入税額控除の経過措置区分（令和 8 年 10 月から 70%）に回す。
- Web-API の ID は審査があるので早めに仮登録する。10 件バッチ・キャッシュ・低頻度で利用し、公開サービスにする場合は規約の表示文言を入れる。
- 原本画像の保管と電帳法の検索要件・訂正削除履歴を最初のデータモデルに入れる。

---

## 7. 国税庁 e-Tax 向け（財務諸表 CSV・勘定科目内訳明細書 CSV・XBRL）

### 7.1 提出形式と仕様の在り処

- CSV で提出できる対象: 別表の明細書のうち内訳の記載を要する部分、勘定科目内訳明細書、財務諸表 [公式: e-Tax Q&A]。財務諸表は XBRL か CSV、勘定科目内訳明細書は XML か CSV の選択制 [二次: 国税庁パンフレットの検索結果要約]。CSV は e-Tax ソフトに組み込むと XML(XBRL) に変換される [公式]。
- 提出方法は e-Tax ソフトへの組込み送信または光ディスク等への保存提出。自作ソフトから直接送信する公開 API は確認できず [公式・未確認]。

| 対象 | 在り処（URL） | 内容 |
|---|---|---|
| 財務諸表 CSV（HOT010 Ver.3.0） | `https://www.e-tax.nta.go.jp/hojin/gimuka/csv_jyoho4.htm`、レコード内容 `.../csv_jyoho4_5_1.pdf` | 5 列 CSV の規則、勘定科目コード表（BS/PL/その他の HTML）、コード検索用 Excel、標準フォーム（Excel）。旧 Ver.2.0 は `.../csvconv_yoryo_HOT010_ver.2.0.pdf` |
| 勘定科目内訳明細書 CSV（HOI010 等） | `https://www.e-tax.nta.go.jp/hojin/gimuka/csv_jyoho2.htm` | 標準フォーム（令和 6 年 3 月 1 日以後終了事業年度分 / 令和 5 年 4 月 1 日前終了事業年度分で版が分かれる）、様式ごとのレコード仕様 PDF（例 `.../csv_jyoho1/2/HOI010.pdf`）[二次: 検索結果] |
| XML 構造設計書・帳票フィールド仕様書 | `https://www.e-tax.nta.go.jp/shiyo/shiyo3.htm` | 【法人税関係】令和 8 年 5 月 1 日更新（約 30.1MB、CAB）、【消費税関係】令和 6 年 10 月 31 日更新、税務用財務諸表タクソノミー（令和 2 年 10 月 22 日、XBRL 用）、手続一覧、全仕様一括（約 118MB）|
| CSV ファイルチェックコーナー | `https://www.e-tax.nta.go.jp/csvcheck/csvcheck.htm` | 財務諸表・勘定科目内訳明細書・法人税申告書別表等（明細記載を要する部分）・法定調書の CSV を Web 上で検査。法人事業概況説明書と申告書本体は対象外と読める |

### 7.2 HOT010 Ver.3.0 の構造 [原文]

- 5 列固定: 種別又は勘定科目 / 内容又は金額等 / 行区分 / 階層番号 / 勘定科目コード。
- 1〜4 行目: `A`（財務諸表種別: BS 貸借対照表、PL 損益計算書、SC 製造原価報告書、NT 個別注記表、SS 株主資本等変動計算書、SE 社員資本等変動計算書、SR 損益金の処分表）、`B`（法人名、全角 50 文字以内）、`C1`/`C2`（事業年度の自/至、`YYYY-MM-DD`）。5 行目に財務諸表名、6 行目以降が勘定科目。2 種類以上を 1 つの CSV にまとめる書式もある。
- 金額は半角 16 文字以内（マイナス含む）でカンマなし。行区分は 1=金額型、2=金額型以外、T=タイトル項目（コード表の「タイトル項目」）。階層番号は 2 以上の整数。勘定科目コードは e-Tax のコード表（例 `10A100020` 現金及び預金）から付与する。
- 文字は Shift-JIS で JIS 第 1・第 2 水準のみ（半角カナ・旧字体は不可、全角へ変換）。ファイル名は既定で `様式ID_バージョン_財務諸表名.csv`（例 `HOT010_3.0_BS.csv`）、拡張子込みで 125 文字以内。複数ファイルを一緒に提出する場合は法人名と事業年度を揃える [公式]。
- 勘定科目内訳明細書 CSV は半角カンマ区切り・Shift-JIS・金額にカンマ不可、ファイル名は `様式ID_バージョン.csv`（例 `HOI010_4.0.csv`）、同じ書式で CSV と XML を混在できない [二次: 検索結果の要約]。

### 7.3 XBRL の要否と最近の変更

- 財務諸表は XBRL か CSV の選択制。CSV で出せば自前で XBRL を組む必要はない。XBRL を直接作る場合は税務用財務諸表タクソノミーが要る。申告書本体や別表は XML（XTX）で、帳票フィールド仕様書に従う。
- 国税システムは 2026-09-24 に更改される予定と案内され、e-Tax は 2026-09-19〜09-24 に利用できない時間帯が設けられる予定だった [二次: 検索結果の要約]。実施結果は今回確認していない [未確認]。仕様は「KSK2 対応版」として段階公開（令和 8 年度第 1 回 5/18 資料に更改改修を追記、第 4 回は令和 9 年 1 月下旬までの計画）。従来の仕様書は将来掲載終了予定との注記あり。テスト送信は e-Tax のお問い合わせから申込み、仕様公開の注意事項への同意が前提 [公式]。

### 7.4 生成を助ける OSS・ライブラリ

- 成熟したものは見つからなかった。
  - Arrenem/opentax: 個人事業主向けの AGPL-3.0 の会計基盤で XTX 出力を持つ Developer Preview。main の commit は 5 件、star 1 [公式 GitHub]。法人向けではない。
  - louie47690/zeicheck: e-Tax の `.xtx` を検査する TypeScript CLI（MIT）。ただしリポジトリ上の Download と Quick Link がすべて同一の zip（`tests/unit/rules/continuity/Software-pettily.zip`）を指しており不審なため、取得・実行しないこと。
  - japanese_law_xml_schema は法令 XML 用で無関係。
- CSV の生成は仕様が公開されていて単純なので自前実装が現実的。肝は勘定科目マスタと e-Tax 勘定科目コードの対応表。

### 未確認（項目 7）

- 勘定科目内訳明細書・法人事業概況説明書の CSV 仕様の最新版（様式ごとの PDF は事業年度で版が分かれる）。
- 自作ソフトから e-Tax へ直接送信する場合の開発者向け要件（テスト送信の条件）。
- KSK2 対応版での CSV 形式データの扱い（HOT010/HOI010 の改訂有無）。

### 設計への示唆（項目 7）

- MVP は 財務諸表 CSV（HOT010）と勘定科目内訳明細書 CSV の出力まで。申告書本体の XTX 直接生成は後回しにし、税理士のソフトまたは e-Tax 画面に取り込ませる。
- 勘定科目マスタに e-Tax 勘定科目コード・階層番号・行区分を持たせ、公式のコード表（HTML/Excel）から版管理付きで取り込む。
- 出力時に Shift-JIS/JIS 第 1・第 2 水準、全角変換、カンマ除去、ファイル名規約を検証し、公式の CSV ファイルチェックコーナーを手動 QA に使う。
- KSK2 の公開が続くため、参照した仕様の URL・更新日・版を記録し、四半期ごとに差分確認する。

---

## 8. 給与・社会保険の計算（機械可読データと OSS）

### 8.1 源泉徴収税額表（令和 8 年分）[公式]

- 国税庁 `https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2026/01.htm` に PDF と Excel（.xls）がある。CSV は確認できず。
  - 月額表（1〜7 頁）`data/01-07.pdf` / `data/01-07.xls`、日額表（8〜14 頁）`data/08-14.xls`、賞与に対する算出率の表 `data/15-16.xls`、電子計算機等を使用して源泉徴収税額を計算する方法（18 頁）`data/18.pdf`、求め方 `data/19-22.pdf`、一括 `data/all.pdf`（ベースは `/publication/pamph/gensen/zeigakuhyo2026/`）。
- 令和 8 年 1 月から変更あり（令和 7 年度税制改正で基礎控除が見直されたため算出方法が変更）。令和 7 年分以前の給与には使わない旨の注意書き。扶養親族等の数え方の変更（19 歳以上 23 歳未満の一定の親族が含まれる）は第三者解説による [二次]。
- 電算機計算の特例の算式は 18 頁 PDF にある。令和 8 年分の個別文書は検索では令和 9 年分しか見つからず、詳細は [未確認]。

### 8.2 社会保険料（令和 8 年度）

| 項目 | 値 | 出典 |
|---|---|---|
| 健康保険料率（協会けんぽ） | 神奈川 9.92%（令和 7 年度と同率で、表の適用開始は令和 7 年 3 月分〜）、東京 9.85%（前年 9.91%、令和 8 年 3 月分〜）| [原文] 協会けんぽ神奈川の令和 8 年 10 月分表 + [公式] 料率ページ |
| 介護保険料率 | 1.62%（全国一律、40〜64 歳のみ）。令和 8 年 3 月分〜 | 同上 |
| 子ども・子育て支援金率 | 0.23%（全国一律）。令和 8 年 4 月分（5 月納付分）〜 | 同上 |
| 厚生年金保険料率 | 18.300%（平成 29 年 9 月分〜） | [原文] 協会けんぽ表 |
| 子ども・子育て拠出金率 | 令和 2 年 4 月分〜適用（率の値は今回取得せず） | [原文] 表の注記のみ |
| 雇用保険料率 | 令和 8 年度（2026-04-01〜2027-03-31）一般の事業: 労働者負担 5/1000、事業主負担 8.5/1000、計 13.5/1000（失業等給付等 5/1000 を労使折半、雇用保険二事業 3.5/1000 は事業主のみ）。農林水産・清酒製造は 6/9.5（計 15.5）、建設は 6/10.5（計 16.5）。令和 7 年度の一般は 5.5/9/14.5 | [原文] 厚労省リーフレット |
| 労災保険料率 | 事業の種類別・事業主全額負担。率表は今回未確認 | [未確認] |

- 保険料額表: 協会けんぽは都道府県別の PDF（例 `https://www.kyoukaikenpo.or.jp/assets/R8_14kanagawa.pdf`）。令和 8 年 10 月分からは「保険料調整制度」適用の別表（`R8.10_14神奈川.pdf`）もあり、被保険者負担と保険料調整額の列が加わる。協会けんぽ側の Excel 提供は [未確認]。日本年金機構の厚生年金保険料額表は PDF と Excel（`R08ryougaku.pdf` / `R08ryougaku.xlsx`）で、CSV はない [公式]。
- 表の列（協会けんぽ表）: 等級（厚生年金の等級は括弧内）、標準報酬月額、報酬月額の範囲、健康保険料（全額/被保険者負担/保険料調整額）、介護保険料（40〜64 歳のみ）、子ども・子育て支援金、厚生年金保険料。
- 保険料調整制度（令和 8 年 10 月〜）: 新たに加入対象となる短時間労働者の保険料負担を事業主が一時的に一部負担して軽減する制度。事業主が追加で負担した分は 3 か月後に還付され、最終的な事業主の納付額は増えない [原文]。

### 8.3 API・OSS

- 給与・社会保険を計算する公的な API は確認できず [未確認]。
- OSS は学習用・個人用が中心で、成熟した計算ライブラリは見つからなかった。`slcwr/payroll-lab`（Ruby バックエンド + TypeScript。README に学習用で実務には使わないとの記載）、`Nowcha/payroll-management`（個人用。税計算エンジンを純関数で実装）など。協会けんぽ料率や源泉徴収税額表をデータとして配布する npm パッケージは見つからなかった [二次]。
- 第三者の計算ツール（gyomu-keisan.jp など）は検算用に留める。freee 人事労務・MF 給与などの外部 API は未調査 [未確認]。

### 設計への示唆（項目 8）

- 料率・税額表は「年度 × 適用開始月 × 都道府県（× 制度区分）」でバージョン管理するデータにし、コードに埋め込まない。原本ファイルのハッシュと出典 URL を保存する。
- 取込みスクリプトは国税庁 .xls と日本年金機構 .xlsx を優先し、協会けんぽの PDF は表抽出 + 目視検証にする。電算機特例の算式と税額表の突合テストで計算を担保する。
- 令和 8 年は改正が重なる（基礎控除等、子ども・子育て支援金、保険料調整制度、雇用保険料率）。年度切替・月途中改定のテストを最初に書く。
- 標準報酬月額の決定（定時決定・随時改定）、住民税の特別徴収、年末調整は別機能として切り出す。優先度が低ければ MVP は外部の給与計算サービスの出力を取り込む案も検討する。

---

## 出典 URL 一覧

### 1 Stripe（帳簿連携）
- https://docs.stripe.com/api/balance_transactions/object
- https://docs.stripe.com/api/balance_transactions/list
- https://docs.stripe.com/reports/balance-transaction-types
- https://docs.stripe.com/reports/reporting-categories
- https://docs.stripe.com/reports/report-types （Reports API の仕組み）
- https://docs.stripe.com/reports/report-types/balance
- https://docs.stripe.com/reports/payout-reconciliation
- https://docs.stripe.com/reports/report-types/connect
- https://docs.stripe.com/reports/v2-api
- https://docs.stripe.com/payouts
- https://docs.stripe.com/payouts/reconciliation
- https://docs.stripe.com/payments/balances
- https://docs.stripe.com/api/events/types
- https://docs.stripe.com/webhooks
- https://docs.stripe.com/rate-limits
- https://stripe.com/jp/pricing
- https://stripe.com/jp/sigma/pricing
- https://stripe.com/jp/data-pipeline/pricing
- https://support.stripe.com/questions/taxes-on-stripe-fees-for-businesses-in-japan?locale=ja-JP
- https://support.stripe.com/questions/understanding-our-qualified-tax-invoice-on-stripe-fees
- https://support.stripe.com/questions/how-to-reconcile-your-qualified-tax-invoice-in-japan
- https://www.invoice-kohyo.nta.go.jp/regno-search/detail?selRegNo=8010601046367 （ストライプジャパン株式会社の登録確認）
- https://docs.stripe.com/tax/supported-countries/asia-pacific/japan
- freee の Stripe 取込みヘルプ（本文は 403 で取得不可、検索結果の要約のみ）: https://support.freee.co.jp/hc/ja/articles/360001102243
- マネーフォワードの Stripe 連携ページ: 該当ページを見つけられず [未確認]

### 2 Stripe（複数アカウント・法人化）
- https://docs.stripe.com/get-started/account/multiple-accounts
- https://support.stripe.com/questions/can-i-create-and-manage-multiple-stripe-accounts?locale=ja-JP
- https://docs.stripe.com/get-started/account/orgs
- https://docs.stripe.com/get-started/account/orgs/build
- https://docs.stripe.com/get-started/account/orgs/setup
- https://docs.stripe.com/reports/multiple-accounts
- https://docs.stripe.com/data/sigma-organizations
- https://docs.stripe.com/keys/organization-api-keys
- https://docs.stripe.com/connect/authentication
- https://docs.stripe.com/connect/standard-accounts
- https://docs.stripe.com/connect/update-verified-information
- https://docs.stripe.com/api/accounts/update
- https://support.stripe.com/express/questions/how-do-i-update-my-tax-information （日本・ブラジルの例外の記載）
- https://support.stripe.com/questions/company-beneficial-ownership-and-director-requirement?locale=ja-JP
- https://support.stripe.com/questions/company-ownership-change
- https://support.stripe.com/questions/legal-entity-sharing
- https://docs.stripe.com/get-started/data-migrations/pan-copy-self-serve （検索結果のみ、本文未取得）
- リポジトリ内: `specs/initiatives/connect-direct-2026-foundation.md`

### 3 Stripe Invoicing（日本）
- https://stripe.com/jp/guides/best-practices-for-setting-up-invoicies-in-japan
- https://docs.stripe.com/invoicing/customize
- https://docs.stripe.com/invoicing/integration/workflow-transitions
- https://docs.stripe.com/invoicing/bank-transfer
- https://docs.stripe.com/payments/bank-transfers
- https://docs.stripe.com/payments/konbini
- https://docs.stripe.com/quotes
- https://docs.stripe.com/billing/customer/tax-ids
- https://stripe.com/jp/invoicing/pricing
- https://stripe.com/jp/billing/pricing
- https://stripe.com/jp/pricing/local-payment-methods
- freee 請求書のプラン（検索結果の要約）: https://www.freee.co.jp/invoice/pricing/

### 4 銀行 API と CSV
- GMO あおぞら: https://gmo-aozora.com/business/api-cooperation/provisionpolicy.html
- https://gmo-aozora.com/business/api-cooperation/apilineup.html
- https://gmo-aozora.com/business/api-cooperation/api-application.html
- https://gmo-aozora.com/business/api-cooperation/pdf/api-spec-corporate.pdf （オープン API 仕様書 法人口座編 1.21.0、原文を `pdftotext` で確認）
- https://gmo-aozora.com/sunabar/tutorial/01.html
- https://gmo-aozora.com/support/guide/business-account.pdf （法人口座ご利用ガイド、第 6 章 入出金明細ファイルフォーマット）
- https://gmo-aozora.com/promotion/lp/virtual-accounts/
- https://api.gmo-aozora.com/ganb/developer/api-docs/ （検索結果のみ）
- ドコモSMTBネット銀行（旧 住信SBIネット銀行）: https://www.netbk.co.jp/contents/company/sitepolicy/api-policy/ ・ https://www.netbk.co.jp/contents/hojin/settlement/
- 楽天銀行: https://www.rakuten-bank.co.jp/rules/api-service.html
- PayPay銀行: https://www.paypay-bank.co.jp/business/receive/api.html ・ https://www.paypay-bank.co.jp/business/ad/settlement.html ・ https://www.paypay-bank.co.jp/business/receive/transferonly/guide.html （いずれも文字化けあり）
- 三井住友銀行: https://www.smbc.co.jp/hojin/eb/web21/api-cooperation/
- 三菱UFJ銀行: https://www.bk.mufg.jp/houjin/mufgbiz/biz/option/api/api.html ・ https://developer.portal.bk.mufg.jp/
- みずほ銀行: https://www.faq.mizuhobank.co.jp/faq/show/11041?category_id=451&site_domain=houjin ・ https://www.mizuhobank.co.jp/release/pdf/20180214_3release_jp.pdf
- ゆうちょ銀行: https://www.jp-bank.japanpost.jp/hojin/smart/bizdirect/pdf/bizdirect_18.pdf （原文を `pdftotext` で確認）・ https://faq.jp-bank.japanpost.jp/faq_detail.html?id=59
- Moneytree LINK: https://getmoneytree.com/jp/link
- OSS（CSV 列の推定根拠）: https://github.com/mamenosuke6055/blnx （`py/importers/import_rakutenbank.py`、`py/importers/account_identity.py`、`examples/inbox/rb-sample.csv`）

### 5 クレジットカード
- https://www.jcb.co.jp/service/basic/usage/check/index.html
- https://www.smbc-card.com/mem/oshiharai/meisai_about.jsp （検索結果）
- https://www.americanexpress.com/ja-jp/support/guide/statement/ （検索結果）
- https://github.com/mamenosuke6055/blnx （`examples/inbox/enavi202601.csv`）
- UPSIDER × MoneyLook BIZ: https://ecnomikata.com/pr/40798/ （検索結果）

### 6 OCR と国税庁 Web-API
- https://docs.cloud.google.com/document-ai/docs/processors-list
- https://cloud.google.com/document-ai/pricing （本文が取得できず、検索結果の要約）
- https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/receipt
- https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/language-support/prebuilt
- https://azure.microsoft.com/en-us/pricing/details/ai-document-intelligence/ （価格は動的表示で取得不可）
- https://platform.claude.com/docs/en/build-with-claude/vision
- https://platform.claude.com/docs/en/build-with-claude/pdf-support
- https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- https://ai.google.dev/gemini-api/docs/document-processing
- https://www.invoice-kohyo.nta.go.jp/web-api/index.html
- https://www.invoice-kohyo.nta.go.jp/web-api/riyou_kiyaku.html
- https://www.invoice-kohyo.nta.go.jp/web-api/kensyou.html
- https://www.invoice-kohyo.nta.go.jp/files/k-web-api-kinou.pdf （第二編 リクエストの設定方法及び提供データの内容、原文を `pdftotext` で確認）
- https://www.invoice-kohyo.nta.go.jp/download/index.html
- https://www.houjin-bangou.nta.go.jp/documents/checkdigit.pdf （原文を `pdftotext` で確認）
- https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice-review/index.htm （令和 8 年度税制改正特集）
- https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/pdf/0024005-113_r602.pdf （電子帳簿保存法一問一答 スキャナ保存関係、検索結果のみ）

### 7 e-Tax
- https://www.e-tax.nta.go.jp/hojin/gimuka/csv_jyoho4.htm
- https://www.e-tax.nta.go.jp/hojin/gimuka/csv_jyoho4_5_1.pdf （HOT010 Ver.3.0 レコード内容、原文を `pdftotext` で確認）
- https://www.e-tax.nta.go.jp/hojin/gimuka/csv_jyoho2.htm （検索結果）
- https://www.e-tax.nta.go.jp/toiawase/qa/gimuka/23.htm
- https://www.e-tax.nta.go.jp/csvcheck/csvcheck.htm
- https://www.e-tax.nta.go.jp/shiyo/shiyo3.htm
- https://www.e-tax.nta.go.jp/shiyo/ksk2/ksk2_shiyo.htm
- https://www.e-tax.nta.go.jp/shiyo/keikaku.htm （検索結果のみ）
- OSS: https://github.com/Arrenem/opentax ・ https://github.com/louie47690/zeicheck （後者はダウンロードリンクが不審、実行しない）

### 8 給与・社会保険
- https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2026/01.htm
- https://www.kyoukaikenpo.or.jp/about/business/insurance_rate/rate_prefectures/r08
- https://www.kyoukaikenpo.or.jp/assets/R8.10_14%E7%A5%9E%E5%A5%88%E5%B7%9D.pdf （原文を `pdftotext` で確認）
- https://www.kyoukaikenpo.or.jp/assets/R8_14kanagawa.pdf （検索結果のみ）
- https://www.nenkin.go.jp/service/kounen/hokenryo/ryogaku/ryogakuhyo/20200825.html
- https://www.mhlw.go.jp/content/001692566.pdf （令和 8 年度 雇用保険料率、原文を `pdftotext` で確認）
- OSS: https://github.com/slcwr/payroll-lab ・ https://github.com/Nowcha/payroll-management （検索結果）
