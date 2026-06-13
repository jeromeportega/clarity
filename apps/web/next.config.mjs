/** @type {import('next').NextConfig} */
const nextConfig = {
  // modules/finance/core is plain TypeScript imported directly by route handlers.
  transpilePackages: ['@clarity/finance'],
};

export default nextConfig;
