# 画面は IAP、ジョブは IAM で分ける（S8）

- 状況: [06 §3.1](../design/06-architecture.md) は Cloud Run 1 サービスに IAP を掛け、Scheduler の OIDC トークンでジョブを呼ぶ構成だった。Cloud Run の IAP は呼び出し元の ID を IAP のものに置き換えるため、IAP を通した要求ではアプリが Scheduler の OIDC トークンを検証できず、サービスアカウントで IAP を通すには IAP 側の OAuth クライアントの許可設定が別に要る。
- 決定（S8、2026-10-28）: 同じイメージから Cloud Run サービスを 2 つ作る。`niho-finance`（画面。IAP）と `niho-finance-jobs`（ジョブ。IAP なし・未認証不可・`run.invoker` は Scheduler のサービスアカウントだけ）。`/api/jobs/*` は `NIHO_FINANCE_SERVICE=jobs` のサービスでだけ動く。
- 理由: どちらも Google の標準の経路で、アプリ側の検証（IAP の署名ヘッダー / Scheduler の OIDC）が素直に書ける。両方 min 0 なので固定費は増えない。
- 影響: [06 §3.1・§3.2・§4](../design/06-architecture.md)、`docs/ops/deploy.md`。
