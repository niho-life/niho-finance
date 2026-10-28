#!/usr/bin/env bash
# Stores the SMTP app password as a new version of its secret (docs/ops/secrets.md §2), then
# restarts the services on it and sends the confirmation mail. The password is typed on the
# terminal without echo; it is never written to a file, printed or passed on a command line.
# Google shows an app password as four groups of four letters: the spaces are dropped.
#   scripts/set-smtp-password.sh
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"
load_deploy_env

[[ -t 0 ]] || die "run it in a terminal: the password is typed, not piped"
read -rs -p "App password of $SMTP_USER (16 letters; input hidden): " password
echo
password="${password// /}"
if [[ ! "$password" =~ ^[A-Za-z0-9]{16}$ ]]; then
  unset password
  die "that is not an app password (16 letters, shown by Google as 4 groups of 4); nothing was stored"
fi
printf '%s' "$password" | gcp secrets versions add "$SECRET_SMTP_PASSWORD" --data-file=- > /dev/null
unset password
log "stored a new version of $SECRET_SMTP_PASSWORD"

"$SCRIPT_DIR/deploy.sh" --no-build
"$SCRIPT_DIR/run-job.sh" mail-check
log "check the inbox of $MAIL_TO for \"[NIHO finance] 送信の確認\""
