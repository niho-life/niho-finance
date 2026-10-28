#!/usr/bin/env bash
# Runs one job of the jobs service now and prints its result (docs/ops/deploy.md §6).
#   scripts/run-job.sh mail-check | backup | calendar | stripe-sync
# The jobs service only takes internal callers, so the request goes through a Cloud Tasks queue
# with the scheduler's OIDC identity (like Cloud Scheduler does); then the job's `job.finished`
# log line is awaited (up to 5 minutes). Needs scripts/deploy.env and a gcloud login.
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"
load_deploy_env

case "${1:-}" in
  mail-check) job=mail-check ;;
  backup) job=backup-export ;;
  calendar) job=calendar-notify ;;
  stripe-sync) job=stripe-sync ;;
  *) die "usage: $0 mail-check|backup|calendar|stripe-sync" ;;
esac
path="$1"
jobs_url="$(service_url "$JOBS_SERVICE")"
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

gcp tasks create-http-task --queue "$TASKS_QUEUE" --location "$GCP_REGION" \
  --url "$jobs_url/api/jobs/$path" --method POST \
  --oidc-service-account-email "$SCHEDULER_SA_EMAIL" --oidc-token-audience "$jobs_url" > /dev/null
log "queued $job; waiting for its result"

filter="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$JOBS_SERVICE\""
filter+=" AND jsonPayload.event=\"job.finished\" AND jsonPayload.job=\"$job\" AND timestamp>=\"$since\""
for _ in $(seq 1 30); do
  sleep 10
  result="$(gcp logging read "$filter" --limit 1 --format=json)"
  if [[ "$result" != "[]" && -n "$result" ]]; then
    printf '%s' "$result" | python3 -I -c '
import json, sys
entry = json.load(sys.stdin)[0]["jsonPayload"]
fields = {k: v for k, v in entry.items() if k not in ("message", "event", "severity", "time")}
print(json.dumps(fields, ensure_ascii=False))
sys.exit(0 if entry.get("ok") else 1)'
    exit $?
  fi
done
die "no result for $job within 5 minutes (see the logs of $JOBS_SERVICE)"
