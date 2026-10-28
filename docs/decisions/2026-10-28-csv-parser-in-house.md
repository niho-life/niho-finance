# CSV は自前の小さなパーサで読む（papaparse を使わない）

## 状況

[06 §2](../design/06-architecture.md) は CSV の取込に `papaparse` を予定していた。S4（#5）で銀行・カードの CSV パーサを作るにあたり、必要なのは RFC 4180（ダブルクォート・`""`・引用内の改行・CRLF / LF / CR）と BOM の扱いだけで、文字コード（Shift_JIS）は Node の `TextDecoder` が担う。

## 決定

`packages/importers` に自前の CSV パーサ（数十行）を置き、`papaparse` と `@types/papaparse` は入れない。形式ごとの読み取りは形式モジュールが担い、パーサは「文字列 → 行と列」だけを受け持つ。

## 理由

- 銀行・カードの CSV は機械生成で規則的。RFC 4180 の範囲で足り、ストリーミングや自動の型変換（papaparse の `dynamicTyping` は金額を浮動小数にしてしまう）は要らない。
- 依存を 2 つ減らせる。公開リポで依存の監査対象も減る。
- ゴールデンテストで挙動を固定でき、ライブラリの版上げで読み方が変わる心配がない。

## 影響

- [06 §2](../design/06-architecture.md) の表を更新した。
- 読めない CSV が出たら、形式モジュールかフィクスチャを足して直す（[12 §3](../design/12-imports.md)）。
