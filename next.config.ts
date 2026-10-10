import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prisma's query engine and LangChain must stay server-side; never bundle into client code.
  serverExternalPackages: ["@prisma/client", "prisma"],
  // The in-memory backend reads the seed CSVs at runtime; make sure deployments ship them.
  outputFileTracingIncludes: {
    "/api/**/*": ["./data/seed/**/*"],
  },
};

export default nextConfig;
