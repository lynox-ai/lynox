# nodyn Documentation

The AI that knows your business — persistent knowledge, autonomous workflows, tool connections.

**Live site:** [docs.nodyn.dev](https://docs.nodyn.dev)

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
├── astro.config.mjs        # Starlight config (sidebar, branding)
├── src/
│   ├── content/
│   │   └── docs/           # All documentation (Markdown)
│   │       ├── index.mdx   # Landing page
│   │       ├── getting-started.md
│   │       ├── architecture.md
│   │       └── ...
│   ├── assets/             # Logo, images
│   └── styles/
│       └── custom.css      # nodyn brand colors
└── public/                 # Static files (favicon, etc.)
```

## Adding a new page

1. Create a `.md` file in `src/content/docs/`
2. Add frontmatter: `title` and `description`
3. Add the slug to the sidebar in `astro.config.mjs`

## Deployment

Built and deployed to Cloudflare Pages on push to `main`.
