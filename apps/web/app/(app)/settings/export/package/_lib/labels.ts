import type { HandoverRequestState } from "@niho-finance/db";

/** 状態 of a made package (14-reports §16.1). */
export const REQUEST_STATE_LABELS: Readonly<Record<HandoverRequestState, string>> = {
  pending: "作成中",
  stale: "作成中",
  ready: "作成済み",
  failed: "失敗",
};

export const STALE_MESSAGE = "失敗した可能性があります。もう一度依頼してください";

/** README note when the production screen leaves the files out (no queue, §16.4). */
export const FILES_LEFT_OUT_NOTE =
  "大きいパッケージを作る設定がないため、証憑のファイルを外して書き出しました（索引簿は入っています）。";

/** `?error=` of the page. */
export const PACKAGE_ERRORS: Readonly<Record<string, string>> = {
  year: "会計期間がありません。設定 › 会計期間 で期を作ってから書き出します。",
  "too-large": "証憑のファイルを含めると大きいため、「作成を依頼」から作ります。",
  "not-ready": "このパッケージはまだ作成できていません。下の一覧で状態を確かめてください。",
  "not-found": "依頼が見つかりません。下の一覧からダウンロードします。",
  "no-queue": "大きいパッケージを作る設定がありません。証憑のファイルを外して書き出します。",
  actor: "ログイン情報を確認できませんでした。画面を読み込み直してください。",
  enqueue: "作成を依頼できませんでした。時間をおいてもう一度依頼してください。",
};

/** `?done=` of the page. */
export const PACKAGE_NOTICES: Readonly<Record<string, string>> = {
  requested: "作成を依頼しました。作成済みになったら下の一覧からダウンロードします。",
  made: "作成しました。下の一覧からダウンロードします。",
  failed: "作成できませんでした。下の一覧で理由を確かめてください。",
};
