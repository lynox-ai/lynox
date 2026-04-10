# Contributing to lynox

Thanks for your interest in lynox!

## Current Status

lynox is developed by a small, focused team. We are **not accepting external pull requests** at this time. This lets us move fast and keep the architecture coherent while the project is still young.

## How You Can Help

- **Report bugs** — Open a [GitHub issue](https://github.com/lynox-ai/lynox/issues) with steps to reproduce, expected vs actual behavior, and your Node.js version / OS.
- **Request features** — Open an issue describing your use case. We read every one.
- **Security vulnerabilities** — See [SECURITY.md](SECURITY.md) for responsible disclosure.

## Internal Development

For team members with write access:

1. Create a feature branch (`fix/...`, `feat/...`, `chore/...`)
2. Open a PR against `main` — CI runs automatically (lint, typecheck, tests, security scan)
3. All checks must pass before merge
4. After merge, a staging image builds automatically for validation

`main` is protected: no force push, no direct push without CI passing.

See `pro/docs/internal/release-strategy.md` for the full release process.

## Why No External PRs?

Early-stage projects benefit from a tight feedback loop and consistent vision. Reviewing and integrating external contributions takes more time than it saves right now. This will change as the project matures — watch this file for updates.

## License

lynox is licensed under the [Elastic License 2.0](LICENSE).
