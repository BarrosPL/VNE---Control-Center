import type { NextConfig } from 'next';
const config: NextConfig = {
  poweredByHeader: false,
  // O Next.js reescreve CLAUDE.md/AGENTS.md automaticamente em `next dev`; aqui esse arquivo e um
  // documento de governanca mantido manualmente.
  agentRules: false,
  experimental: { serverActions: { bodySizeLimit: '256kb' } },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Cache-Control', value: 'private, no-store' },
        ],
      },
    ];
  },
};
export default config;
