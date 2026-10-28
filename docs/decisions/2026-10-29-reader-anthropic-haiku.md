# 証憑の読み取りは Anthropic API（既定 Claude Haiku 5.5）から始める

## 状況

[04 §4](../design/04-integrations.md) は証憑の読み取りを provider で抽象化し、第一候補を LLM の vision、比較対象を Google Document AI（Expense Parser）と Azure Document Intelligence（receipt）としていた。#18 で読み取りを作るにあたり、最初の provider とモデルを決める必要があった。

## 決定

- 最初の provider は Anthropic API（`@anthropic-ai/sdk`）。構造化出力（`output_config.format` の JSON Schema）で答えの形を強制する。
- 既定のモデルは軽量の `claude-haiku-5-5`。精度が足りなければ環境変数 `NIHO_FINANCE_READER_MODEL=claude-sonnet-5-5` で切り替える（オーナーの指示 2026-10-28）。
- 架空の領収書 10 枚（画像 7・PDF 3）で実 API の一致率を測った（2026-10-29、`npm -w @niho-finance/reader run record` → `eval`）。Haiku 5.5 で 10 枚とも 日付・合計・税率別の内訳・登録番号・発行者が一致し、費用は 10 枚で 約 $0.0056 だったので、既定は Haiku 5.5 のままにする。
- Document AI と Azure は、Haiku と Sonnet の両方で一致率が足りないときに同じゴールドセットで比べる。

## 理由

- 画像と PDF を 1 つの呼び出しで読め、税率別の内訳・登録番号・但し書きまで同じ JSON で返せる。
- 費用が小さい（Haiku 5.5 で 1 枚 約 0.1 円、Sonnet 5.5 で 約 2 円。月 100 枚でも月 300 円の予算に収まる。[20 §2.3](../design/20-reader-and-registry.md)）。
- 読み取りは提案だけで、検証層と人の確認を必ず通る（[20 §1](../design/20-reader-and-registry.md)）。読み違いの影響は「要確認」で止まり、帳簿には入らない。

## 影響

- 新しい workspace `packages/reader`（[20 §2](../design/20-reader-and-registry.md)）。
- 本番の鍵は Secret Manager から Cloud Run に結ぶ（S8 への引き継ぎ。[20 §13](../design/20-reader-and-registry.md)）。
- 証憑のファイルが Anthropic に送られる。API の入出力の扱い（学習への利用・保持期間）は、鍵を発行するときにオーナーが規約で確かめる。
