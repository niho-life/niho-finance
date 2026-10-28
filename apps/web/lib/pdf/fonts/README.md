# PDF のフォント（Noto Sans JP）

`lib/pdf/font.ts` が PDF の描画の前に 1 回だけ登録するフォントです（`registerFonts()`、ファミリー名 `"Noto Sans JP"`、400 と 700）。報告の PDF、決算書（#15）・請求書（#16）・給与（#20）は同じ登録を使い、フォントを重ねて登録しません。

| ファイル | 中身 |
| --- | --- |
| `NotoSansJP-Regular.ttf` | ウェイト 400（約 4.9 MB） |
| `NotoSansJP-Bold.ttf` | ウェイト 700（約 4.9 MB） |
| `OFL.txt` | ライセンス（SIL Open Font License 1.1） |
| `subset.py` | 下の作り方のスクリプト |

## 出どころと作り方

- 元: Google Fonts の [google/fonts](https://github.com/google/fonts) の `ofl/notosansjp/NotoSansJP[wght].ttf`（可変フォント）。著作権表示とライセンスは `OFL.txt`。
- fontTools の `instancer` で `wght` を 400 と 700 に固定し、`subset` で Latin・記号・かな・CJK 統合漢字（拡張 A を含む）・互換漢字・全角形の範囲に絞っています（範囲は `subset.py` の `UNICODES`）。

```sh
python3 -m pip install fonttools
python3 subset.py 'NotoSansJP[wght].ttf' <出力先のディレクトリ>
```

フォント名（`name` テーブル）は元のまま残しています。OFL 1.1 に従い、フォントを単体で売らないこと、改変したフォントに予約フォント名を使わないことを守ってください。

## 配備（S8）

`font.ts` は `process.cwd()` からの文字列のパスで `lib/pdf/fonts`（`next dev` / `next start` は `apps/web` で動く）を探し、無ければ `apps/web/lib/pdf/fonts`（リポジトリの直下から動かすスクリプトやテスト）を探します。パスを文字列で書いているので、`next build` の file tracing が 2 つの TTF を PDF を返す route の依存に含めます（例: `.next/server/app/(app)/reports/export/route.js.nft.json`）。standalone の出力で配るときは同梱されたことを確かめ、足りなければ `next.config.ts` の `outputFileTracingIncludes` に `apps/web/lib/pdf/fonts/**` を足してください。
