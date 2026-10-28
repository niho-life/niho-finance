import path from "node:path";
import type { NextConfig } from "next";

// The monorepo root: workspace packages are traced into the standalone output from here.
const repoRoot = path.join(typeof __dirname === "string" ? __dirname : process.cwd(), "../../");

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@niho-finance/db", "@niho-finance/ledger", "@niho-finance/reports"],
  poweredByHeader: false,
  // `next dev` would otherwise write apps/web/AGENTS.md when it detects an AI agent;
  // agent instructions for this repository live in the root AGENTS.md.
  agentRules: false,
  // Cloud Run image (Dockerfile): `next build` writes a self-contained server to .next/standalone.
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  // PDF fonts are read from disk at run time (lib/pdf/font.ts), which tracing cannot see.
  outputFileTracingIncludes: { "/**": ["./lib/pdf/fonts/*.ttf"] },
};

export default nextConfig;
