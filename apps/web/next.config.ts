import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@niho-finance/db", "@niho-finance/ledger", "@niho-finance/reports"],
  poweredByHeader: false,
  // `next dev` would otherwise write apps/web/AGENTS.md when it detects an AI agent;
  // agent instructions for this repository live in the root AGENTS.md.
  agentRules: false,
};

export default nextConfig;
