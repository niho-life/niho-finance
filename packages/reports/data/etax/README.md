# e-Tax の勘定科目コード表（財務諸表 CSV・HOT010）

国税庁が e-Tax ホームページ「財務諸表の CSV 形式データの作成方法」で公開している勘定科目コード表（Excel）を、版ごとに JSON にしたもの。使い方と版の選び方は [17 §6](../../../../docs/design/17-financial-statements.md)。

| フォルダ | 中身 |
| --- | --- |
| `hot010-3.0/2019/` | HOT010 Ver.3.0、コード表 2019 年版（一般商工業・業種番号 10）。令和 2 年 4 月 1 日以後提出分 |
| `tools/convert_code_tables.py` | Excel → JSON の変換（Python 標準ライブラリだけ） |

各版のフォルダ:

- `manifest.json`: 様式・版・適用開始（`effectiveFrom`、提出日と比べる）・取得日・元の Excel / PDF の URL・最終更新日・SHA-256。
- `bs-10.json`・`pl-10.json`: 貸借対照表・損益計算書のコード表。1 行 1 科目で `code`・`depth`（階層番号）・`label`（e-Tax 対応勘定科目の名前。タイトル項目は標準ラベル）・`title`（タイトル項目）・`total`（合計）。並びはコード表の表示順。
- `ss.json`・`nt.json`: 株主資本等変動計算書・個別注記表のコード表。`rowKind`（`1` 金額 / `2` 文字 / `T` タイトル。個別注記表は標準フォームの行区分）・`repeat`（繰り返し設定可能コード: `group` は組の見出し、`item` は組の中の項目）。
- `default-mapping.json`: 標準テンプレート（[02 §2](../../../../docs/design/02-accounting-rules.md)）の科目コード → 勘定科目コード。`{"under": "<コード>"}` はコード表にない独自科目で、そのコードに枝番を付ける。

## 新しい版を取り込む

1. e-Tax ホームページの「貸借対照表 / 損益計算書 / その他の財務諸表の勘定科目コード表」から `BScode10_<年>.xlsx`・`PLcode10_<年>.xlsx`・`SScode_<年>.xlsx`・`NTcode_<年>.xlsx` と個別注記表の標準フォーム `HOT010_<版>_NT.xlsx` を、空のフォルダに保存する。
2. `python3 -I tools/convert_code_tables.py <保存したフォルダ> hot010-<版>/<年>/` で JSON を作る（ファイル名が変わっていたらスクリプトを直す）。
3. `manifest.json` を前の版から写し、URL・最終更新日・SHA-256（`shasum -a 256`）・`effectiveFrom` を直す。`default-mapping.json` の各コードが新しい表にあるかを確かめる（`packages/reports` のテストが検査する）。
4. 既存の版のフォルダは書き換えない（過去の期の出力を固定するため）。

出典: 国税庁 e-Tax ホームページ（https://www.e-tax.nta.go.jp/hojin/gimuka/csv_jyoho4.htm）。公表資料を加工して作成。
