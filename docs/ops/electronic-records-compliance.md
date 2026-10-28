# 電子帳簿保存法 要件対応表（規則 → 機能 → 証跡）

自社開発のシステムは JIIMA 認証の対象外なので、税務調査で示せる対応表をここに保ちます（[03 §3・§9](../design/03-compliance.md)）。対象は「電子取引データ保存」（法 7 条。義務）と「電子帳簿等保存」（法 4 条。優良の届出を出す。[D17](../design/09-decisions.md)）です。スキャナ保存は行いません（紙の原本を 7 年保管）。

- 条文の番号は 2026-10 時点の電子帳簿保存法施行規則（以下「規則」）です。令和 9 年 1 月 1 日施行の改正で一部の項番が繰り上がるので、年次の見直し（§6）で確かめます。
- 「証跡」は、このリポジトリのコード・テスト・文書か、画面の操作で示せるものです。実物の規程と実データは非公開側にあります。

## 1. システム関係書類の所在（規則 2 条 2 項 1 号）

自社開発のプログラムを使うので、概要書・仕様書・操作説明書・事務手続書類の 4 つを備え付けます。版は git の履歴で分かります。

| 書類 | 所在 |
| --- | --- |
| システム概要書（基本設計・流れ・変更履歴） | [00 概要](../design/00-overview.md)、[06 技術構成](../design/06-architecture.md)、[13 証憑](../design/13-documents.md) §1・§6、変更履歴は git と [決定記録](../decisions/README.md) |
| システム仕様書（データ定義・処理の仕様） | [01 ドメインモデル](../design/01-domain-model.md)、[02 会計処理の規則](../design/02-accounting-rules.md)、[10](../design/10-settings-and-setup.md)・[11](../design/11-transactions.md)・[13](../design/13-documents.md) の画面仕様、`packages/db/prisma/schema.prisma` と `packages/db/prisma/migrations/` |
| 操作説明書 | [証憑の操作説明書](documents-operations.md)、各画面の説明文、`apps/web/README.md` |
| 事務手続を明らかにした書類（入出力の手順・担当・訂正削除の承認） | [事務処理規程](electronic-records-policy.md)（制定したものは 設定 › 証憑の規程）、[07 運用](../design/07-operations.md) §1〜§3 |

## 2. 電子取引データ保存（法 7 条、規則 4 条）

| 要件 | 根拠 | 機能 | 証跡 |
| --- | --- | --- | --- |
| 真実性: 訂正及び削除の防止に関する事務処理規程を定め、備え付け、運用する | 規則 4 条 1 項 4 号 | 設定 › 証憑の規程 で施行日・管理責任者・処理責任者を入れて制定し、全文を表示・印刷する。制定の状態は `Company.records_policy_*` に保存し、監査ログ `records_policy.save` が残る | [規程の雛形](electronic-records-policy.md)、`apps/web/lib/documents/policy.ts`（文面の正。md との一致を単体テストで確認）、`packages/db/src/documents.ts` の `saveRecordsPolicy` |
| 真実性の裏づけ: 保存したデータは訂正・削除できない | 規程 第 5 条 2 項・第 8 条・第 9 条 | `Document` は DELETE できず、`storage_key` / `sha256` / `byte_size` / `mime` は変えられない（DB トリガー）。誤りは「無効」（理由必須・日時・ファイルと紐づけは残す）か「差し替え」（新しい行＋ `supersedesId`、元は無効）。無効は戻せない（トリガー）。すべて監査ログ（`document.void` / `document.create` / `document.link`）に残る | `packages/db/prisma/migrations/*_ledger_guards`（`ledger_document_guard`）と `*_documents`（CHECK `document_void_fields`、ガードの拡張）、`packages/db/test/guards.db.test.ts`・`documents.db.test.ts`、`voidDocument` / `replaceDocument` |
| 真実性の裏づけ: 改ざんの検知 | — | 保存時にサーバーが SHA-256 を計算して記録し、ブラウザが計算した値と照合する。同じ SHA-256 の再アップロードは既存の証憑に結ぶ。本番の GCS はオブジェクトのバージョニング ON・削除保護 | `apps/web/app/api/documents/complete/route.ts`、`registerDocument`、詳細画面の SHA-256、[06 §6](../design/06-architecture.md)、S8 のバケット設定 |
| 可視性: 見読可能装置（ディスプレイ・プリンタ）で速やかに出力できる | 規則 2 条 2 項 2 号（4 条 1 項で準用） | 詳細画面のプレビュー（画像・PDF）、「ファイルを開く」、ブラウザの印刷 | `/documents/[id]`、`/api/documents/[id]/file` |
| 可視性: 操作説明書・システム概要書の備付け | 規則 2 条 2 項 1 号（自社開発は概要書も） | §1 | §1 |
| 検索: 取引年月日・取引金額・取引先で検索できる | 規則 2 条 6 項 6 号イ（4 条 1 項で準用） | 証憑の一覧の検索（取引年月日・金額・取引先）。保存時に 3 項目を記録し、空のものは受信箱で「未整理」として見つけ、翌月末までに記録する（規程 第 10 条） | `searchDocuments`、`documents.db.test.ts`（検索）、`/documents` |
| 検索: 日付・金額の範囲指定 | 同 ロ | 取引年月日の範囲（`from` / `to`）、金額の範囲（`amountMin` / `amountMax`） | 同上 |
| 検索: 2 以上の項目の組み合わせ | 同 ハ | 条件は AND で組み合わせる | 同上 |
| ダウンロードの求めに応じる | 規則 2 条 7 項・4 条 1 項 | 索引簿 CSV（証憑 ID・取引年月日・金額・取引先・登録番号・種別・状態・無効の理由・仕訳番号・ファイル名・SHA-256 …）と、証憑一式の zip（S7 の書き出し） | `/api/documents/index.csv`（監査ログ `document.export`）、S7 #8 |
| 新設法人の第 1 期・第 2 期は検索要件が不要、以後も売上高 5,000 万円以下なら不要 | 規則 4 条 1 項ただし書 | 要件の有無にかかわらず v1 から実装し、運用もする | [03 §3.2](../design/03-compliance.md) |
| 保存期間 7 年（欠損金の期は 10 年） | 法人税法施行規則 59 条・67 条 | アプリからの削除はなく、GCS の保持ポリシー（7 年・ロックしない）、日次エクスポートと Cloud SQL のバックアップ | [06 §6](../design/06-architecture.md)、S8 #9 |
| 保存対象の網羅: メール添付・Web ダウンロードの請求書等、カード・銀行の明細データ、決済代行の請求書 | 一問一答（電子取引）問 2〜4 | 種別 `statement`（明細書）・`invoice_in`・`receipt` など。取込に使った CSV は取込の直後に明細書の証憑として保存し、`ImportBatch.documentId` で結ぶ（取引は明細の各行で、日付・金額・相手で検索できる）。Stripe の月次請求書は毎月ダウンロードして保存する（操作説明書 §6） | [13 §9](../design/13-documents.md)、[操作説明書](documents-operations.md) |
| 出力書面での保存は不可（データのまま保存） | 法 7 条 | 原本のファイル（画像・PDF・CSV）をそのまま保存し、画面は参照だけ | `DocumentStorage`（`apps/web/lib/storage/`） |

## 3. 電子帳簿等保存（法 4 条、規則 2 条・5 条。優良の届出）

| 要件 | 根拠 | 機能 | 証跡 |
| --- | --- | --- | --- |
| システム関係書類の備付け | 規則 2 条 2 項 1 号 | §1 | §1 |
| 見読可能装置 | 規則 2 条 2 項 2 号 | 取引・報告の画面、PDF・CSV の書き出し（S7） | S3 #4、S7 #8 |
| ダウンロードの求め（優良なら不要だが応じる） | 規則 2 条 2 項 3 号 | 設定 › 書き出し で仕訳・明細・設定の全データを CSV / beancount で出す（S7） | S7 #8 |
| 訂正・削除の履歴（優良） | 規則 5 条 5 項 1 号イ | 登録した仕訳は書き換えず、取消は反対仕訳（`reversalOfId`）、訂正は反対仕訳＋新仕訳（`replacedById`）。DB トリガーが `posted` 行の UPDATE / DELETE を拒否。監査ログは追記のみ | `packages/ledger` の不変条件テスト、`*_ledger_guards`、[02 §1](../design/02-accounting-rules.md)、[11 §1](../design/11-transactions.md) |
| 追加入力の履歴（優良） | 同 ロ | `createdAt` / `postedAt` と連番 `no`（欠番なし）で入力の順と日時が分かる | `JournalEntry`、`sequence.ts` |
| 帳簿間の相互関連性（優良） | 規則 5 条 5 項 2 号 | 仕訳番号 `JournalEntry.no` を仕訳帳・総勘定元帳・証憑の索引簿・請求書で共有する | S7 #8、索引簿の「仕訳番号」 |
| 検索（優良）: 日付・金額・相手方、範囲、組み合わせ | 規則 5 条 5 項 3 号 | 取引の一覧の絞り込み（期間・科目・取引先・金額）と証憑の検索 | S3 #4、本表 §2 |
| 届出 | 規則 5 条 1 項 | 法定申告期限までに「国税関係帳簿の電磁的記録等による保存等に係る過少申告加算税の特例の適用を受ける旨の届出書」を出す | [D17](../design/09-decisions.md)、[07 §4](../design/07-operations.md) の暦 |

## 4. 証憑の監査ログ

`AuditLog`（追記のみ。`actor` / `at` / `action` / `entity` / `entityId` / `before` / `after` / `reason`）に次の action で残ります。

| action | いつ | 記録 |
| --- | --- | --- |
| `document.create` | 保存（アップロード・撮影・取込・生成・差し替えの新しい行） | after: 証憑の行（SHA-256・形式・大きさ・保存者・項目） |
| `document.update` | 項目（種別・取引年月日・金額・取引先・登録番号・メモ）の変更。紐づけで空の項目を埋めたときも | before / after |
| `document.link` / `document.unlink` | 仕訳・明細・請求書への紐づけと、その解除 | after / before: 相手の要約 |
| `document.void` | 無効化（差し替えの元を含む） | reason（必須）、before / after の状態 |
| `document.export` | 索引簿の書き出し | after: 条件と件数 |
| `records_policy.save` | 規程の制定・責任者の変更 | before / after（施行日・責任者・版） |

## 5. 税務調査での提示手順

1. 設定 › 証憑の規程 で制定済みの規程を印刷して示す（非公開側の押印済みの原本でもよい）。
2. 証憑 › すべて で期間・金額・取引先を指定して検索し、「索引簿を書き出す」で CSV を渡す。
3. 個別の証憑は詳細で開き、プレビューまたは「ファイルを開く」で示す。無効・差し替えは詳細の履歴と理由で説明する。
4. 帳簿との対応は索引簿の「仕訳番号」と、取引の詳細（仕訳 → 証憑）で示す。
5. データ一式の求めには、証憑一式の zip（S7）と仕訳・明細の CSV（S7）で応じる。

## 6. 見直し

- 年 1 回（税制改正の施行後、5〜6 月の一問一答の更新後）に条文の番号と要件を確かめ、この表を直す。
- 規程の文面を変えたら `POLICY_VERSION` を上げ、設定 › 証憑の規程 で施行日を入れ直す。
- 新しい保存元（メールの自動取込・銀行 API・読み取り）を足したら §2 の「保存対象の網羅」と §4 に行を足す。
