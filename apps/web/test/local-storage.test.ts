import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalDocumentStorage,
  LOCAL_UPLOAD_PATH,
  signUploadToken,
  verifyUploadToken,
  type LocalDocumentStorage,
} from "@/lib/storage/local";
import { newDocumentKey } from "@/lib/storage/keys";
import { StoredFileExistsError, StoredFileNotFoundError } from "@/lib/storage/types";

const secret = "test-upload-secret";
const now = new Date("2026-11-07T01:00:00.000Z");
const pdf = new TextEncoder().encode("%PDF-1.7\n% fictional receipt\n%%EOF\n");

describe("local document storage", () => {
  let rootDir: string;
  let storage: LocalDocumentStorage;

  beforeAll(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "niho-finance-storage-"));
    storage = createLocalDocumentStorage({ rootDir, secret, now: () => now });
  });

  afterAll(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("writes a file under its key and reads it back", async () => {
    const key = newDocumentKey("application/pdf", now);
    expect(await storage.stat(key)).toBeNull();
    await storage.write(key, pdf, "application/pdf");
    expect(await storage.stat(key)).toEqual({ byteSize: pdf.byteLength });
    expect(await storage.read(key)).toEqual(pdf);
    expect(await readFile(path.join(rootDir, ...key.split("/")))).toEqual(Buffer.from(pdf));
    // Nothing is left under a temporary name.
    const dir = path.dirname(path.join(rootDir, ...key.split("/")));
    expect(await readdir(dir)).toEqual([path.basename(key)]);
  });

  it("never overwrites a stored file", async () => {
    const key = newDocumentKey("text/csv", now);
    const first = new TextEncoder().encode("日付,金額\r\n");
    await storage.write(key, first, "text/csv");
    await expect(storage.write(key, pdf, "text/csv")).rejects.toBeInstanceOf(StoredFileExistsError);
    expect(await storage.read(key)).toEqual(first);
  });

  it("reports a missing file", async () => {
    const key = newDocumentKey("image/png", now);
    await expect(storage.read(key)).rejects.toBeInstanceOf(StoredFileNotFoundError);
    await expect(
      storage.fileResponse(key, { mime: "image/png", filename: "x.png" }),
    ).rejects.toBeInstanceOf(StoredFileNotFoundError);
  });

  it("refuses keys outside documents/ or with traversal", async () => {
    for (const key of [
      "../outside.pdf",
      "documents/../../outside.pdf",
      "documents//2026/x.pdf",
      "documents/2026/.hidden",
      "documents/2026/a..b.pdf",
      "documents\\2026\\x.pdf",
      "/documents/2026/x.pdf",
      "other/2026/x.pdf",
      "documents",
    ]) {
      await expect(storage.write(key, pdf, "application/pdf"), key).rejects.toBeInstanceOf(
        RangeError,
      );
      await expect(storage.stat(key), key).rejects.toBeInstanceOf(RangeError);
      await expect(
        storage.createUploadTarget({ key, mime: "application/pdf", byteSize: 1 }),
        key,
      ).rejects.toBeInstanceOf(RangeError);
    }
  });

  it("serves the bytes inline with the file name, uncached and unsniffed", async () => {
    const key = newDocumentKey("application/pdf", now);
    await storage.write(key, pdf, "application/pdf");
    const response = await storage.fileResponse(key, {
      mime: "application/pdf",
      filename: "領収書 (11月).pdf",
    });
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "application/pdf",
      "content-length": String(pdf.byteLength),
      "content-disposition":
        "inline; filename*=UTF-8''%E9%A0%98%E5%8F%8E%E6%9B%B8%20%2811%E6%9C%88%29.pdf",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(pdf);
  });

  describe("upload URLs", () => {
    async function target(key = newDocumentKey("image/jpeg", now)) {
      const upload = await storage.createUploadTarget({ key, mime: "image/jpeg", byteSize: 1234 });
      return { key, upload, url: new URL(upload.url, "http://localhost") };
    }

    it("signs key, type, size and expiry for 15 minutes", async () => {
      const { key, upload, url } = await target();
      expect(url.pathname).toBe(LOCAL_UPLOAD_PATH);
      expect(upload).toMatchObject({ method: "PUT", headers: { "Content-Type": "image/jpeg" } });
      expect(upload.expiresAt.toISOString()).toBe("2026-11-07T01:15:00.000Z");
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        key,
        mime: "image/jpeg",
        size: "1234",
      });
      expect(storage.verifyUpload(url.searchParams)).toEqual({
        ok: true,
        fields: { key, mime: "image/jpeg", size: 1234, exp: upload.expiresAt.getTime() / 1000 },
      });
    });

    it("rejects an expired URL", async () => {
      const { url } = await target();
      expect(storage.verifyUpload(url.searchParams, new Date("2026-11-07T01:15:01.000Z"))).toEqual({
        ok: false,
        reason: "expired",
      });
    });

    it("rejects a changed key, type, size, expiry or signature", async () => {
      const { url } = await target();
      const tampered: [string, string][] = [
        ["key", newDocumentKey("image/jpeg", now)],
        ["mime", "application/pdf"],
        ["size", "99999"],
        ["exp", String(Number(url.searchParams.get("exp")) + 3600)],
        ["sig", "0".repeat(64)],
        ["sig", "not-hex"],
      ];
      for (const [name, value] of tampered) {
        const params = new URLSearchParams(url.searchParams);
        params.set(name, value);
        expect(storage.verifyUpload(params), name).toEqual({ ok: false, reason: "invalid" });
      }
      const missing = new URLSearchParams(url.searchParams);
      missing.delete("sig");
      expect(storage.verifyUpload(missing)).toEqual({ ok: false, reason: "invalid" });
      // Another process's secret does not verify.
      expect(verifyUploadToken(url.searchParams, "another-secret", now)).toEqual({
        ok: false,
        reason: "invalid",
      });
    });

    it("rejects a validly signed but unsafe key", () => {
      const fields = {
        key: "documents/../x.pdf",
        mime: "application/pdf",
        size: 1,
        exp: 1_900_000_000,
      };
      const params = new URLSearchParams({
        key: fields.key,
        mime: fields.mime,
        size: "1",
        exp: String(fields.exp),
        sig: signUploadToken(fields, secret),
      });
      expect(verifyUploadToken(params, secret, now)).toEqual({ ok: false, reason: "invalid" });
    });
  });
});
