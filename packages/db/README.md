# @niho-finance/db

Prisma schema、migration、仕訳の登録・取消（`postJournalEntry` / `voidJournalEntry`）、監査ログの追記を持つパッケージです。台帳の規則そのものは `@niho-finance/ledger` にあり、このパッケージは「1 トランザクションで検証 → 採番 → 登録 → 監査ログ」を受け持ちます。

## 設定と初期化（S2）

| ファイル | 内容 |
| --- | --- |
| `src/schemas.ts` | 書き込みの入力の Zod スキーマ（Server Action と共有）。メッセージは利用者向けの日本語 |
| `src/bootstrap.ts` | 標準データ（税区分・税率規則・セグメント・勘定科目テンプレート）の投入。冪等。seed もこれを使う |
| `src/settings.ts` | 事業所・会計期間・勘定科目・補助科目・税区分・口座・取引先・セグメント・タグの読み書き。書き込みは 1 トランザクションで監査ログつき。削除はなく無効化 |
| `src/opening.ts` | 開始仕訳の組み立て（純粋関数 `buildOpeningEntries`）・プレビュー・登録（`postOpeningEntries`。1 回だけ） |
| `src/setup.ts` | ウィザードの進捗を DB から導出（`getSetupProgress`）。保存する状態は「あとで」の 2 列だけ |

## 報告と書き出し（S7）

| ファイル | 内容 |
| --- | --- |
| `src/reports-query.ts` | 報告の入力（`loadReportSource`: 設定と全仕訳）、口座の明細の状態（`loadWalletStatus`）、ホームの「やること」（`loadHomeTodos` と `HOME_TODO_SOURCES`。S5・S6・S8 が関数を足す）、書き出しの監査ログ（`recordExport` / `listRecentExports`）、証憑の索引とバックアップの入力（`loadDocumentsForArchive` / `loadBackupSource`）。集計そのものは `@niho-finance/reports` が行う |

書き込みの関数は `(db, input, { actor })` の形で、入力を Zod で検証し、規則に反すると `SettingsError`（`message` と `field`）を投げます。

## migration

migration は 2 種類を併用します。

| 種類 | 作り方 | 中身 |
| --- | --- | --- |
| 生成 | `schema.prisma` を直して `npm run db:migrate:dev -- --name <name>`（ルートから） | テーブル・列・索引・外部キー・enum |
| 手書き | `npx prisma migrate dev --create-only --name <name>`（`packages/db` で）で空の migration を作り、SQL を書く | トリガー・関数・CHECK 制約など Prisma が表せないもの |

- 生成 migration も、適用前に確かめたいときは `--create-only` を付けて SQL を読んでから `npm run db:migrate` で適用します。
- 手書きのトリガー・関数・CHECK 制約は Prisma の差分の対象外なので、後の `migrate dev` で消されません（`prisma migrate diff --from-url ... --to-schema-datamodel prisma/schema.prisma` が空になることで確かめられます）。代わりに、トリガーが参照する列を変えるときは、トリガーを直す migration も自分で足します。
- 適用済みの migration は書き換えません。直すときは新しい migration を足します。
- 本番・CI は `prisma migrate deploy`（`npm run db:migrate`）だけを使います。`migrate dev` と `migrate reset` はローカル専用です。

### 台帳のガード（`*_ledger_guards`）

| ガード | 内容 |
| --- | --- |
| `journal_line` | UPDATE / DELETE / TRUNCATE を拒否。行は同じトランザクションで仕訳を INSERT した直後にだけ足せる（登録済みの仕訳に行を足せない） |
| `journal_entry` | DELETE / TRUNCATE を拒否。UPDATE は取消（`status` posted → voided と `voided_at`・`void_reason`）と `replaced_by_id` の 1 回だけの設定に限る。ほかの列は既定で拒否（列を足したら、変えてよい列かをここで決める） |
| `audit_log` | UPDATE / DELETE / TRUNCATE を拒否（追記のみ） |
| `document` | DELETE / TRUNCATE を拒否。`storage_key`・`sha256`・`byte_size`・`mime` は変えられない |
| 貸借一致 | 仕訳ごとに行が 2 本以上で借方合計 = 貸方合計であることを COMMIT 時に検証（`DEFERRABLE INITIALLY DEFERRED` の constraint trigger） |
| CHECK | 金額 > 0、0 ≤ 税額 ≤ 金額、反対仕訳と取消元の対応、取消の列の整合、免税の期は税込経理、など |

ガードに当たると `ledger guard: ...` で始まるエラーになります。

## テスト

```sh
npm run test:unit   # DB を使わない単体テスト
npm run test:db     # DB のテスト（test/**/*.db.test.ts）
```

`test:db` は次の順で動きます（`vitest.db.config.ts` と `test/support/global-setup.ts`）。

1. `DATABASE_URL`（リポジトリ直下の `.env` か環境変数）から、テスト用の DB `<DB 名>_test`（例: `niho_finance_test`）を決める。`TEST_DATABASE_URL` で上書きできる。`DATABASE_URL` がなければ DB のテストはすべて skip。
2. テスト用の DB を DROP して作り直し、`prisma migrate deploy` をする。migrate しただけの状態を `<DB 名>_test_empty` に複製してから、テスト用の DB に seed をする。
3. テストを 1 ファイルずつ順に実行する（採番の並行性、ガード、登録と取消、シード後の試算表の恒等式、設定の読み書きと監査ログ）。`setup.db.test.ts` だけは空の DB（`emptyTestPrisma()`）でウィザードを最初から最後まで進める。
4. `DATABASE_URL` の DB は読むだけ。seed 済みなら、全会計期間で試算表の恒等式と連番を確かめる（未 seed なら skip）。
5. 終わったら `<DB 名>_test_empty` を DROP する（`<DB 名>_test` は次の実行まで残る）。

テスト用の DB を作り直すため、接続ユーザーには CREATEDB の権限が要ります（docker compose と CI の PostgreSQL は満たしています）。

## 接続先の決まり

- `src/env.ts` の `loadRootEnv()` が、リポジトリ直下の `.env` をプロセスごとに 1 回読みます。すでにある環境変数が優先です（CI、テストが子プロセスに渡すテスト用 DB の URL など）。
- 例外は `DATABASE_URL` だけです。環境の値が `niho_finance` / `niho_finance_*` 以外の DB を指していて `.env` の値がこのリポジトリの DB なら、`.env` の値に置き換えて警告を出します（シェルが別プロジェクトの `DATABASE_URL` を export している環境の罠を避けるため）。
- `prisma.config.ts`（`migrate` / `db` / `studio`）と `createPrismaClient()` は、DB 名が `niho_finance` か `niho_finance_*` でなければエラーにします。別プロジェクトの DB に migration やテストを流さないためです。
