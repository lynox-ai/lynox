# Contributing to nodyn

Thanks for your interest in contributing to nodyn.

## Getting Started

```bash
git clone https://github.com/nodyn-ai/nodyn.git
cd nodyn
npm install
npm run dev
```

Requirements: Node.js 22+.

## Development Workflow

```bash
npm run dev          # Watch mode with hot reload
npm run typecheck    # tsc --noEmit — must pass with zero errors
npm run lint         # eslint src/ — must pass with zero errors
npm run build        # tsc → dist/
npx vitest run       # 113 files / ~2610 tests — all must pass
npm run coverage     # coverage report (CI enforces ≥80%)
```

Run a single test file:

```bash
npx vitest run src/core/memory.test.ts
```

### Git hooks

nodyn uses [lefthook](https://github.com/evilmartians/lefthook) for pre-commit (typecheck) and pre-push (secret scanning via [gitleaks](https://github.com/gitleaks/gitleaks)). Install both before contributing:

```bash
brew install lefthook gitleaks
```

Hooks are auto-installed by `npm install` via the `prepare` script.

## Code Standards

- **ESM-only** — All imports use `.js` extensions
- **TypeScript strict mode** — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`
- **Zero `any`** — Use `unknown` plus type narrowing (catch variables are `unknown`)
- **ESLint enforced** — `npm run lint` must pass. Rules in `eslint.config.js`: no-explicit-any, no-floating-promises, consistent-type-imports, no-unused-vars, eqeqeq, no-console, no-eval
- **Single type source** — All types live in `src/types/index.ts`
- **Co-located tests** — `*.test.ts` next to source files

## Pull Requests

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes
4. Ensure `npm run typecheck`, `npm run lint`, and `npx vitest run` pass
5. Open a PR with a clear description of what and why

Keep PRs focused — one concern per PR.

## Commit Messages

- English, imperative mood: "Add ...", "Fix ...", "Update ..."
- First line under 70 characters
- Reference issues where applicable

## Understanding the Codebase

See [docs/architecture.md](docs/architecture.md) for the module map, data flow, and design decisions.

## Reporting Bugs

Open a [GitHub issue](https://github.com/nodyn-ai/nodyn/issues) with:
- Steps to reproduce
- Expected vs actual behavior
- Node.js version and OS

For security vulnerabilities, see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the [Elastic License 2.0](LICENSE).
