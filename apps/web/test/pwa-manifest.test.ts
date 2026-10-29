import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * The home-screen app's manifest and icons (10 §1.1, the decision of 2026-10-29): static files in
 * `public/`, read here as the browser gets them.
 */

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

const manifest = JSON.parse(readFileSync(path.join(publicDir, "app.webmanifest"), "utf8")) as {
  [key: string]: unknown;
  icons: ManifestIcon[];
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The size, the colour type and the chunk types of a PNG file (IHDR is the first chunk). */
function pngInfo(file: string): {
  width: number;
  height: number;
  colorType: number;
  chunks: string[];
} {
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  // Each chunk: length (4) · type (4) · data (length) · CRC (4).
  const chunks: string[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    chunks.push(bytes.toString("latin1", offset + 4, offset + 8));
    offset += 12 + bytes.readUInt32BE(offset);
  }
  expect(chunks[0]).toBe("IHDR");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes.readUInt8(25),
    chunks,
  };
}

/** Colour types 4 and 6 carry alpha; a tRNS chunk makes the others transparent. */
function isOpaque(info: { colorType: number; chunks: string[] }): boolean {
  return info.colorType !== 4 && info.colorType !== 6 && !info.chunks.includes("tRNS");
}

const fileOf = (src: string) => path.join(publicDir, ...src.split("/").filter(Boolean));

describe("app.webmanifest", () => {
  it("opens ホーム in a standalone window on Chrome and in Safari on iOS", () => {
    expect(manifest).toMatchObject({
      id: "/",
      name: "NIHO finance",
      short_name: "NIHO finance",
      lang: "ja",
      start_url: "/",
      scope: "/",
      display: "browser",
      display_override: ["standalone"],
    });
    expect(typeof manifest.description).toBe("string");
  });

  it("is white (D14)", () => {
    expect(manifest.background_color).toBe("#ffffff");
    expect(manifest.theme_color).toBe("#ffffff");
  });

  it("declares 192px and 512px icons and a maskable one", () => {
    expect(manifest.icons.map((icon) => `${icon.sizes} ${icon.purpose}`)).toEqual([
      "192x192 any",
      "512x512 any",
      "512x512 maskable",
    ]);
    for (const icon of manifest.icons) expect(icon.type).toBe("image/png");
  });

  it("points at icons that exist with the declared sizes", () => {
    for (const icon of manifest.icons) {
      const file = fileOf(icon.src);
      expect(existsSync(file), icon.src).toBe(true);
      const { width, height } = pngInfo(file);
      expect(`${width}x${height}`, icon.src).toBe(icon.sizes);
    }
  });
});

describe("icons", () => {
  it("keeps the original as icon.svg", () => {
    const svg = readFileSync(path.join(publicDir, "icons/icon.svg"), "utf8");
    expect(svg).toContain('viewBox="0 0 512 512"');
    // Drawn with shapes: no text, so no font is needed.
    expect(svg).not.toMatch(/<text\b/);
  });

  it("has an opaque 180px apple-touch-icon", () => {
    const info = pngInfo(path.join(publicDir, "icons/apple-touch-icon.png"));
    expect(info.width).toBe(180);
    expect(info.height).toBe(180);
    expect(isOpaque(info)).toBe(true);
  });

  it("fills the maskable icon to the edges", () => {
    expect(isOpaque(pngInfo(path.join(publicDir, "icons/maskable-512.png")))).toBe(true);
  });
});
