import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: [
    "@niho-finance/db",
    "@niho-finance/importers",
    "@niho-finance/ledger",
    "@niho-finance/reports",
  ],
  poweredByHeader: false,
  // `next dev` would otherwise write apps/web/AGENTS.md when it detects an AI agent;
  // agent instructions for this repository live in the root AGENTS.md.
  agentRules: false,
  experimental: {
    // A CSV file of up to 10 MB and the form around it reach the Server Actions (12-imports §1.2).
    serverActions: { bodySizeLimit: "11mb" },
  },
};

export default nextConfig;
