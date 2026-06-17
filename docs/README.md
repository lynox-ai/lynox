# lynox Documentation

One system that learns your business — connects any API, orchestrates your workflows, researches the web, and monitors for changes.

**Live site:** [docs.lynox.ai](https://docs.lynox.ai)

## Development

```bash
cd docs
pnpm install
pnpm dev        # Start dev server at localhost:4321
pnpm build      # Build static site
pnpm preview    # Preview production build
```

## Structure

```
docs/
├── astro.config.mjs        # Starlight config (autogenerate sidebar, branding)
├── src/
│   ├── content/
│   │   └── docs/           # All documentation, organized by category
│   │       ├── index.mdx          # Landing page
│   │       ├── getting-started/
│   │       ├── daily-use/
│   │       ├── features/
│   │       ├── setup/
│   │       ├── developers/
│   │       ├── integrations/
│   │       └── archive/
│   ├── assets/             # Logo, images
│   └── styles/
│       └── custom.css      # lynox brand colors
└── public/                 # Static files (favicon, etc.)
```

## Adding a new page

1. Drop a `.md` file into the right category dir under `src/content/docs/`
2. Add frontmatter: `title`, `description`, and `sidebar.order`
3. The sidebar is `autogenerate` — no manual `astro.config.mjs` edit needed

## Deployment

Built and deployed to Cloudflare Pages on push to `main`.
