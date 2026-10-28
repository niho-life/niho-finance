# Stripe の鍵は「環境変数の名前」で参照し、本番は Secret Manager を環境変数に結ぶ

## 状況

[01 §2](../design/01-domain-model.md) の `StripeAccountLink.secretName` は「Secret Manager 上のキー名」とあり、アプリが Secret Manager の API を直接読む形も考えられた。S4（#5）でローカルはテストモードの制限付きキーを `.env` に置いて開発する。

## 決定

`secretName` は鍵を置いた環境変数の名前（`NIHO_FINANCE_STRIPE_` で始まる大文字の英数字と `_`。例 `NIHO_FINANCE_STRIPE_KEY_PLATFORM`）とし、アプリは `process.env[secretName]` を読む。本番（S8）は Cloud Run の `--set-secrets` で Secret Manager の秘密を同名の環境変数に結ぶ。鍵の値は DB・ログ・監査ログ・画面に出さない。

## 理由

- ローカルと本番で同じコードになり、Secret Manager のクライアントと IAM の設定をアプリに持ち込まずに済む。
- Cloud Run の秘密の環境変数は Secret Manager のバージョン固定・ローテーションに対応しており、アプリ側で読み直す仕組みが要らない。
- 鍵の名前だけを DB に置くので、DB のバックアップに鍵が混ざらない。
- 名前を `NIHO_FINANCE_STRIPE_` に限るので、設定の誤り（や画面の悪用）で `DATABASE_URL` などほかの秘密が Stripe へ API キーとして送られることがない。

## 影響

- [12 §4.1](../design/12-imports.md) に手順を書いた。S8 の配備で `--set-secrets` と Scheduler の OIDC 設定を行う。
- 鍵を増やす（アカウントを増やす）ときは環境変数を 1 つ足す。
