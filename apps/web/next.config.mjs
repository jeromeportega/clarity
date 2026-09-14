/** @type {import('next').NextConfig} */
const nextConfig = {
  // modules/finance/core is plain TypeScript imported directly by route handlers.
  transpilePackages: ['@clarity/finance'],
  // instrumentation.ts (the startup env check) only runs on Next 14 with this flag.
  experimental: { instrumentationHook: true },
};

export default nextConfig;
