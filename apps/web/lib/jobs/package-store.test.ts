import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalPackageStore, packageKey, packageStoreFromEnv } from "./package-store";

describe("packageKey", () => {
  it("is packages/<JST stamp>_fy<n>_<requestId>.zip", () => {
    expect(packageKey(new Date("2027-05-10T05:03:12Z"), 1, "01JEXAMPLE00000000000000AB")).toBe(
      "packages/20270510-140312_fy1_01JEXAMPLE00000000000000AB.zip",
    );
  });
});

describe("local package store", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "handover-store-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a package in chunks, returns it, and never replaces it", async () => {
    const store = createLocalPackageStore(dir);
    const key = packageKey(new Date("2027-05-10T05:03:12Z"), 1, "01JEXAMPLE00000000000000AB");
    const writer = await store.openWriter(key);
    await writer.write(new Uint8Array([0x50, 0x4b]));
    await writer.write(new Uint8Array(200_000).fill(7));
    await writer.close();
    const response = await store.downloadResponse(key, "handover_fy1_20261102-20270331.zip");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toContain(
      'filename="handover_fy1_20261102-20270331.zip"',
    );
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.byteLength).toBe(200_002);
    expect([...body.slice(0, 2)]).toEqual([0x50, 0x4b]);
    await expect(store.openWriter(key)).rejects.toThrow();
  });

  it("drops a partial file on abort and refuses keys outside packages/", async () => {
    const store = createLocalPackageStore(dir);
    const key = packageKey(new Date("2027-05-10T06:00:00Z"), 2, "01JEXAMPLE00000000000000CD");
    const writer = await store.openWriter(key);
    await writer.write(new Uint8Array([1, 2, 3]));
    await writer.abort(new Error("stop"));
    expect(await readdir(path.join(dir, "packages"))).not.toContain(path.basename(key));
    await expect(store.openWriter("../outside.zip")).rejects.toThrow(RangeError);
    await expect(store.openWriter("packages/../../x.zip")).rejects.toThrow(RangeError);
  });

  it("needs a bucket or a folder", () => {
    expect(() =>
      packageStoreFromEnv({
        NIHO_FINANCE_BACKUP_BUCKET: undefined,
        NIHO_FINANCE_BACKUP_DIR: undefined,
      }),
    ).toThrow(/置き場所がありません/);
    expect(
      packageStoreFromEnv({ NIHO_FINANCE_BACKUP_BUCKET: undefined, NIHO_FINANCE_BACKUP_DIR: dir })
        .kind,
    ).toBe("local");
  });
});
