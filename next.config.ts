import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prisma's query engine and LangChain must stay server-side; never bundle into client code.
  serverExternalPackages: ["@prisma/client", "prisma"],
};

export default nextConfig;
