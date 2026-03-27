import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://docs.lynox.dev',
  integrations: [
    starlight({
      title: 'lynox',
      description: 'One system that learns your business — replaces your CRM, workflows, outreach, and monitoring.',
      logo: {
        src: './src/assets/logo.svg',
        replacesTitle: false,
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/lynox-ai/lynox' },
      ],
      editLink: {
        baseUrl: 'https://github.com/lynox-ai/lynox/edit/main/docs/',
      },
      customCss: ['./src/styles/custom.css'],
      head: [
        {
          tag: 'script',
          content: `document.addEventListener('DOMContentLoaded', () => {
            const link = document.querySelector('.site-title');
            if (link) link.href = 'https://lynox.dev';
          });`,
        },
      ],
      lastUpdated: true,
      pagination: true,
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { slug: 'getting-started' },
          ],
        },
        {
          label: 'Daily Use',
          items: [
            { slug: 'telegram' },
            { slug: 'google-workspace' },
            { slug: 'docker' },
            { slug: 'configuration' },
          ],
        },
        {
          label: 'Features',
          items: [
            { slug: 'memory' },
            { slug: 'crm' },
            { slug: 'api-store' },
            { slug: 'backup' },
            { slug: 'security' },
          ],
        },
        {
          label: 'For Developers',
          items: [
            { slug: 'architecture' },
            { slug: 'agent-loop' },
            { slug: 'tools' },
            { slug: 'cli' },
            { slug: 'dag-engine' },
            { slug: 'pre-approve' },
            { slug: 'mcp-server' },
            { slug: 'extension-points' },
            { slug: 'slack' },
            { slug: 'sdk' },
            { slug: 'batch-api' },
            { slug: 'sentry' },
            { slug: 'ci' },
            { slug: 'benchmarks' },
          ],
        },
      ],
    }),
  ],
});
