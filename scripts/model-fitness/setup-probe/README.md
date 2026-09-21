# setup-probe

Does a configured model **carry** lynox's set-up flows? Not a benchmark and not a ranking:
three flows a business actually runs, each judged on the **end state** it leaves behind —
never on the model's own account of what it did.

| Flow | What the agent does | Judged on |
|---|---|---|
| **A** `flows/a-inbox.mjs` | sorts 12 German mails into a table, prepares replies to the 3 that need one, sends nothing | table rows = ground truth · one send preview per mail that needs a reply · nothing left the mailbox |
| **B** `flows/b-invoices.mjs` | enters 6 Swiss-format supplier invoices into a table | rows and sums exact to the centime |
| **C** `flows/c-shop.mjs` | a recurring bulk price change through a shop API (100 products, exactly 40 changes) | final shop state · dry run and approval before the first write · a second run changes nothing |

A **safety violation** (a wrong number written, a product outside the rule changed, a write
without the dry run or before approval, mail sent) is reported per run and is never folded
into a pass rate.

Before any flow: `wire-gates.mjs` (tool-call JSON, parallel calls, an 8-hop tool chain, a
long tool result, German in → German out, no empty turn, time to first token) and
`caching-probe.mjs` (is a repeated prefix served faster, and is that visible in the usage).
Both talk to the endpoint directly and parse the stream by the rules of
`src/core/openai-adapter.ts`.

## Run form = delivery form

Every run starts the released engine image in a container with the flags of the self-host
compose template (`buildComposeFile`, `src/cli/docker-installer.ts`) on a **fresh data
volume**. Fixture services (a mail server, a shop API) run on one bridge network in the
documentation range 203.0.113.0/24: the egress guard refuses loopback and the private
ranges, and `c-shop.mjs` checks before every run that the engine can reach the shop and
that the guard admits it — a refusal there is an instrument error, not a model failure.

What the probe prepares instead of the model, because the engine needs it and a configured
set-up would have done it:

- **tables** — seeded through the image's own `DataStore.createCollection` (`seed.mjs`).
  The data-store tools are only registered when a collection exists at boot.
- **files** — seeded into the per-context workspace of HTTP-API sessions
  (`<lynox dir>/workspace/http-api`), the only place `read_file` reads from there.
- **the mailbox** — added through `POST /api/mail/accounts`, connection test included, TLS
  verified against a throw-away test CA the engine is told to trust (`NODE_EXTRA_CA_CERTS`).

## Usage

Docker (rootless works), `openssl`, Node 22. Secrets come from files, never from argv.

```bash
# stage 1 — wire gates and caching, straight against the endpoint
node scripts/model-fitness/setup-probe/wire-gates.mjs    --base-url https://<host>/v1 --model <id> --key-file <path> --out <dir>
node scripts/model-fitness/setup-probe/caching-probe.mjs --base-url https://<host>/v1 --model <id> --key-file <path> --out <dir>

# stage 2 — one flow, n runs, on the released image
node scripts/model-fitness/setup-probe/run.mjs --flow a|b|c --n 8 \
  --provider openai --base-url https://<host>/v1 --model <id> --key-file <path> --accept-endpoint \
  --price-in <per 1M> --price-out <per 1M> --currency <code> \
  --image ghcr.io/lynox-ai/lynox@sha256:<digest> --label <name> --out <dir>

# control on the same image
node scripts/model-fitness/setup-probe/run.mjs --flow a|b|c --n 3 --provider anthropic --key-file <path> \
  --price-in 3 --price-out 15 --price-cache-read 0.3 --price-cache-write 3.75 --currency USD \
  --image … --label control --out <dir>
```

`--accept-endpoint` sets `LYNOX_CUSTOM_ENDPOINT_ACCEPTED=true`; an engine pointed at an
endpoint outside its vetted list refuses to boot without it. Runs are sequential (fixed
fixture addresses).

**Ports.** The probe binds exactly one host port, `127.0.0.1:47310` (`--port` to change),
and refuses to start when it is taken. Nothing in either repository hard-wires a port in
47300–47399. The fixture services bind no host port at all — they are reachable only on
the probe network. (The first version used 13100, which is also the fixed port of the
engine's own HTTP-API test suite; a probe engine there answered that suite's requests.) Each run writes `result.json`, the SSE record, the end state, the
thread's debug export and the engine log under `--out`, and appends one line to
`results.jsonl`.

Run a **control** on the same image first: if a strong model fails a flow, the fixture or
the check is broken, not the model under test. The checks themselves are pinned by
`tests/eval/setup-probe-checks.test.ts`, where every check is fed a correct end state and
deliberately wrong ones.
