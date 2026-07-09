/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Correctness is gated by `tsc --noEmit` + the vitest suite (see package.json).
  // ESLint (next/typescript) flags intentional `any`s in the thin GHL API wrappers;
  // don't let those style rules block production builds. `npm run lint` still reports them.
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
