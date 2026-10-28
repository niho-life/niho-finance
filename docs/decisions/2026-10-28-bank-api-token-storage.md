# 銀行 API のトークンは DB に暗号化して置き、暗号鍵とクライアントの秘密を Secret Manager に置く

## 状況

GMO あおぞらネット銀行の API（v2 #17）は OAuth 2.0 ＋ OpenID Connect の Authorization Code フローで、認可のたびにアクセストークン（応答例は 30 日）とリフレッシュトークンが銀行から返る。Issue は「鍵は Secret Manager、ローカルは `.env`」とする。Stripe の鍵（[決定](2026-10-28-stripe-key-via-env.md)）は人が置く固定の値だが、銀行のトークンは実行中に発行・更新される値で、人が Secret Manager に置けない。アプリが Secret Manager に書く形も考えられた。

## 決定

- 固定の秘密（クライアント ID・クライアントシークレット）は環境変数で読み、本番は Cloud Run の `--set-secrets` で Secret Manager を結ぶ（Stripe と同じ）。
- 実行中に変わるトークンは、口座の `bank_api_tokens` に AES-256-GCM で暗号化して置く。暗号鍵 `NIHO_FINANCE_BANK_TOKEN_KEY`（32 バイト）は Secret Manager に置き、環境変数で結ぶ。
- sunabar のトークンの方式（ポータルで発行する固定のアクセストークン）は環境変数に置き、DB には置かない。
- トークン・口座 ID はログ・監査ログ・画面・日次バックアップに出さない。

## 理由

- アプリに Secret Manager の書き込み権限とクライアントを持ち込まずに済み、ローカルと本番で同じコードになる。
- 更新のたびに秘密のバージョンが増えない。比較つきの更新（読んだ暗号文と同じなら書く）で、手動の同期とジョブの同時の更新も DB の 1 行で扱える。
- DB やバックアップが漏れても、暗号鍵がなければトークンは使えない。鍵を差し替えると復号できなくなり、口座は「再接続が必要」になる（再接続で直る）。

## 影響

- [19 §2.3・§5](../design/19-bank-api.md) に書いた。S8 の配備で `NIHO_FINANCE_BANK_TOKEN_KEY` と `NIHO_FINANCE_GMO_AOZORA_CLIENT_SECRET` を Secret Manager に作り、画面とジョブのサービスに結ぶ。
- 暗号鍵のローテーションは「鍵を差し替えて再接続する」で行う（古い鍵での復号は持たない）。
