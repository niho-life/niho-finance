#!/usr/bin/env bash
# Stores a Stripe restricted key (read only) in Secret Manager (docs/ops/secrets.md §2) and
# restarts the services with it. The key is typed on the terminal without echo; it is never
# written to a file, printed or passed on a command line.
#   scripts/set-stripe-key.sh NIHO_FINANCE_STRIPE_KEY_PLATFORM
# The name is the "key name" set on the Stripe wallet (取込の設定); the secret is
# `niho-finance-stripe-key-platform`, bound by scripts/deploy.sh as that variable.
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"
load_deploy_env

env_name="${1:-}"
[[ "$env_name" =~ ^NIHO_FINANCE_STRIPE_KEY_[A-Z0-9_]+$ ]] \
  || die "usage: $0 NIHO_FINANCE_STRIPE_KEY_<NAME> (the key name of the Stripe wallet)"
secret="$(printf '%s' "$env_name" | tr 'A-Z_' 'a-z-')"
[[ -t 0 ]] || die "run it in a terminal: the key is typed, not piped"

read -rs -p "Restricted key for $env_name (rk_live_… / rk_test_…; input hidden): " key
echo
key="${key// /}"
if [[ ! "$key" =~ ^rk_(live|test)_[A-Za-z0-9]{20,}$ ]]; then
  unset key
  die "that is not a Stripe restricted key (rk_live_… or rk_test_…); nothing was stored"
fi

if ! gcp secrets describe "$secret" > /dev/null 2>&1; then
  gcp secrets create "$secret" --replication-policy automatic --labels "$COST_LABEL" > /dev/null
fi
gcp secrets add-iam-policy-binding "$secret" \
  --member "serviceAccount:$RUNNER_SA_EMAIL" --role roles/secretmanager.secretAccessor > /dev/null
printf '%s' "$key" | gcp secrets versions add "$secret" --data-file=- > /dev/null
unset key
log "stored a new version of $secret (bound as $env_name)"

"$SCRIPT_DIR/deploy.sh" --no-build
log "next: 取込の設定 › 同期 (or scripts/run-job.sh stripe-sync), then disable the old version if any"
