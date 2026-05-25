# Third-Party Licenses

This file lists the licenses of third-party software included in or used by lynox. Coverage updated 2026-05-19. To check the full installed surface run `pnpm licenses list --prod` (engine) or `cd packages/web-ui && pnpm licenses list --prod` (web-ui); only material runtime deps are enumerated here.

## Apache License 2.0

The following dependencies are licensed under the Apache License 2.0.
The full license text is available at: https://www.apache.org/licenses/LICENSE-2.0

- **@huggingface/transformers** - Copyright Hugging Face Inc.
- **@mozilla/readability** - Copyright Mozilla Foundation
- **dompurify** (dual-licensed MPL-2.0 OR Apache-2.0) - Copyright Dr.-Ing. Mario Heiderich, Cure53
- **google-auth-library** - Copyright Google LLC (used by Google Workspace OAuth integration)
- **@anthropic-ai/vertex-sdk** — Copyright Anthropic (dormant; kept for the Vertex provider path documented in CLAUDE.md)

## MIT License

The following dependencies are licensed under the MIT License.

- **@anthropic-ai/sdk** - Copyright Anthropic
- **@modelcontextprotocol/sdk** - Copyright Anthropic
- **@sentry/node** - Copyright Sentry (used for Bugsink error reporting)
- **better-sqlite3** - Copyright Joshua Wise
- **zod** - Copyright Colin McDonnell
- **linkedom** - Copyright Andrea Giammarchi
- **html2canvas** - Copyright Niklas von Hertzen
- **marked** - Copyright Christopher Jeffrey
- **mermaid** - Copyright Knut Sveidqvist
- **shiki** - Copyright Pine Wu
- **nodemailer** - Copyright Andris Reinman (outbound SMTP via the Mail integration)
- **imapflow** - Copyright Andris Reinman (inbound IMAP via the Mail integration)
- **email-reply-parser** - Copyright Will Durand / Daniel Spinks (quoting/reply detection on inbound mail)
- **iconv-lite** - Copyright Alexander Shtuchkin (used for inbound-mail charset conversion)

## MPL 2.0

The following dependency is licensed under the Mozilla Public License 2.0.
The full license text is available at: https://www.mozilla.org/en-US/MPL/2.0/

- **web-push** - Copyright Web Push contributors (used for Push notifications)

## LGPL-3.0-or-later

The following dependency is licensed under the GNU Lesser General Public License v3.0 or later.
The full license text is available at: https://www.gnu.org/licenses/lgpl-3.0.html

- **libvips** - Copyright libvips contributors (https://github.com/libvips/libvips) - Bundled as prebuilt binaries via the `@img/sharp-libvips-{platform}` packages, pulled transitively through `sharp` (image-processing dependency of `@huggingface/transformers`). As required by the LGPL, users have the right to replace the bundled libvips binaries with their own builds; the prebuilt libvips binaries inside `node_modules/@img/sharp-libvips-*` can be swapped for a locally-built libvips by following the sharp installation guide at https://sharp.pixelplumbing.com/install/#custom-libvips.

## ISC License

- **linkedom** - Copyright Andrea Giammarchi (also dual-listed above; ISC is the primary license)

## External Tools (Docker only)

- **whisper.cpp** (MIT) - Copyright Georgi Gerganov - Downloaded at Docker build time for voice transcription
