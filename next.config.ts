import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Avoid picking a parent monorepo lockfile when one exists in the home directory
  outputFileTracingRoot: appDir,
};

export default nextConfig;
