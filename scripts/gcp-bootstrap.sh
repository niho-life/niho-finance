#!/usr/bin/env bash
# One-time creation of the GCP resources (docs/ops/deploy.md §3). Idempotent: what exists is kept.
#
#   scripts/gcp-bootstrap.sh resources   # APIs, service accounts, Cloud SQL database and roles,
#                                        # secrets, Artifact Registry, buckets  (before the first deploy)
#   scripts/deploy.sh                    # first build and deploy
#   scripts/gcp-bootstrap.sh access      # IAP, Scheduler, monitoring            (after the first deploy)
#
# Secret values are generated here or typed on the terminal; they are never written to a file or
# printed. Needs scripts/deploy.env (see deploy.env.example) and a gcloud login with project access.
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"
load_deploy_env
cd "$REPO_ROOT" || exit 1

phase="${1:-all}"
case "$phase" in resources|access|all) ;; *) die "usage: $0 [resources|access|all]" ;; esac

PROJECT_NUMBER="$(project_number)"
CONNECTION="$(cloudsql_connection_name)"

# No pipelines here: with `set -o pipefail` a `head` closing early kills the script with SIGPIPE.
gen_password() { openssl rand -hex 20; }
first_line() { local text="$1"; printf '%s' "${text%%$'\n'*}"; }
ensure_secret() {
  gcp secrets describe "$1" > /dev/null 2>&1 \
    || gcp secrets create "$1" --replication-policy automatic --labels "$COST_LABEL"
  gcp secrets update "$1" --update-labels "$COST_LABEL" > /dev/null
}
secret_has_version() {
  [[ -n "$(gcp secrets versions list "$1" --filter='state:ENABLED' --format='value(name)' --limit 1)" ]]
}
ensure_service_account() {
  local email="$1" name="$2"
  gcp iam service-accounts describe "$email" > /dev/null 2>&1 \
    || gcp iam service-accounts create "${email%%@*}" --display-name "$name"
}
ensure_bucket() {
  local name="$1" retention="$2" versioning="$3" role
  if ! gcp storage buckets describe "gs://$name" > /dev/null 2>&1; then
    gcp storage buckets create "gs://$name" --location "$GCP_REGION" \
      --uniform-bucket-level-access --public-access-prevention --retention-period "$retention"
  fi
  if [[ "$versioning" == 1 ]]; then gcp storage buckets update "gs://$name" --versioning > /dev/null; fi
  gcp storage buckets update "gs://$name" --update-labels "$COST_LABEL" > /dev/null
  # Create and read only: the runtime cannot delete or overwrite objects.
  for role in roles/storage.objectCreator roles/storage.objectViewer; do
    gcp storage buckets add-iam-policy-binding "gs://$name" \
      --member "serviceAccount:$RUNNER_SA_EMAIL" --role "$role" > /dev/null
  done
}

resources() {
  log "APIs"
  gcp services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com \
    cloudscheduler.googleapis.com cloudtasks.googleapis.com iap.googleapis.com artifactregistry.googleapis.com \
    cloudbuild.googleapis.com monitoring.googleapis.com logging.googleapis.com

  log "service accounts"
  ensure_service_account "$RUNNER_SA_EMAIL" "NIHO finance runtime (Cloud Run)"
  ensure_service_account "$SCHEDULER_SA_EMAIL" "NIHO finance scheduler (OIDC)"
  gcp projects add-iam-policy-binding "$GCP_PROJECT" --condition=None \
    --member "serviceAccount:$RUNNER_SA_EMAIL" --role roles/cloudsql.client > /dev/null
  # Signed URLs (documents) are signed through the IAM credentials API with the runtime's own identity.
  gcp iam service-accounts add-iam-policy-binding "$RUNNER_SA_EMAIL" \
    --member "serviceAccount:$RUNNER_SA_EMAIL" --role roles/iam.serviceAccountTokenCreator > /dev/null

  log "Cloud SQL: database niho_finance in $CLOUDSQL_INSTANCE"
  gcp sql databases describe niho_finance --instance "$CLOUDSQL_INSTANCE" > /dev/null 2>&1 \
    || gcp sql databases create niho_finance --instance "$CLOUDSQL_INSTANCE"

  log "Cloud SQL: migration role (owns the tables) and its secret"
  ensure_secret "$SECRET_MIGRATE_DATABASE_URL"
  local users
  users="$(gcp sql users list --instance "$CLOUDSQL_INSTANCE" --format='value(name)')"
  if grep -qx niho_finance_migrate <<< "$users"; then
    secret_has_version "$SECRET_MIGRATE_DATABASE_URL" \
      || die "niho_finance_migrate exists but $SECRET_MIGRATE_DATABASE_URL has no version: see docs/ops/secrets.md"
  else
    password="$(gen_password)"
    gcp sql users create niho_finance_migrate --instance "$CLOUDSQL_INSTANCE" --password "$password"
    printf 'postgresql://niho_finance_migrate:%s@localhost/niho_finance?host=/cloudsql/%s' "$password" "$CONNECTION" \
      | gcp secrets versions add "$SECRET_MIGRATE_DATABASE_URL" --data-file=- > /dev/null
    unset password
  fi

  log "app role secret (the role itself is created by the migrate job from this URL)"
  ensure_secret "$SECRET_DATABASE_URL"
  if ! secret_has_version "$SECRET_DATABASE_URL"; then
    password="$(gen_password)"
    printf 'postgresql://niho_finance_app:%s@localhost/niho_finance?host=/cloudsql/%s' "$password" "$CONNECTION" \
      | gcp secrets versions add "$SECRET_DATABASE_URL" --data-file=- > /dev/null
    unset password
  fi

  log "SMTP password secret"
  ensure_secret "$SECRET_SMTP_PASSWORD"
  if ! secret_has_version "$SECRET_SMTP_PASSWORD"; then
    if [[ -t 0 ]]; then
      read -rs -p "SMTP app password for $SMTP_USER (not echoed; empty = add it later): " password
      echo
      if [[ -n "$password" ]]; then
        printf '%s' "$password" | gcp secrets versions add "$SECRET_SMTP_PASSWORD" --data-file=- > /dev/null
      fi
      unset password
    else
      # Without a terminal a placeholder keeps the first deploy going (Cloud Run needs a version to
      # mount). Mail fails until the real app password is added as a new version (docs/ops/secrets.md).
      printf '%s' placeholder | gcp secrets versions add "$SECRET_SMTP_PASSWORD" --data-file=- > /dev/null
      log "no terminal: placeholder version added; add the real one with  printf '%s' '<password>' | gcloud secrets versions add $SECRET_SMTP_PASSWORD --data-file=-"
    fi
  fi
  local secret
  for secret in "$SECRET_DATABASE_URL" "$SECRET_MIGRATE_DATABASE_URL" "$SECRET_SMTP_PASSWORD"; do
    gcp secrets add-iam-policy-binding "$secret" \
      --member "serviceAccount:$RUNNER_SA_EMAIL" --role roles/secretmanager.secretAccessor > /dev/null
  done

  log "Cloud Build: the build runs as the compute default service account; it reads the source tarball"
  gcp storage buckets add-iam-policy-binding "gs://${GCP_PROJECT}_cloudbuild" \
    --member "serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
    --role roles/storage.objectViewer > /dev/null

  log "Artifact Registry $ARTIFACT_REPO"
  gcp artifacts repositories describe "$ARTIFACT_REPO" --location "$GCP_REGION" > /dev/null 2>&1 \
    || gcp artifacts repositories create "$ARTIFACT_REPO" --location "$GCP_REGION" \
      --repository-format docker --description "NIHO finance images"
  gcp artifacts repositories update "$ARTIFACT_REPO" --location "$GCP_REGION" \
    --update-labels "$COST_LABEL" > /dev/null
  gcp artifacts repositories set-cleanup-policies "$ARTIFACT_REPO" --location "$GCP_REGION" \
    --policy "$REPO_ROOT/ops/artifact-cleanup.json" --no-dry-run > /dev/null

  log "buckets"
  ensure_bucket "$DOCUMENTS_BUCKET" P7Y 1
  ensure_bucket "$BACKUPS_BUCKET" P10Y 0
  log "resources: done. Next: scripts/deploy.sh, then scripts/gcp-bootstrap.sh access"
}

ensure_scheduler_job() {
  local name="$1" schedule="$2" path="$3" jobs_url verb
  jobs_url="$(service_url "$JOBS_SERVICE")"
  if gcp scheduler jobs describe "$name" --location "$GCP_REGION" > /dev/null 2>&1; then verb=update; else verb=create; fi
  gcp scheduler jobs "$verb" http "$name" --location "$GCP_REGION" \
    --schedule "$schedule" --time-zone Asia/Tokyo \
    --uri "$jobs_url$path" --http-method POST \
    --oidc-service-account-email "$SCHEDULER_SA_EMAIL" --oidc-token-audience "$jobs_url" \
    --max-retry-attempts 0 --attempt-deadline 900s > /dev/null
  echo "$verb"
}

ensure_alert_policy() {
  local file="$1" channel="$2" rendered display name
  rendered="$(mktemp)"
  sed -e "s|__WEB_SERVICE__|$WEB_SERVICE|g" -e "s|__JOBS_SERVICE__|$JOBS_SERVICE|g" \
    -e "s|__CHANNEL__|$channel|g" "$file" > "$rendered"
  display="$(first_line "$(sed -n 's/^ *"displayName": "\([^"]*\)",$/\1/p' "$rendered")")"
  name="$(first_line "$(gcloud alpha --project "$GCP_PROJECT" monitoring policies list \
    --filter="displayName=\"$display\"" --format='value(name)')")"
  if [[ -n "$name" ]]; then
    gcloud alpha --project "$GCP_PROJECT" --quiet monitoring policies update "$name" --policy-from-file "$rendered" > /dev/null
  else
    gcloud alpha --project "$GCP_PROJECT" --quiet monitoring policies create --policy-from-file "$rendered" > /dev/null
  fi
  rm -f "$rendered"
  log "alert policy: $display"
}

access() {
  gcp run services describe "$WEB_SERVICE" --region "$GCP_REGION" > /dev/null 2>&1 \
    || die "$WEB_SERVICE does not exist yet: run scripts/deploy.sh first"

  log "IAP: service agent and run.invoker on $WEB_SERVICE"
  gcloud beta --project "$GCP_PROJECT" --quiet services identity create --service iap.googleapis.com > /dev/null
  gcp run services add-iam-policy-binding "$WEB_SERVICE" --region "$GCP_REGION" \
    --member "serviceAccount:service-$PROJECT_NUMBER@gcp-sa-iap.iam.gserviceaccount.com" \
    --role roles/run.invoker > /dev/null
  gcloud beta --project "$GCP_PROJECT" --quiet run services update "$WEB_SERVICE" --region "$GCP_REGION" --iap > /dev/null
  local member
  IFS=',' read -ra members <<< "$IAP_MEMBERS"
  for member in "${members[@]}"; do
    member="${member// /}"
    [[ -n "$member" ]] || continue
    # `--resource-type cloud-run` is beta in gcloud 550.
    gcloud beta --project "$GCP_PROJECT" --quiet iap web add-iam-policy-binding \
      --resource-type cloud-run --service "$WEB_SERVICE" --region "$GCP_REGION" \
      --member "$member" --role roles/iap.httpsResourceAccessor > /dev/null
    log "IAP: $member"
  done

  # The screens upload evidence files straight to the bucket with signed PUT URLs (13-documents §6).
  log "documents bucket: CORS for uploads from the screens"
  local origins cors
  origins="\"$(service_url "$WEB_SERVICE")\""
  if [[ -n "${APP_URL:-}" ]]; then origins+=", \"$APP_URL\""; fi
  cors="$(mktemp)"
  printf '[{"origin": [%s], "method": ["PUT"], "responseHeader": ["Content-Type"], "maxAgeSeconds": 3600}]\n' \
    "$origins" > "$cors"
  gcp storage buckets update "gs://$DOCUMENTS_BUCKET" --cors-file "$cors" > /dev/null
  rm -f "$cors"

  log "Scheduler → $JOBS_SERVICE"
  gcp run services add-iam-policy-binding "$JOBS_SERVICE" --region "$GCP_REGION" \
    --member "serviceAccount:$SCHEDULER_SA_EMAIL" --role roles/run.invoker > /dev/null
  ensure_scheduler_job niho-finance-backup-export "0 3 * * *" /api/jobs/backup > /dev/null
  ensure_scheduler_job niho-finance-calendar-notify "0 9 * * *" /api/jobs/calendar > /dev/null
  # Manual runs (scripts/run-job.sh): Cloud Tasks reaches the internal jobs service like Scheduler.
  gcp tasks queues describe "$TASKS_QUEUE" --location "$GCP_REGION" > /dev/null 2>&1 \
    || gcp tasks queues create "$TASKS_QUEUE" --location "$GCP_REGION" \
      --max-attempts 1 --max-concurrent-dispatches 1 > /dev/null
  # 受け渡しパッケージ (14-reports §16.4): the web service (runtime account) puts tasks on the queue
  # and gives them the scheduler's OIDC token, which needs actAs on the scheduler's account.
  gcp tasks queues add-iam-policy-binding "$TASKS_QUEUE" --location "$GCP_REGION" \
    --member "serviceAccount:$RUNNER_SA_EMAIL" --role roles/cloudtasks.enqueuer > /dev/null
  gcp iam service-accounts add-iam-policy-binding "$SCHEDULER_SA_EMAIL" \
    --member "serviceAccount:$RUNNER_SA_EMAIL" --role roles/iam.serviceAccountUser > /dev/null
  ensure_scheduler_job niho-finance-stripe-sync "0 6 * * *" /api/jobs/stripe-sync > /dev/null
  local job
  for job in niho-finance-backup-export niho-finance-calendar-notify niho-finance-stripe-sync; do
    if [[ "$(gcp scheduler jobs describe "$job" --location "$GCP_REGION" --format='value(state)')" == PAUSED ]]; then
      gcp scheduler jobs resume "$job" --location "$GCP_REGION" > /dev/null
      log "scheduler: resumed $job"
    fi
  done

  log "monitoring"
  local channel
  channel="$(first_line "$(gcloud beta --project "$GCP_PROJECT" monitoring channels list \
    --filter='displayName="niho-finance ops email"' --format='value(name)')")"
  if [[ -z "$channel" ]]; then
    channel="$(gcloud beta --project "$GCP_PROJECT" monitoring channels create \
      --display-name "niho-finance ops email" --type email \
      --channel-labels "email_address=$ALERT_EMAIL" --format='value(name)')"
  fi
  ensure_alert_policy "$REPO_ROOT/ops/monitoring/job-failed.json" "$channel"
  ensure_alert_policy "$REPO_ROOT/ops/monitoring/cloud-run-5xx.json" "$channel"
  log "access: done. Open $(service_url "$WEB_SERVICE") with an allowed account."
}

case "$phase" in
  resources) resources ;;
  access) access ;;
  all) resources; access ;;
esac
