import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://docs.lynox.ai',
  integrations: [
    starlight({
      title: 'lynox',
      description: 'Run your business. Not your tools.',
      logo: {
        light: './src/assets/logo-light.svg',
        dark: './src/assets/logo-dark.svg',
        replacesTitle: true,
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
          attrs: { is: 'inline' },
          content: `if (!localStorage.getItem('starlight-theme')) {
            document.documentElement.setAttribute('data-theme', 'dark');
            localStorage.setItem('starlight-theme', 'dark');
          }`,
        },
        {
          tag: 'script',
          content: `document.addEventListener('DOMContentLoaded', () => {
            const link = document.querySelector('.site-title');
            if (link) link.href = 'https://lynox.ai';
          });`,
        },
      ],
      lastUpdated: true,
      pagination: true,
      sidebar: [
        { label: 'Getting Started', autogenerate: { directory: 'getting-started' } },
        { label: 'Daily Use', autogenerate: { directory: 'daily-use' } },
        { label: 'Integrations', autogenerate: { directory: 'integrations' } },
        { label: 'Features', autogenerate: { directory: 'features' } },
        { label: 'For Developers', autogenerate: { directory: 'developers' } },
      ],
    }),
  ],
});
