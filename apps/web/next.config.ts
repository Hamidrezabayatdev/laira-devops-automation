import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@liara/domain', '@liara/security'],
};

export default nextConfig;
