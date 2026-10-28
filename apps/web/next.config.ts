import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@niho-finance/db", "@niho-finance/ledger"],
  // The GCS client (evidence files, lib/storage/gcs.ts) is Node-only and loaded on first use:
  // keep it out of the server bundle and load it from node_modules.
  serverExternalPackages: ["@google-cloud/storage"],
  poweredByHeader: false,
  // `next dev` would otherwise write apps/web/AGENTS.md when it detects an AI agent;
  // agent instructions for this repository live in the root AGENTS.md.
  agentRules: false,
};

export default nextConfig;
