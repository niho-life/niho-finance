import { generateKeyPairSync } from "node:crypto";
import { Storage } from "@google-cloud/storage";
import { describe, expect, it } from "vitest";
import { createGcsDocumentStorage } from "@/lib/storage/gcs";

// Signed URLs are computed locally from a service account key, so they can be checked without a
// bucket or network. Everything here is fictional (a throwaway key, example names).
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const client = new Storage({
  projectId: "example-project",
  credentials: {
    client_email: "uploader@example-project.iam.gserviceaccount.com",
    private_key: privateKey,
  },
});
const storage = createGcsDocumentStorage({
  bucket: "example-documents",
  bucketClient: () => client.bucket("example-documents"),
});
const key = "documents/2026/11/01HZY3V5Q8XK0W6M2N4P7R9T1C.png";

describe("GCS document storage (signed URLs)", () => {
  it("signs a V4 PUT URL bound to the content type, valid for 15 minutes", async () => {
    const before = Date.now();
    const target = await storage.createUploadTarget({ key, mime: "image/png", byteSize: 203 });
    const url = new URL(target.url);
    expect(url.origin).toBe("https://storage.googleapis.com");
    expect(url.pathname).toBe(`/example-documents/${key}`);
    expect(url.searchParams.get("X-Goog-Algorithm")).toBe("GOOG4-RSA-SHA256");
    expect(url.searchParams.get("X-Goog-SignedHeaders")).toBe("content-type;host");
    expect(Number(url.searchParams.get("X-Goog-Expires"))).toBeGreaterThanOrEqual(899);
    expect(Number(url.searchParams.get("X-Goog-Expires"))).toBeLessThanOrEqual(900);
    expect(url.searchParams.get("X-Goog-Signature")).toMatch(/^[0-9a-f]{512}$/);
    expect(target).toMatchObject({ method: "PUT", headers: { "Content-Type": "image/png" } });
    expect(target.expiresAt.getTime() - before).toBeGreaterThanOrEqual(15 * 60 * 1000 - 1000);
  });

  it("redirects a read to a 10-minute signed GET URL with the file name and type", async () => {
    const response = await storage.fileResponse(key, {
      mime: "image/png",
      filename: "領収書 11月.png",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const url = new URL(response.headers.get("Location") ?? "");
    expect(url.pathname).toBe(`/example-documents/${key}`);
    expect(Number(url.searchParams.get("X-Goog-Expires"))).toBeLessThanOrEqual(600);
    expect(url.searchParams.get("response-content-type")).toBe("image/png");
    expect(url.searchParams.get("response-content-disposition")).toBe(
      `inline; filename*=UTF-8''${encodeURIComponent("領収書 11月.png")}`,
    );
  });

  it("refuses keys outside documents/ before calling GCS", async () => {
    await expect(
      storage.createUploadTarget({ key: "../secrets.png", mime: "image/png", byteSize: 1 }),
    ).rejects.toThrow(/unsafe document key/);
    await expect(storage.stat("documents/../x.png")).rejects.toThrow(/unsafe document key/);
  });
});
