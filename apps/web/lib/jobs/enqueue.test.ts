import { describe, expect, it } from "vitest";
import { cloudTasksRequest, enqueueJob, taskQueueConfig, type TaskQueueConfig } from "./enqueue";

const CONFIG: TaskQueueConfig = {
  queue: "projects/example-project/locations/asia-northeast1/queues/example-queue",
  jobUrl: "https://jobs.example.test",
  serviceAccount: "scheduler@example-project.iam.gserviceaccount.com",
};

const BODY = {
  requestId: "01JEXAMPLE00000000000000AB",
  fiscalYearId: "fy-example",
  includeDocuments: true,
  requestedBy: "owner@example.com",
};

describe("cloudTasksRequest", () => {
  it("posts to the queue's tasks with the scheduler's OIDC token for the jobs service", () => {
    const request = cloudTasksRequest(CONFIG, {
      path: "/api/jobs/handover-package",
      body: BODY,
      taskId: "handover-01JEXAMPLE00000000000000AB",
    });
    expect(request.url).toBe(
      "https://cloudtasks.googleapis.com/v2/projects/example-project/locations/asia-northeast1/queues/example-queue/tasks",
    );
    const { task } = request.body;
    expect(task.name).toBe(`${CONFIG.queue}/tasks/handover-01JEXAMPLE00000000000000AB`);
    expect(task.dispatchDeadline).toBe("900s");
    expect(task.httpRequest).toMatchObject({
      url: "https://jobs.example.test/api/jobs/handover-package",
      httpMethod: "POST",
      headers: { "Content-Type": "application/json" },
      oidcToken: {
        serviceAccountEmail: CONFIG.serviceAccount,
        audience: "https://jobs.example.test",
      },
    });
    expect(JSON.parse(Buffer.from(task.httpRequest.body, "base64").toString("utf8"))).toEqual(BODY);
  });

  it("refuses paths outside the jobs and malformed task ids", () => {
    expect(() => cloudTasksRequest(CONFIG, { path: "/settings", body: {} })).toThrow();
    expect(() =>
      cloudTasksRequest(CONFIG, { path: "/api/jobs/handover-package", body: {}, taskId: "a/b" }),
    ).toThrow();
    expect(cloudTasksRequest(CONFIG, { path: "/api/jobs/x", body: {} }).body.task.name).toBe(
      undefined,
    );
  });
});

describe("taskQueueConfig", () => {
  it("needs the queue, the jobs URL and the service account", () => {
    expect(
      taskQueueConfig({
        NIHO_FINANCE_TASKS_QUEUE: undefined,
        NIHO_FINANCE_JOB_URL: CONFIG.jobUrl,
        NIHO_FINANCE_JOB_SERVICE_ACCOUNT: CONFIG.serviceAccount,
      }),
    ).toBeNull();
    expect(
      taskQueueConfig({
        NIHO_FINANCE_TASKS_QUEUE: CONFIG.queue,
        NIHO_FINANCE_JOB_URL: `${CONFIG.jobUrl}/`,
        NIHO_FINANCE_JOB_SERVICE_ACCOUNT: CONFIG.serviceAccount,
      }),
    ).toEqual(CONFIG);
    expect(() =>
      taskQueueConfig({
        NIHO_FINANCE_TASKS_QUEUE: "example-queue",
        NIHO_FINANCE_JOB_URL: CONFIG.jobUrl,
        NIHO_FINANCE_JOB_SERVICE_ACCOUNT: CONFIG.serviceAccount,
      }),
    ).toThrow(/projects\/<project>/);
  });
});

describe("enqueueJob", () => {
  it("sends the request with the access token and reports a refusal", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;
    const accessToken = () => Promise.resolve("example-token");
    await enqueueJob(
      CONFIG,
      { path: "/api/jobs/handover-package", body: BODY },
      { accessToken, fetch: fakeFetch },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toMatch(/queues\/example-queue\/tasks$/);
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      "Bearer example-token",
    );

    const refusing = (() =>
      Promise.resolve(
        new Response("permission denied", { status: 403 }),
      )) as unknown as typeof fetch;
    await expect(
      enqueueJob(
        CONFIG,
        { path: "/api/jobs/handover-package", body: BODY },
        { accessToken, fetch: refusing },
      ),
    ).rejects.toThrow(/403/);
  });
});
