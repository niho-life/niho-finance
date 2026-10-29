import { appEnv, type AppEnv } from "../env";

/*
 * Jobs the screens start (受け渡しパッケージ, 14-reports §16.4): a Cloud Tasks HTTP task to the jobs
 * service, created with the REST API and the runtime's application default credentials. The task
 * carries the scheduler's OIDC token (audience = the jobs service's URL), so the job checks it like
 * Cloud Scheduler's (`verifyJobRequest`). The queue does not retry (S8 `niho-finance-manual`).
 */

const TASKS_API = "https://cloudtasks.googleapis.com/v2";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
/** The jobs service's timeout (docs/ops/deploy.md §4). */
const DISPATCH_DEADLINE = "900s";
const QUEUE_PATTERN = /^projects\/[^/]+\/locations\/[^/]+\/queues\/[^/]+$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,500}$/;

export interface TaskQueueConfig {
  /** `projects/<project>/locations/<region>/queues/<queue>` */
  queue: string;
  /** The jobs service's URL, without a trailing slash. */
  jobUrl: string;
  serviceAccount: string;
}

/** The queue settings, or `null` when the screens cannot start jobs (local development). */
export function taskQueueConfig(
  env: Pick<
    AppEnv,
    "NIHO_FINANCE_TASKS_QUEUE" | "NIHO_FINANCE_JOB_URL" | "NIHO_FINANCE_JOB_SERVICE_ACCOUNT"
  > = appEnv(),
): TaskQueueConfig | null {
  const queue = env.NIHO_FINANCE_TASKS_QUEUE;
  const jobUrl = env.NIHO_FINANCE_JOB_URL;
  const serviceAccount = env.NIHO_FINANCE_JOB_SERVICE_ACCOUNT;
  if (!queue || !jobUrl || !serviceAccount) return null;
  if (!QUEUE_PATTERN.test(queue)) {
    throw new Error(
      `NIHO_FINANCE_TASKS_QUEUE は projects/<project>/locations/<region>/queues/<queue> の形で設定してください`,
    );
  }
  return { queue, jobUrl: jobUrl.replace(/\/+$/, ""), serviceAccount };
}

export interface JobTask {
  /** `/api/jobs/<name>` */
  path: string;
  /** JSON body of the POST. */
  body: Record<string, unknown>;
  /** A task id unique per request (Cloud Tasks drops a second task with the same name). */
  taskId?: string;
}

export interface CloudTasksRequest {
  url: string;
  body: {
    task: {
      name?: string;
      dispatchDeadline: string;
      httpRequest: {
        url: string;
        httpMethod: "POST";
        headers: Record<string, string>;
        body: string;
        oidcToken: { serviceAccountEmail: string; audience: string };
      };
    };
  };
}

/** The `tasks.create` call for `task` (no network). */
export function cloudTasksRequest(config: TaskQueueConfig, task: JobTask): CloudTasksRequest {
  if (!task.path.startsWith("/api/jobs/")) throw new Error(`not a job path: ${task.path}`);
  if (task.taskId !== undefined && !TASK_ID_PATTERN.test(task.taskId)) {
    throw new Error(`invalid task id: ${task.taskId}`);
  }
  return {
    url: `${TASKS_API}/${config.queue}/tasks`,
    body: {
      task: {
        ...(task.taskId === undefined ? {} : { name: `${config.queue}/tasks/${task.taskId}` }),
        dispatchDeadline: DISPATCH_DEADLINE,
        httpRequest: {
          url: `${config.jobUrl}${task.path}`,
          httpMethod: "POST",
          headers: { "Content-Type": "application/json" },
          body: Buffer.from(JSON.stringify(task.body), "utf8").toString("base64"),
          oidcToken: { serviceAccountEmail: config.serviceAccount, audience: config.jobUrl },
        },
      },
    },
  };
}

export interface EnqueueOptions {
  /** Defaults to an access token from application default credentials. */
  accessToken?: () => Promise<string>;
  fetch?: typeof fetch;
}

async function defaultAccessToken(): Promise<string> {
  // Loaded on first use: local development never needs it.
  const { GoogleAuth } = await import("google-auth-library");
  const token = await new GoogleAuth({ scopes: [SCOPE] }).getAccessToken();
  if (!token) throw new Error("Cloud Tasks のアクセストークンを取得できませんでした");
  return token;
}

/** Creates the task. Throws with Cloud Tasks' status when it refuses (the caller records why). */
export async function enqueueJob(
  config: TaskQueueConfig,
  task: JobTask,
  options: EnqueueOptions = {},
): Promise<void> {
  const request = cloudTasksRequest(config, task);
  const token = await (options.accessToken ?? defaultAccessToken)();
  const response = await (options.fetch ?? fetch)(request.url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(request.body),
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Cloud Tasks がタスクを受け付けませんでした（${response.status}）: ${detail}`);
  }
}
