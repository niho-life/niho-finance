# 自社拠点の application fee は 0（D5）

- 決定（owner 2026-10-28）: 会社が運営する拠点の Connect の application fee は 0 にする。
- 理由: 売上が二重に膨らまず、免税判定の売上高にも影響しない。内部取引の消し込みが要らない。
- 影響: `platform_earning` が自社拠点から発生しない前提。発生した場合は内部取引（9000）で相殺する。NIHO アプリ側の設定は移転の Epic で行う。[02 §4.2](../design/02-accounting-rules.md)
