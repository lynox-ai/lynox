import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://docs.nodyn.dev',
  integrations: [
    starlight({
      title: 'nodyn',
      description: 'The AI that knows your business — persistent knowledge, autonomous workflows, tool connections.',
      logo: {
        src: './src/assets/logo.svg',
        replacesTitle: false,
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/nodyn-ai/nodyn' },
      ],
      editLink: {
        baseUrl: 'https://github.com/nodyn-ai/nodyn/edit/main/docs/',
      },
      customCss: ['./src/styles/custom.css'],
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
          label: 'Core Concepts',
          items: [
            { slug: 'architecture' },
            { slug: 'agent-loop' },
            { slug: 'memory' },
            { slug: 'tools' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { slug: 'cli' },
            { slug: 'configuration' },
            { slug: 'dag-engine' },
            { slug: 'pre-approve' },
            { slug: 'crm' },
            { slug: 'api-store' },
          ],
        },
        {
          label: 'Integrations',
          items: [
            { slug: 'telegram' },
            { slug: 'google-workspace' },
            { slug: 'mcp-server' },
            { slug: 'slack' },
            { slug: 'extension-points' },
          ],
        },
        {
          label: 'Operations',
          items: [
            { slug: 'docker' },
            { slug: 'backup' },
            { slug: 'security' },
            { slug: 'sentry' },
            { slug: 'ci' },
          ],
        },
        {
          label: 'Advanced',
          items: [
            { slug: 'sdk' },
            { slug: 'batch-api' },
            { slug: 'benchmarks' },
          ],
        },
      ],
    }),
  ],
});
