# shellcheck shell=bash disable=SC2034  # the variables are read by the scripts that source this file
# Shared by scripts/gcp-bootstrap.sh and scripts/deploy.sh. Source, do not run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_ENV="${DEPLOY_ENV:-$SCRIPT_DIR/deploy.env}"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

load_deploy_env() {
  [[ -f "$DEPLOY_ENV" ]] || die "$DEPLOY_ENV is missing: copy scripts/deploy.env.example and fill it in"
  set -a
  # shellcheck disable=SC1090
  source "$DEPLOY_ENV"
  set +a
  local name
  for name in GCP_PROJECT GCP_REGION CLOUDSQL_INSTANCE VPC_NETWORK VPC_SUBNET ARTIFACT_REPO \
    WEB_SERVICE JOBS_SERVICE MIGRATE_JOB RUNNER_SA SCHEDULER_SA DOCUMENTS_BUCKET BACKUPS_BUCKET \
    IAP_MEMBERS MAIL_FROM MAIL_TO SMTP_HOST SMTP_PORT SMTP_USER ALERT_EMAIL; do
    [[ -n "${!name:-}" ]] || die "$name is not set in $DEPLOY_ENV"
  done
  TASKS_QUEUE="${TASKS_QUEUE:-niho-finance-manual}"
  # Every resource that takes labels carries this one: Cloud Billing reports filter on it.
  COST_LABEL="app=niho-finance"
  RUNNER_SA_EMAIL="$RUNNER_SA@$GCP_PROJECT.iam.gserviceaccount.com"
  SCHEDULER_SA_EMAIL="$SCHEDULER_SA@$GCP_PROJECT.iam.gserviceaccount.com"
  IMAGE="$GCP_REGION-docker.pkg.dev/$GCP_PROJECT/$ARTIFACT_REPO/web"
  SECRET_DATABASE_URL=niho-finance-database-url
  SECRET_MIGRATE_DATABASE_URL=niho-finance-migrate-database-url
  SECRET_SMTP_PASSWORD=niho-finance-smtp-password
}

gcp() { gcloud --project "$GCP_PROJECT" --quiet "$@"; }

project_number() { gcp projects describe "$GCP_PROJECT" --format='value(projectNumber)'; }
cloudsql_connection_name() {
  gcp sql instances describe "$CLOUDSQL_INSTANCE" --format='value(connectionName)'
}
# Cloud Run's deterministic URL (no describe needed before the first deploy).
service_url() { printf 'https://%s-%s.%s.run.app' "$1" "$(project_number)" "$GCP_REGION"; }
iap_audience() { printf '/projects/%s/locations/%s/services/%s' "$(project_number)" "$GCP_REGION" "$WEB_SERVICE"; }

# Environment of the web and jobs services. `^|^` lets values contain commas (MAIL_TO).
service_env_vars() {
  local service="$1" tag="$2"
  local vars=(
    "NIHO_FINANCE_ENV=prod"
    "NIHO_FINANCE_SERVICE=$service"
    "NIHO_FINANCE_GIT_SHA=$tag"
    "NIHO_FINANCE_APP_URL=${APP_URL:-$(service_url "$WEB_SERVICE")}"
    "NIHO_FINANCE_MAIL=smtp"
    "NIHO_FINANCE_MAIL_FROM=$MAIL_FROM"
    "NIHO_FINANCE_MAIL_TO=$MAIL_TO"
    "NIHO_FINANCE_SMTP_HOST=$SMTP_HOST"
    "NIHO_FINANCE_SMTP_PORT=$SMTP_PORT"
    "NIHO_FINANCE_SMTP_USER=$SMTP_USER"
    "NIHO_FINANCE_DOCUMENTS_BUCKET=$DOCUMENTS_BUCKET"
    "NIHO_FINANCE_BACKUP_BUCKET=$BACKUPS_BUCKET"
    "NIHO_FINANCE_JOB_INVOKERS=$SCHEDULER_SA_EMAIL"
  )
  if [[ "$service" == web ]]; then
    vars+=("NIHO_FINANCE_IAP_AUDIENCE=$(iap_audience)")
  fi
  local joined
  joined="$(IFS='|'; printf '%s' "${vars[*]}")"
  printf '^|^%s' "$joined"
}
