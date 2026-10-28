#!/usr/bin/env bash
# Deploys the current HEAD to Cloud Run (docs/ops/deploy.md §4):
#   1. Cloud Build builds the runtime and migrate images (cloudbuild.yaml), tagged with the git SHA
#   2. the migrate job runs `prisma migrate deploy` + grants with the new image (stops on failure)
#   3. the web service (IAP) and the jobs service (IAM) are deployed with the new image
#   4. health check
# Usage: scripts/deploy.sh [--no-build] [--allow-dirty]
#   --no-build  redeploys the image that is serving now (picks up new secret versions; no build)
# Needs scripts/deploy.env (see deploy.env.example) and a gcloud login with access to the project.
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"
load_deploy_env
cd "$REPO_ROOT" || exit 1

build=1
allow_dirty=0
for arg in "$@"; do
  case "$arg" in
    --no-build) build=0 ;;
    --allow-dirty) allow_dirty=1 ;;
    *) die "unknown option: $arg" ;;
  esac
done

if [[ $build -eq 1 ]]; then
  TAG="$(git rev-parse --short=12 HEAD)"
  if [[ -n "$(git status --porcelain)" ]]; then
    [[ $allow_dirty -eq 1 ]] || die "the worktree has uncommitted changes (deploy what is committed, or pass --allow-dirty)"
    TAG="$TAG-dirty"
  fi
else
  serving="$(gcp run services describe "$WEB_SERVICE" --region "$GCP_REGION" \
    --format='value(spec.template.spec.containers[0].image)')"
  [[ "$serving" == "$IMAGE:"* ]] || die "$WEB_SERVICE is not serving an image of $IMAGE (first deploy needs a build)"
  TAG="${serving#"$IMAGE:"}"
fi
CONNECTION="$(cloudsql_connection_name)"
SECRETS="DATABASE_URL=$SECRET_DATABASE_URL:latest,NIHO_FINANCE_SMTP_PASSWORD=$SECRET_SMTP_PASSWORD:latest"
SECRETS+="$(stripe_key_secrets)"
WEB_URL="$(service_url "$WEB_SERVICE")"
JOBS_URL="$(service_url "$JOBS_SERVICE")"

if [[ $build -eq 1 ]]; then
  log "build $IMAGE:$TAG (Cloud Build)"
  gcp builds submit --config cloudbuild.yaml --substitutions="_IMAGE=$IMAGE,_TAG=$TAG" .
else
  log "no build: redeploying the serving image $IMAGE:$TAG"
fi

log "migrate: run job $MIGRATE_JOB with $IMAGE-migrate:$TAG"
gcp run jobs deploy "$MIGRATE_JOB" \
  --region "$GCP_REGION" \
  --image "$IMAGE-migrate:$TAG" \
  --service-account "$RUNNER_SA_EMAIL" \
  --set-cloudsql-instances "$CONNECTION" \
  --network "$VPC_NETWORK" --subnet "$VPC_SUBNET" --vpc-egress private-ranges-only \
  --set-secrets "DATABASE_URL=$SECRET_MIGRATE_DATABASE_URL:latest,NIHO_FINANCE_APP_DATABASE_URL=$SECRET_DATABASE_URL:latest" \
  --max-retries 0 --task-timeout 20m --memory 1Gi --labels "$COST_LABEL" \
  --execute-now --wait

deploy_service() {
  local service="$1" role="$2"
  shift 2
  log "deploy $service ($role) with $IMAGE:$TAG"
  gcp run deploy "$service" \
    --region "$GCP_REGION" \
    --image "$IMAGE:$TAG" \
    --service-account "$RUNNER_SA_EMAIL" \
    --no-allow-unauthenticated \
    --min-instances 0 --max-instances 1 \
    --cpu 1 --memory 1Gi --cpu-boost \
    --add-cloudsql-instances "$CONNECTION" \
    --network "$VPC_NETWORK" --subnet "$VPC_SUBNET" --vpc-egress private-ranges-only \
    --set-secrets "$SECRETS" \
    --set-env-vars "$(service_env_vars "$role" "$TAG")" \
    --labels "$COST_LABEL" \
    "$@"
}

# Web: people through IAP. The IAP flag is kept on by `gcp-bootstrap.sh access` (beta in gcloud 550),
# a plain deploy does not turn it off.
deploy_service "$WEB_SERVICE" web --ingress all --concurrency 20 --timeout 60

# Jobs: Cloud Scheduler only (internal ingress + run.invoker for the scheduler service account).
deploy_service "$JOBS_SERVICE" jobs --ingress internal --concurrency 1 --timeout 900
gcp run services add-iam-policy-binding "$JOBS_SERVICE" --region "$GCP_REGION" \
  --member "serviceAccount:$SCHEDULER_SA_EMAIL" --role roles/run.invoker > /dev/null

log "ready: web $WEB_URL (IAP), jobs $JOBS_URL (internal)"
for service in "$WEB_SERVICE" "$JOBS_SERVICE"; do
  gcp run services describe "$service" --region "$GCP_REGION" --format=json \
    | python3 -I -c 'import json, sys
conditions = json.load(sys.stdin).get("status", {}).get("conditions", [])
ready = [c for c in conditions if c.get("type") == "Ready"]
sys.exit(0 if ready and ready[0].get("status") == "True" else 1)' \
    || die "$service is not ready"
done
log "done: $TAG"
