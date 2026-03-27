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
        { label: 'Getting Started', autogenerate: { directory: 'getting-started' } },
        { label: 'Daily Use', autogenerate: { directory: 'daily-use' } },
        { label: 'Features', autogenerate: { directory: 'features' } },
        { label: 'For Developers', autogenerate: { directory: 'developers' } },
      ],
    }),
  ],
});
