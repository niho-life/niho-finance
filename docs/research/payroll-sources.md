# 給与計算の一次資料（取込元と取込日）

`packages/payroll/data/<年>/` の数値の出どころ。設計は [`../design/22-payroll.md`](../design/22-payroll.md)。年次の更新手順は同 §3.3。

取込日はすべて **2026-10-28**。SHA-256 はダウンロードした原本のもの（原本はリポに置かない。CSV スナップショットは `data/<年>/source/` に置く）。

## 1. 源泉徴収税額表（国税庁）

| 年分 | 資料 | URL | SHA-256（原本） | 取り込んだ先 |
| --- | --- | --- | --- | --- |
| 令和 8 年分（2026） | 月額表 Excel（表 1〜7 ページ） | https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2026/data/01-07.xls | `50aafa072df1bb6b6aa253a021f7cc246265c3f2393f9988ee01ad121bc4f310` | `data/2026/source/withholding-monthly.csv` → `data/2026/withholding-monthly.json` |
| 令和 8 年分（2026） | 月額表 PDF（検算用） | https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2026/data/01-07.pdf | `c583c9c33cb4e99f4a1505431f2aa768a585b84f09bb9bfb6929b0e8b0c37699` | ゴールデンテストの期待値 |
| 令和 9 年分（2027） | 月額表 Excel | https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2027/data/01-07.xlsx | `f2f331de1207ae0da6a3f416c7ad233de9411b0210a65e928c39527f1791fea5` | `data/2027/source/withholding-monthly.csv` → `data/2027/withholding-monthly.json` |
| 令和 9 年分（2027） | 月額表 PDF（検算用） | https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2027/data/01-07.pdf | `9de9d1564dfcf00922b33feaa508dbffde97516d98c9ae2aeecae3be4aa810d6` | ゴールデンテストの期待値 |

- 入口のページ: 令和 8 年分 https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2026/01.htm ／ 令和 9 年分 https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2027/01.htm
- 根拠: 令和 8 年分は「平成 24 年 3 月 31 日財務省告示第 115 号別表第一（令和 7 年 4 月 30 日財務省告示第 122 号改正）」、令和 9 年分は「令和 8 年 4 月 30 日財務省告示第 127 号別表第一」（いずれも Excel の表題行の記載）。
- 表の見方（Excel 末尾の備考）: 社会保険料等控除後の給与等の金額で行を選ぶ。甲欄は扶養親族等の数が 7 人を超えると 1 人ごとに 1,610 円を控除。乙欄は「従たる給与についての扶養控除等申告書」があれば扶養親族等 1 人ごとに 1,610 円を控除。
- 源泉徴収税額の 1 円未満は切り捨て（国税通則法第 119 条第 2 項・同施行令第 40 条。e-Gov: https://laws.e-gov.go.jp/api/1/articles;lawId=337AC0000000066;article=119 ）。
- 日額表・賞与の算出率の表は未取込（賞与は後続の Issue）。

## 2. 協会けんぽ（健康保険・介護保険・子ども・子育て支援金）

| 年度 | 資料 | URL | SHA-256（原本） | 取り込んだ先 |
| --- | --- | --- | --- | --- |
| 令和 8 年度（2026） | 神奈川支部 保険料額表（令和 8 年 3 月分〜） | https://www.kyoukaikenpo.or.jp/assets/R8_14kanagawa.pdf | `68b2492461de9782c4ae5f84b888b8cdf7876d0095814309f94a1b24aa6a2790` | `data/2026/source/kyokai-kenpo-kanagawa.csv`（pdftotext の表部分）→ `data/2026/kyokai-kenpo-kanagawa.json`・`data/2020/pension.json` の等級表 |
| 令和 8 年度（2026） | 都道府県単位保険料率の一覧（HTML） | https://www.kyoukaikenpo.or.jp/g7/cat330/sb3130/r08/ | — | 料率の確認（神奈川 9.92%、介護 1.62%、支援金 0.23%） |

- 料率の適用: 健康保険料率は令和 7 年 3 月分から据置、介護保険料率 1.62% は令和 8 年 3 月分から、子ども・子育て支援金率 0.23% は **令和 8 年 4 月分（5 月納付分）から**。
- 端数（PDF の注記）: 給与から控除する被保険者負担分は 50 銭以下切り捨て・50 銭超切り上げ。現金で事業主へ払う場合は 50 銭未満切り捨て・50 銭以上切り上げ。納入告知額は被保険者ごとの保険料額（全額）の合算の円未満切り捨て。
- 介護保険第 2 号被保険者（40〜64 歳）の表は健康保険料率と介護保険料率を合算した率（11.54%）で 1 列になっている。支援金は別の列。
- 支援金の端数: 「子ども・子育て支援金制度に関する事務取扱い」（厚生労働省 事務連絡、令和 8 年 2 月 12 日付）と Q&A で、一般保険料率と支援金率を合算した率を標準報酬月額に乗じ、折半した額に 50 銭ルールを適用する取扱いが示されたと社労士事務所の解説が伝える（https://kataoka-sr-gs.com/custom/292/ ）。**一次資料（事務連絡の URL）は未取得。要確認（22 §9）。**

## 3. 厚生年金（日本年金機構・厚生労働省）

| 項目 | 資料 | URL | 取り込んだ先 |
| --- | --- | --- | --- |
| 料率 18.300%（平成 29 年 9 月分〜）・標準報酬月額 1〜32 級（88,000〜650,000 円） | 協会けんぽ 神奈川支部 保険料額表の厚生年金欄（上記） | 同上 | `data/2020/pension.json`（2020 年 9 月分〜2027 年 8 月分） |
| 子ども・子育て拠出金率 0.36%（令和 2 年 4 月分〜。事業主のみ負担） | 同上 PDF の注記 | 同上 | `data/2020/pension.json` |
| 上限の段階的引上げ: 2027 年 9 月 68 万円（33 級）、2028 年 9 月 71 万円、2029 年 9 月 75 万円 | 厚生労働省「厚生年金等の標準報酬月額の上限の段階的引上げについて」（令和 7 年 6 月 13 日成立の年金制度改正法） | https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/0000147284_00024.html | `data/2027/pension.json`（2027 年 9 月分〜2028 年 8 月分。33 級 680,000 円 = 報酬月額 665,000 円以上）。2028 年 9 月分（71 万円）・2029 年 9 月分（75 万円）の版は適用前に取り込む（取り込むまでその月の計算は「表がない」エラーで止まる） |

## 4. 雇用保険（厚生労働省）

| 年度 | 資料 | URL | SHA-256（原本） | 取り込んだ先 |
| --- | --- | --- | --- | --- |
| 令和 8 年度（2026-04-01〜2027-03-31） | 令和 8 年度 雇用保険料率のご案内（PDF） | https://www.mhlw.go.jp/content/001692566.pdf | `69ca914736d051ffa067464756500c2a8cf597186e9cf091b54512a68d3b1be9` | `data/2026/employment-insurance.json` |

- 一般の事業: 労働者負担 5/1,000、事業主負担 8.5/1,000（失業等給付・育児休業給付 5/1,000 ＋ 雇用保険二事業 3.5/1,000）、合計 13.5/1,000。入口のページ: https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/0000108634.html
- 役員は被保険者にならない（兼務役員の例外は扱わない）。

## 5. 年齢の規則（法令）

| 規則 | 根拠 |
| --- | --- |
| 年齢は誕生日の前日に 1 つ加わる（「達した日」＝誕生日の前日） | 年齢計算ニ関スル法律（明治 35 年法律第 50 号）・民法第 143 条 |
| 介護保険第 2 号被保険者は 40 歳以上 65 歳未満の医療保険加入者。保険料は 40 歳に達した日の属する月分から、65 歳に達した日の属する月の前月分まで | 介護保険法第 9 条第 2 号、健康保険法第 156 条・第 167 条 |
| 厚生年金の被保険者は 70 歳未満。70 歳に達した日に資格喪失（その月の前月分まで保険料） | 厚生年金保険法第 9 条・第 14 条 |
| 健康保険は 75 歳の誕生日に後期高齢者医療へ移行（その月の前月分まで保険料） | 健康保険法第 3 条・高齢者の医療の確保に関する法律第 50 条 |

## 6. 住民税（特別徴収）

市区町村の「特別徴収税額決定通知書」の額を入力する（自社計算しない）。鎌倉市の事業者向けページ: https://www.city.kamakura.kanagawa.jp/shiminzei/zeimokubetsu/01650002kojinjuuminzei-kyuyokaranotokubetsuchoshu.html

## 7. 取り込みの手順（年 1 回）

1. 上の URL から原本をダウンロードし、SHA-256 をこの文書に追記する。
2. 源泉徴収税額表: `packages/payroll/scripts/xls-to-csv.py` で Excel を CSV にし（`python3 -m venv .venv && .venv/bin/pip install xlrd openpyxl`）、`data/<年>/source/withholding-monthly.csv` に置く。`node --experimental-strip-types packages/payroll/scripts/build-withholding-table.ts <年>` で JSON を生成し、`npx prettier --write packages/payroll/data` をかける。
3. 協会けんぽ・厚生年金・雇用保険: JSON を手で書く（行数が少ない）。`pdftotext -layout` の表部分を `data/<年>/source/` に CSV で残し、テストで JSON と突き合わせる。
4. ゴールデンテスト（`packages/payroll/test/golden.test.ts`）の期待値を PDF の該当行から取り直す。
5. PR に出典 URL・取込日・差分の要点を書く。
