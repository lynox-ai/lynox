# Changelog

## 2.17.1 — 2026-11-01

This release contains security fixes in the image's Debian packages. Upgrading
is recommended for every instance that runs the Docker image.

### Security

- The Docker image is rebuilt from the 2.17.0 code with current Debian security
  updates. It fixes CVE-2026-111497 in `libbrotli1` (critical) and
  CVE-2026-84782 in `libssl3`. The 2.17.0 image carried `libbrotli1
  1.0.9-2+b6`; the fixed versions are `1.0.9-2+deb12u1` and `libssl3
  3.0.22-1~deb12u2` or newer.

### Upgrade notes

- No code changes against 2.17.0 and no database migrations. The npm package
  `@lynox-ai/core` is republished with the new version number only.

## 2.17.0 — 2026-10-23

This release contains security fixes. Upgrading is recommended for every instance.

### Upgrade notes

- On first start `engine.db` moves from schema **36** to **53**, `history.db`
  from **62** to **69** and `mail-state.db` from **17** to **18**;
  `agent-memory.db` stays at **7**. The steps add tables, columns, indexes and
  triggers and fill columns they add; the one table rebuilt,
  `connection_records` (v52), is created by this release (v49). There is no
  down path. `engine.db` gains the table `workflow_grants` (v37), the table
  `exact_marker` (v38), `bulk_targets.failed_once` (v39, empty for targets of
  runs approved before the update), the table `contained`, whose rows cannot
  be updated (v40), the tables `vault_name_bindings` and
  `vault_name_binding_migration` (v41), the table `connection_grant_hosts`
  (v42), `bulk_targets.read_connection_id`, `read_grant_id`,
  `write_connection_id`, `write_grant_id` and `bulk_runs.first_connection_id`,
  `first_grant_id` (v43), `triggers.created_mandate_id`, `mandate_editor` and
  `mandate_editor_id` (v44; `mandate_editor` is filled from `edited_by` where
  that names a person the owner let in), `workflows.created_by`,
  `created_mandate_id`, `mandate_editor`, `mandate_editor_id`,
  `mandate_edited_at` and `triggers.mandate_edited_at` (v45),
  `bulk_runs.unsent_tracked` (0 for existing runs) and
  `bulk_targets.found_unsent` (v46), `triggers.route_token_hash` and the table
  `inbound_events` (v47), the table `approval_entries`, whose filed fields
  cannot be changed (v48), `connections.first_grant_id` and the table
  `connection_records` (v49, `first_grant_id` set again by time in v50),
  `triggers.stamp_connections` (v51), the columns `cause`, `hold_until`,
  `cancelled_at`, `revoked_grant` and `kept_after_hold` on
  `connection_records` (v52) and `bulk_runs.list_last_id` (v53). `history.db`
  gains `pipeline_runs.workflow_grant_id` and `started_via` (v63),
  `pipeline_runs.origin_thread_id` (v64), `run_tool_calls.grant_id` (v65) and
  `tool_use_id` (v66), the table `conversation_grants`, filled with `unknown`
  for every conversation that already has messages (v67),
  `pending_prompts.answered_by` and `answered_mandate_id` (v68), and
  `run_tool_calls.is_error`, `contract_state`, `contract_grant_id`,
  `lift_grant_id`, `lift_entry`, `filing` and `approval_id` (v69).
  `mail-state.db` gains the table `mail_delta_cursors` (v18). `datastore.db`
  has no schema version: at boot the engine adds `_source_grants` and
  `_source_run_id` to every collection table that lacks them, one table at a
  time. (#1895, #1906, #1922, #1926, #1930, #1937, #1941, #1944, #1949, #1957,
  #1967, #1981, #1985, #1994, #2013, #2017, #2025, #2026, #2041, #2052, #2069,
  #2071, #2086, #2090, #2095)
- New environment variables: `LYNOX_EGRESS_PROXY_SECRET`,
  `LYNOX_EGRESS_PROXY_URL`, `LYNOX_EGRESS_SHELL_PROXY` and
  `LYNOX_EGRESS_PROXY_DENY_IPS` for the egress proxy of the shell sidecar;
  `LYNOX_SHOPIFY_EXCHANGE` (off unless `1` or `true`); and the feature
  switches `LYNOX_FEATURE_INBOUND_WEBHOOKS`, `LYNOX_FEATURE_APPROVAL_QUEUE`
  and `LYNOX_FEATURE_SHOPIFY_BULK_READ`, all off by default. No variable is
  renamed or removed. `LYNOX_FEATURE_WORKFLOW_REVIEWED_GRANT` may now be set
  per instance by a control plane; the engine default stays off. (#1860,
  #1871, #1889, #1929, #2017, #2041, #2095)
- Rolling back to 2.16.0: 2.16.0 boots on the migrated databases, because its
  migration loops start at the stored version, and it ignores the new tables
  and columns. `escalation_mail` is the only new key in `config.json`. 2.16.0
  reads `config.json` with a strict schema and ignores the whole file when it
  holds a key it does not know: an owner who switched the escalation notice
  off has `escalation_mail: false` stored, and after a rollback that instance
  starts without its configuration (the file stays on disk). Switch the notice
  on again in Settings, which removes the key, or delete the key from
  `config.json` before rolling back. (#1861)
- After a rollback nothing of this release is enforced or carried on: store
  containment, vault name bindings, entries of the approval queue (no longer
  sent or swept), connection records and their erasures, the stop of plans
  whose access ended, the member connections a plan lists, and the boot's
  refusal to replace an `engine.db` or `history.db` it can still open. 2.16.0
  returns `_source_grants` and `_source_run_id` among the fields of collection
  rows that carry them. A workflow grant accepted under 2.16.0 after the
  rollback has no grant record and must be scheduled again from the library
  after the next upgrade. (#1895, #1930, #1937, #1999, #2017, #2019, #2026,
  #2041, #2052, #2086)
- A workflow grant accepted before this release (only where the reviewed-grant
  switch is on) has no grant record. Its scheduled runs go ahead without the
  grant, and the run report says so, until the workflow is scheduled again
  from the library. (#1895)
- `POST /run` skips the danger check and the question before a file write only
  when the request says `shows_changeset_review: true`, as the web UI does.
  API clients that start runs without it now get those checks; the changeset
  is still recorded. (#1958, #1963)
- `POST /api/vault/rotate` no longer rotates: it answers 409
  `vault_rotation_unavailable` and changes nothing. A managed instance and a
  session that is not admin keep their 403. (#2076)
- `PUT /api/config` answers 403 when it would turn `bulk_runs_enabled` on, and
  400 when it would change `backup_retention_days` to `0`. A stored `0` stays
  and still loads. (#1934, #1992)
- `GET /api/secrets` is owner-only (`/api/secrets/status` stays open), and
  `PUT /api/secrets/:name` answers 403 `preset_client_secret` for a built-in
  provider's client secret, which is stored in Settings or the connection
  form. (#1921, #2063)
- `GET /api/health` answers `"status":"degraded"` with HTTP 200 when
  `engine.db` or `history.db` could not be opened at boot. (#2036)
- A migration restore closes the engine before it swaps the databases, answers
  other requests with 503, and ends the process afterwards, also on failure.
  The instance comes back only through a restart policy (the container's or a
  service manager's). (#1989)
- At boot `engine.db` or `history.db` is set aside, and the engine starts on
  an empty one, only when the integrity check reports a fault or SQLite finds
  no database or a malformed image. Any other open error, such as a lock held
  past the wait, keeps the file: the engine then starts without that store
  (without `history.db` no history, threads or tasks; without `engine.db` no
  schedules or workflows), and `GET /api/health` answers `degraded`. Outside
  the engine boot, `EngineDb` and `RunHistory` throw on a file that looks
  corrupt instead of renaming it aside; operator scripts that open a live data
  directory stop with an error that names the file. (#2019, #2043)
- On an instance the control plane has cleared for store connections, and on
  any instance whose `engine.db` did not open, `ANTHROPIC_LOG`, `LYNOX_DEBUG`,
  `LYNOX_DEBUG_FILE`, `LYNOX_DEBUG_WIRE_ALLOW_PROVISIONED`,
  `LYNOX_DEBUG_WIRE_CAPTURE` and `LYNOX_BUGSINK_DSN` are removed from the
  process environment for the rest of the process, and error reporting does
  not start. The removed names are logged. (#1932, #1935)
- On a pool tier (`managed`, `managed_pro`, `managed_max`) the pool key in the
  environment is the only LLM credential: a vault key or a config `api_key` is
  no longer used there. `hosted` and self-hosted instances are unchanged.
  (#1939)
- Plugin tools whose name equals one of lynox's own tool names are no longer
  loaded; the plugin's other tools still load and a warning names plugin and
  tool. A plugin tool that sets `queueable` is loaded without that field.
  (#2054, #2057)
- Trigger runs can now have the status `halted` or `interrupted`, and
  `stopped` is now also recorded for a plan whose access ended; a stopped
  one-time schedule has the status `stopped` instead of `completed`. (#1924,
  #1987, #1999)
- A schedule that a person the owner let in created before this release, or
  changed last without the owner confirming it since, carries that person's
  name but no id of their access, and a plan without that id counts as one
  whose access has ended. After the upgrade such a schedule does not run,
  neither on its own nor started by hand; the owner can set it up anew. A due
  run the access check stops is recorded as `stopped`, the first one with a
  push to the owner. (#1981, #1999)
- The first start binds each vault secret that is not a token slot to the
  destinations its profiles agree on, once. A name stays unbound when profiles
  send it to different places, when a stored entry that could not be read also
  names it, or when it is a built-in provider's client secret named by a
  profile that is not that provider's; while the import of profile files waits
  on an unreadable file, no name is bound at all. The binding is not repeated:
  such a name stays unbound also after the cause is repaired, and no profile
  sends it until the owner saves the profile again in the chat and allows it
  at the question. Repair or delete unreadable profile files before upgrading.
  (#1937, #2087)
- Library users: every answer path of a question (`ask_user`, tabs,
  `ask_secret`, mail connect) now takes the answering principal as a required
  argument; a call without it throws and stores nothing. (#2025)

### Added: egress proxy for shell commands in the sidecar

- A new process, `dist/egress-proxy/main.js`, forwards HTTPS CONNECT tunnels
  for shell commands. It listens on the address of interface `shell0` (port
  3128) and on `admin0` (port 3129) and does not start if either interface is
  missing or has other than one IPv4 address. Credentials are registered per
  shell call and carry a set of exact host names or every host; the host is
  checked against the set before it is resolved, every resolved address must
  be public, and the connection goes to the address that was checked. Plain
  `http` and ports other than 443 are refused. With a set of exact names, TLS
  hellos with encrypted client hello are refused, and a tunnel forwards
  nothing until the TLS server name equals the host named in CONNECT, on a
  second hello too. Refused connections are kept
  with a reason. No compose file in this repository starts the proxy. (#1860,
  #1862)
- In sidecar mode (`LYNOX_SHELL_EXEC_SOCKET` set) with
  `LYNOX_EGRESS_PROXY_SECRET` set, each `bash` call gets its own proxy
  credential for the hosts that `network_policy` lets `http_request` reach:
  under `allow-all`, or when no policy is set, any public host; under
  `allow-list` and `guarded` the exact host names. The call gets it as
  `HTTPS_PROXY`/`HTTP_PROXY` (with `NODE_USE_ENV_PROXY=1`), the credential is
  revoked when the call ends and removed from its output, and the result opens
  with a `Network (egress proxy):` block that lists the refused connections.
  `network_policy: deny-all` gives the call no network; a wildcard entry, an
  IP literal or an upper-case name is not passed on and is named in that
  block. If the proxy cannot be registered with, or
  `LYNOX_EGRESS_PROXY_SECRET` is unset, the call has no network, as before.
  (#1871)

### Added: Shopify store connections on provisioned instances

- Preset `shopify` for `api_setup`: host `{shop}.myshopify.com` from the
  profile parameter `shop`, read scopes only (`read_products`, `read_orders`,
  `read_customers`, `read_inventory`, `read_fulfillments`), the token in
  `X-Shopify-Access-Token`, a form-encoded token request and a token that does
  not expire. The connect callback must carry Shopify's signature and name the
  store the profile derives, and the token is stored only on a profile that
  still names that store. Presets can now state how scopes are joined, which
  header carries the token, the token-request body format and that the
  callback is signed. The preset pins Admin API version `2026-10`. (#1903,
  #1916, #2092)
- A request to a store host goes out only under a pass the engine mints for
  that request, on an instance the control plane provisioned that has the
  shell sidecar socket configured, through a store-preset profile, with no
  credential written by the model, and with the token the connect callback
  bound to that store. Each redirect hop is checked against the pass. Store
  tokens are not renewed by the engine; the owner connects the store again.
  Everywhere else, `http_request`, bulk requests, `secret:` references and
  token exchanges to `*.myshopify.com` are refused with a message that Shopify
  is temporarily unavailable. (#1899, #1916, #1922)
- The engine asks the control plane for clearance once per boot (`POST
  /internal/instances/:instanceId/exact-attach`) before the first store
  request; any answer other than `ok` is a refusal, asked again after 60
  seconds at the earliest. On `ok` it writes the marker in `engine.db` before
  it counts as cleared, and asks again when the usage status reports
  `exact_held: false`. (#1919, #1922)
- The connect callback exchanges its code for a store token under a single-use
  pass, only with `LYNOX_SHOPIFY_EXCHANGE` set to `1` or `true`; with it off
  every Shopify token exchange is refused. With the switch on, the system
  prompt names the connection path (an app in Shopify's Dev Dashboard, client
  id and secret entered in Settings, never in the chat) and tells the model
  not to collect them; with it off the prompt does not mention Shopify.
  (#1929, #2065, #2066)
- The owner can enter a built-in provider's OAuth app (client id and secret)
  in a connection form on the API profile page (`GET`/`PUT
  /api/api-profiles/:id/client`, owner only). A different client id replaces
  the app for every profile of that provider, so the route answers 409
  `replaces_app` until the request confirms, and 400 `secret_for_new_app` when
  a new client id comes without its secret. The Shopify setup page is added to
  the docs. (#1971)
- A migration import removes each store connection's derived token slots, its
  token binding and its written record on the destination, and names the
  stores to connect again. (#1922)
- A chat or bulk run is recorded in the table `contained` before a store
  request is attached for it. Such a chat keeps nothing in memory: the memory
  tools refuse, end-of-turn extraction stands down and private mode stays on.
  It can call only `http_request` to a store host, `memory_recall`,
  `memory_list`, `recall`, `archive_search`, `recall_tool_result`, the
  follow-up tool, `ask_user`, `spawn_agent`, `run_workflow` and
  `bulk_plan` for a store target and `bulk_status`, without provider-side web
  search. A workflow run records the chat it started from, and a chat that
  reads such a run is contained first. When the record cannot be read the chat
  counts as contained (without `engine.db`, on a provisioned instance only).
  (#1930, #1941)
- `GET /api/threads` and `GET /api/threads/:id` carry `contained` per thread;
  `PATCH` with `skip_extraction: false` on a contained chat answers 409
  `contained`, and the memory and artifact write routes answer 409 for a
  contained `source_thread_id`. The web UI shows the state and locks the
  private switch. (#1941, #1953)
- Error text of a contained run leaves the engine as its class name and HTTP
  status only, in the push body, bulk judge failures and the logs that know no
  container once the instance holds the marker; no stack is printed. (#1946)
- With `LYNOX_FEATURE_SHOPIFY_BULK_READ` on, `bulk_plan` accepts `source_list:
  { form: 'shopify', after }` on a store host: products are listed through the
  store's GraphQL API (250 per page, by id) and their before-images read. Such
  a run only reads: approving or resuming it answers `read_only`, and `judge`
  and `write_method` are refused. It halts with `listOrder`, `listReadFailed`,
  `shopInactive`, `formCost` or `shopifyReadOff`. Under its grant only a
  `POST` whose body the engine built reaches the store's GraphQL endpoint.
  (#2092, #2095)

### Added: inbound webhook receiver (off by default)

- With `LYNOX_FEATURE_INBOUND_WEBHOOKS` on, `POST /api/webhooks/<token>`
  records a verified provider delivery in `inbound_events`; in this release
  nothing runs the recorded events. The route takes one exact path shape before
  authentication and the rate limiter. The token is stored as a SHA-256 hash
  and looked up before the body is read; any refusal gets one answer and
  closes the connection. The body is read capped and verified before it is
  parsed (Shopify HMAC over the raw bytes, or a shared token kept as its
  hash); a replay records nothing, and a delivery naming another shop is
  recorded as dropped. The route token is redacted from request logs. (#2017)
- A verified delivery carries the values its trigger's
  `condition_json.webhook.mapping` reads from the body (JSON pointers, at most
  16; strings up to 1024 characters, finite numbers, booleans), stored
  encrypted with the vault key when there is one.
  `TaskManager.createWebhookTrigger` creates a `webhook` trigger; in this
  release no route or UI calls it. (#2083)

### Added: approval queue for unattended mail (off by default)

- With `LYNOX_FEATURE_APPROVAL_QUEUE` on, a run nobody watches (a scheduled or
  triggered worker run or a scheduled workflow, with their children and steps)
  no longer waits on a question or is refused when it sends or answers a mail:
  `mail_send` and `mail_reply` file the exact mail in `approval_entries` and
  the run is told nothing was sent. Chats, a chat's `run_workflow`, the
  library's Run and watches behave as before. Only lynox's own mail tools can
  file. (#2041, #2049)
- An entry is encrypted at rest and bound to a keyed checksum over kind,
  payload and origin, which must be sent back to approve. A trigger has at
  most 10 entries waiting, a body over 64 KiB is not filed, and entries expire
  after 72 hours. An entry whose send outcome is unknown blocks the same mail
  until the owner clears it, and its content is removed after 30 days. (#2041,
  #2049)
- `POST /api/approvals/:id/decide` (owner only) takes `{action, checksum?}`
  with `approve`, `reject`, `move_to_chat` or `clear_unknown`; refusals carry
  `checksum`, `expired`, `not_pending`, `not_unknown`, `not_executable` or
  `mandate_ended` (409) or `not_found` (404). With the switch off it answers
  404. One approved entry is sent per 30-second tick after the checksum, the
  filer's access, the account and its sending address are checked again; mail
  caps count these sends. A send that began and then failed is `unknown` and
  never retried. A sweep runs at boot and every 5 minutes either way. The list
  the owner decides from is not part of this release. (#2077)

### Added: where data came from

- Each conversation keeps the set of grants it took data from
  (`conversation_grants`): the grant of each connection a call reached the
  network under, and `unknown` for data from a source that resolved none.
  Sub-agents and workflow steps add to the root conversation's set; deleting a
  conversation removes its rows. (#2013)
- Every row a DataStore collection writes from now on is stamped with
  `_source_grants` and `_source_run_id`, and rows from before the update keep
  both empty; an upsert unions the stored set with the new one. The two
  columns appear only in the export and cannot be named in a filter, sort or
  aggregate. A table that cannot be altered at boot refuses writes while the
  others keep working. (#2026)
- Run history records the grant beside the connection of each tool call
  (`run_tool_calls.grant_id`), the `tool_use` id a call answers
  (`tool_use_id`), and per call whether it failed, the contract state, the
  grant that let it through and whether it was filed (v69); older rows stay
  empty. A workflow step's call row records its connection and grant, and
  records a refused write, a failed request or a refused redirect after a
  write as an error. The `tool_result` event carries `contract`, `filed` and
  `softFailure`. The OpenAI-compatible adapter draws a random 9-character id
  when a provider sends no tool-call id. (#1949, #1967, #2008, #2069)
- Each grant's credential host set is kept as snapshots
  (`connection_grant_hosts`), and bulk targets and runs record the connection
  and grant they read and wrote under. (#1944, #1957)
- The profile list shows who connected an OAuth profile and which provider
  account it signed in with ("Account unknown" when none was recorded): for a
  store the store the callback was signed for, for bexio the verified `email`
  of the `id_token`. (#1991)
- Each metered usage report carries its run group; a workflow started outside
  a run and a bulk judge pass open a group of their own. The managed hook
  sends `run_group_id` only when it differs from the report's run id, and
  reads an optional `exact_held` on the usage status. (#1955, #1968)

### Added: plans follow the access of the person who shaped them

- Schedules and saved workflows record which person the owner let in created
  them and last changed them, with the id of that access and when. Existing
  schedules such a person created, or changed last without the owner
  confirming them since, have no id of that access and do not run (see the
  upgrade notes).
  (#1981, #1985)
- A scheduled run whose plan depends on an access that has ended does not
  start; it is recorded as `stopped`, with one push to the owner. The pre-turn
  check and the periodic sweep stop a running plan when the access ends.
  `runManifest` names each run's source and refuses a saved workflow whose
  access has ended or whose authorship cannot be read, before the run exists.
  (#1999, #2003)
- A stopped one-time schedule gets the status `stopped`, treated like
  `completed` everywhere else; one the owner completed while it ran stays
  `completed`. (#1987)
- Every answer to a question records who gave it (`answered_by`,
  `answered_mandate_id`). (#2025)
- A stamped plan whose last editor is a person the owner let in runs as that
  person, whoever starts it: their tool lock applies to the session, its
  children and every step, and the run writes a `plan:run` row before it
  starts and one at its end; if the first cannot be written the run does not
  start. That person may stop it. A hand start by another person the owner let
  in is refused; the owner may still start it. A step that names a tool the
  lock withholds is refused up front. (#2040)
- A connection such a person made with their own login is read only by them,
  in their session and under its grant; other runs get `Connection not used:
  …`, and the owner cannot save over that profile while the access lasts. A
  scheduled run that meets this refusal ends halted and keeps its next run.
  `fetch_token` through a profile that only shares the connection's refresh
  slot is refused. (#2048, #2056)
- `GET /api/tasks/:id/stamp-preview` (owner only) lists the connections of the
  person a plan acts for with a digest; `POST /api/tasks/:id/confirm` with `{
  "expect": "<digest>" }` stores the list, and a run uses a listed connection
  only while the confirmations, grant and binding are unchanged. The web UI
  does not send it. (#2086)
- `adopt_connection` refuses in an autonomous run. (#2087)

### Added: connection records

- Removing an API connection writes a record (`connection_records`) in the
  same transaction. The erasure of the run history of a connection's calls is
  outside the scope of this release: a removal writes a closing record, and
  the run history of the connection's calls stays as it is. The record states
  where such an erasure would start, read from the grant ledger by time; an
  empty start reads `not reached`. (#2052, #2071)
- When a token exchange reports that the provider revoked the grant, a record
  is written for the connection. In this release a provider's revocation
  writes a closing record only, never an erasure; the cancel route and its
  audit row apply to held erasures, which this release does not create. New
  owner-only routes `GET
  /api/connections/records` and `POST /api/connections/records/:id/cancel`;
  the API page shows "revoked by provider" with a Reconnect link. (#2090,
  #2097)

### Added: workspace files in the data export

- `GET /api/export` carries `workspace` (every file with path and size, plus
  `skipped`, `unreadable`, `may_be_incomplete`) and `workspace_archive`. The
  new admin route `GET /api/export/workspace` streams the files as a tar
  ending in `workspace-manifest.json` with each file's sha256 and what was not
  delivered and why; headers `X-Lynox-Workspace-Files` and `-Unreadable` carry
  the counts, and `-Incomplete` is `true` or `false`. Links, special files,
  names that are not UTF-8 or carry a `..` component, and hard links to the
  data directory's credential files are listed, not delivered. (#2070)
- One workspace export runs at a time (409 `export_in_progress`, 409
  `erasure_in_progress`; an erasure answers 409 `workspace_export_running`
  meanwhile), free space is checked (507 `insufficient_storage`), and a
  download the client stops reading for 120 s is cut. The archive is staged in
  `<data dir>/export-staging/` and removed afterwards. The control plane's
  admin bearer does not reach the route. (#2070)

### Added: workflow grant records

- Accepting a reviewed workflow grant writes one immutable row to
  `workflow_grants` in the same transaction as the workflow's stamp. A run
  under a grant records the grant and how it was started
  (`pipeline_runs.workflow_grant_id`, `started_via`). A run goes ahead without
  its grant, and the report says why, when the record is missing or does not
  match workflow, schedule and checksum, or the run cannot be recorded. Each
  call a write grant let through is marked with it on `tool_result` and the
  step record. (#1895, #1898)

### Added: Activity and bulk runs

- Activity has a tab for bulk runs and merged contacts. A run has its own page
  to approve a preview, check and confirm a probe, prepare and approve an undo
  and start a waiting run; a run whose process is gone shows when it will be
  picked up. A run that halted while reading or judging says why and offers to
  go on, with a higher cost cap after a halt on the cap; a halt while writing
  shows why, how many targets failed and what writing on allows, under a
  higher maximum after a halt at the maximum. Hidden characters in shown
  values are made visible. Bulk run status adds `haltKey`, `resumesAt`,
  `probe`, `undoable`, `judgeServedBy`/`judgeOwnKey`, `failedOnce`,
  `failureLimit`, `resumeOpen` and `resumeTries`. (#1893, #1896, #1909, #1910,
  #1926, #1931)
- The merge rollback route answers each refusal with a code
  (`merge_not_found`, `merge_not_applied`, `merge_missing`,
  `merge_superseded`, `merge_not_in_effect`, `merge_chained`,
  `merge_unavailable`, `merge_partial`, `merge_failed`) and names a blocking
  merge; the bulk page offers the rollback only where the route can do it.
  (#1914)
- A bulk run stopped by the owner is labelled "stopped"; the schedules view
  reloads every 15 s while visible, so a run that started on its own shows its
  stop. (#1993)
- `bulk_status` on a judged run prints how many targets were judged and how
  many have no verdict yet. (#2084)

### Added: other

- When an escalation (a failed scheduled workflow or a watch finding) is
  answered `not_delivered` or `no_channel`, the managed hook posts a notice
  without run content to the control plane, at most once every 10 minutes per
  engine. Config key `escalation_mail` (default on) turns it off; Settings →
  Notifications shows the switch on instances a control plane runs. A person
  the owner let in may read it but not change it. (#1861)
- A scheduled workflow question that reached nobody is reported to the
  engine's hooks like an escalation. (#2059)
- Microsoft 365 groundwork, which no production path uses in this release: a
  token holder that renews through the control plane, and a Microsoft Graph
  mail provider with its watch cursor table in `mail-state.db`. The MIME
  builder is shared with the Gmail provider. Vault names starting with
  `MICROSOFT_OAUTH_` are now reserved like `GOOGLE_OAUTH_`: the model does not
  see or resolve them, and only an admin writes them. (#1880, #1892, #1906)
- The consent page of an OAuth preset can carry a frame (title, lines around
  the write-scope list, button) and a readable name per write scope; the bexio
  preset shows its page in German with scope names such as "Kontakte:
  Schreibzugriff". (#2046, #2047)

### Changed: files reach the context workspace through its open directory

- With workspace isolation, which server and managed engines use (the CLI has
  no context workspace), the file tools, `batch_files`, `media_process`, bulk
  workspace targets, the changeset and diff preview, `GET`/`DELETE
  /api/files`, `/api/files/read`, `/api/files/download` and chat uploads reach
  files in the context workspace only through the workspace's open directory.
  A link on the way is refused, a file with more than one name is neither read
  nor written, and a path that reaches the workspace through an outside link
  is refused with a message to use the workspace path. (#1859, #1864, #1865,
  #1867)
- Writes are made in place (inode, owner and mode kept); new files and
  directories get the usual modes less the process umask, owner-only when the
  umask cannot be read. A bulk write leaves the file it replaces with the mode
  an ordinary write would leave, and moves and renames stay inside the
  workspace.
  Bulk runs and the changeset map their absolute keys into the current
  workspace on every use. (#1859, #1864, #1867)
- `DELETE /api/files` removes a link itself, the file list adds `omitted` for
  names that are not valid UTF-8, and `read` and `download` answer 400 for the
  files area itself. Downloads with names outside Latin-1 work through
  `filename*=UTF-8''…`, and a download is bounded by the size that was read.
  (#1865, #1883)

### Changed: tokens, token slots and API profiles

- A vault name that holds a connection's OAuth token is sent only where that
  connection points, and only by `http_request`: an access token to its
  owner's origin (or the hosts of the built-in provider whose grant it
  shares), a refresh token only to its token endpoint. A name more than one
  profile claims is sent nowhere. (#1887)
- No other profile can claim the token names an oauth2 profile derives: such a
  profile is refused at save and at load, and on a clash at boot the oauth2
  profile keeps them. A stored profile the boot does not register stays stored
  and keeps its names claimed; only the owner can delete an unreadable entry,
  and a person the owner let in cannot save over or delete a held-back owner
  profile. Deleting a profile removes the tokens its exchanges recorded, also
  when another profile reads them; a token the other half of a `-`/`_` pair
  records with the same value on the same vault slot stays. When a stored
  entry that could not be read also names such a token, the delete is refused
  before anything is removed (409 with the way out). (#1870, #1874, #1879,
  #1894, #1905, #1912, #1915)
- `fetch_token` refuses an `output_secret_name` it cannot tell belongs to this
  profile alone, checked again right before the write. It refuses an app token
  (`client_credentials`) for a profile connected through a built-in preset or
  the OAuth callback. (#1855, #1872, #1897, #1904)
- A profile file that cannot be read, does not parse, lacks a required field,
  has an invalid id or a `name` that is not text or a number holds the import
  of the flat profile files open and holds its vault names until it is
  repaired or deleted; `api_setup list` and the API page list the waiting
  files. A failed import transaction leaves the import open the same way.
  Profiles read but not yet written, and a save while the import marker cannot
  be written, are refused with a reason. (#1943, #1951, #1959, #1966, #1976,
  #2012, #2014, #2051)
- A managed restore is refused when `custom_endpoint_ack` cannot be removed
  from the flat profile files. Deleting a profile from the settings page
  forgets the owner's secret releases to it and returns the token purge; the
  page lists the names left in the vault. (#1928, #1973)
- The one-time boot migration of vault bindings binds nothing while the import
  of profile files waits on an unreadable file, and leaves unbound a name a
  stored entry that could not be read also names and a built-in provider's
  client secret named by a profile that is not that provider's. The migration
  does not run again: such names stay unbound, and no profile sends them,
  until the owner saves the profile again in the chat and allows it at the
  question (see the upgrade notes). (#2087)

### Changed: write approvals of `http_request`

- A write approval covers only the write its question showed and the identical
  calls of the same batch; the next answer ends it. Parallel calls that ask
  the same question share one prompt. (#1950, #1975, #1979, #1995)
- The question shows the headers the write sets (values masked, invisible
  characters spelled out) and the query's values, and says when a stored
  secret is sent in the query. A write whose headers cannot be shown
  faithfully, or would show a secret unmasked, is refused, not asked. For a
  person the owner let in and for a connected account, a body or query that
  cannot be shown whole or that sends a stored secret is refused, and in such
  a person's session a stored secret in a header, path or host is refused.
  (#1988, #2006, #2027)
- Refusals name every write a request names (`POST (also naming PATCH)`), the
  batch denial names the denied writes, and early refusals name the service as
  the question does. A redirected write is sent again on at most one hop. A
  write with a body that is redirected to another origin is followed as a GET
  without its body, as before; after a 307 or 308 the result now says so.
  After a refused or failed redirect the result opens with `Write possibly
  landed:`. The OAuth connect page says that nothing was stored when the token
  exchange is refused. (#1942, #2031, #2055, #2074, #2080)
- A person the owner let in can now write to an account connected through a
  built-in provider; before, such a write was refused. Each write to such an
  account is asked about with what it sends, for the owner too, no answer is
  remembered and no contract grants it, and such a person's write is recorded
  in the trail. A GraphQL mutation is asked every time. (#1890,
  #1907)
- bexio: the writes that send, issue, cancel, book or pay cover every action
  path of bexio's published API that reaches a recipient, binds a document or
  moves money. The list of mail-API hosts that no grant or bulk run may write
  to is extended. (#1888, #1889, #1911)
- Under a capability contract, `memory_recall`, `memory_list` and `recall`
  count as external content. (#1878)

### Changed: a stop reaches calls in flight

- The stop of a run aborts the signal of its calls. A call ended this way says
  it was stopped, that what it did before stays, and to check a write before
  repeating it. This covers `http_request`, sidecar commands, rerank, web
  research, Google reads, calendar feed and Gmail reads, `media_process`
  before its output is saved, IMAP reads, `save_workflow`, the `api_setup`
  bootstrap and the reads that precede a Google Docs, Google Drive or
  `http_request` write; the stop is checked between such a read and its write.
  (#1998, #2018, #2022, #2029, #2033)
- `mail_connect` is exempt from the tool timeout like the other waits on a
  person, and its question is withdrawn when the run is aborted. (#2023)
- A stopped run keeps its question and every completed tool call and result in
  the model's context; the next call carries a short note that the run was
  interrupted. After a reload the note is restored. (#1917)

### Changed: migration restore and erasure

- Before any database is staged, every part of the bundle is decoded,
  size-bounded and shape-checked, and the destination is checked. All restored
  databases are staged and checked before any is swapped in, and a database in
  place that SQLite cannot open is moved aside as `<db>.corrupt-<ms>`. A
  failed integrity check of the staged `engine.db` no longer swaps in an empty
  database. (#1997, #2011, #2015)
- On a managed destination `custom_endpoint_ack` is removed before it lands. A
  damaged profile file or null grant record no longer aborts the store strip,
  which writes only to regular files in a real `apis/` directory. (#1980,
  #2004, #2007)
- The restore's shutdown surfaces waiting mails unclassified instead of
  classifying the backlog, waits only for running jobs within a bound, and
  runs the shutdown hooks before reporting a timeout; past that bound the
  route answers 500 and the process restarts without restoring. A hook that
  throws no longer skips the ones after it. A restore with incomplete chunks
  answers 400 before any shutdown. (#1989, #2001, #2058)
- The data-directory erasure removes staged copies a crashed restore left
  (`<db>.migration-tmp` with `-wal` and `-shm`) and the copy a restore's
  re-check moves aside (`engine.db.migration-tmp.corrupt-<ms>`). (#1983,
  #2016)

### Changed: bulk runs

- Bulk judging uses a fixed model per provider (`anthropic`:
  `claude-haiku-4-5-20251001`, `vertex`: `claude-haiku-4-5`, `mistral`:
  `mistral-medium-2604` on Mistral's own https endpoint only, `fireworks`:
  `accounts/fireworks/models/gpt-oss-120b`); another provider or endpoint gets
  no judge and the run halts with a reason. A rule, field description or enum
  value holding a character the owner cannot see is refused, and a stored rule
  is checked again at start (409 `rule_refused`). (#1891, #1902, #1969)
- Failed counts are read from the targets; a run that stops at its approved
  maximum without a failed write is `halted`, one the engine lost is
  `interrupted`. A run holding the read slot with no live read trigger is
  halted (`unavailable`), and deleting a bulk run's trigger through the
  schedule delete is refused. (#1918, #1924, #1954)
- A probe vouches only through the one target its run wrote; an undo needs no
  probe and sends only the fields its source sent. A bulk run planned by a
  person the owner let in writes trail rows before and after; if the first
  cannot be written the run sends nothing. (#1886, #1908)
- A workflow step gets `bulk_plan` or `bulk_status` only when its own `tools`
  list names them, and a step that names one where bulk runs are off is
  refused when it starts. A role's `allowTools` does not hand them over, and a
  recorded replay of a bulk call is refused at save and at run time; a saved
  session keeps such a call as a prose step. (#1970)

### Changed: credit, cost and models

- A run refused for credit forces one flush and status sync, at most every 30
  seconds, and is decided again on that answer. (#1972)
- A spawned child is recorded and debited with its own spend, not that of what
  it delegated, and a workflow retry is debited only for the steps it ran.
  (#1960, #1961)
- A dash-dated model id resolves to its registered model for pricing, output
  ceiling and the deep-band check, and a spawned child's inherited model pin
  is judged by its registered deep band. (#1936, #1945)
- A pipeline step whose nested pipeline does not complete fails with the
  nested error, so the outer run's `on_failure` applies. (#1974)

### Changed: shutdown

- On SIGTERM the inbox classifies for 5 s, surfaces what still waits
  unclassified and cuts off running jobs at 8 s, inside a 10 s grace. The
  usage report waits for a flush already sending and makes up to three
  attempts within 48 s. (#2021, #2039)

### Changed: other

- A person the owner let in has the reads their session makes outside the
  instance recorded in the trail before they run (host and path or
  identifiers, no content); if the row cannot be written the read does not
  happen, and a redirect hop that a server would act on as a write is not
  followed. `web_search` and `score_results` are no longer available in such a
  session. (#1900)
- The inbox no longer files a mail a person forwarded as `auto_handled`: with
  a forward subject or header and a sender that is not an automated address it
  becomes `requires_user` (`forwarded_by_person`). (#1869)
- Error reporting bounds its close (1 s after the 5 s flush), so an endpoint
  that never answers no longer holds a settings change or restore open;
  turning it off closes every client, and turning it on inside a request
  reports errors outside it too. (#2053, #2068, #2073)
- A web push counts as `delivered` only when one of the owner's devices took
  it; one only others' devices took is `reached_others`, and escalations then
  fall back to mail. (#2085)
- Uploaded documents cut by the extractor or the 100-chunk cap have every
  archived chunk headed with a `CUT` note. (#2064)
- The production image keeps the dpkg status so an image scan sees OS
  packages; perl and yarn are removed and the `node:22-slim` base digest moves
  forward. (#1925)
- Web UI: the private-mode tooltip says what private mode removes; Settings →
  Configuration is named for the model each tier uses and the LLM key;
  a save whose result never arrived draws no artifact card and the chat's
  artifact chips mark lost saves, and a placeholder refusal shows
  its own text (`POST /api/artifacts` adds `code: 'artifact_placeholder'` to
  its 422); the memory delete dialogs say what deleting removes; the mail
  sender-name field shows a format placeholder; the migration assistant asks
  for the target instance's URL and migration token directly. (#1858, #1884,
  #1940, #1952, #2060, #2062, #2096, #2120)

### Security

- DOMPurify is raised to 3.4.17 (GHSA-cg2g-xh64-v4q7, GHSA-mrv2-3pqr-j5jr,
  GHSA-c6gr-qvv4-5v3f), held at `>=3.4.17 <4`; the `vite` override is raised
  to `>=8.3.3`. (#2032, #2123)
- Each vault secret that is not a token slot is bound to the destinations its
  owner allowed. The first boot after the upgrade binds each name whose
  profiles agree on one destination set; a contested name stays unbound and is
  sent nowhere until the owner allows it at an interactive save, after a
  question naming the secret and the destinations. In `http_request`, a
  `secret:` reference to a bound name is refused, no longer asked, at any
  other origin, and the
  approval for an unbound name is held per origin (scheme, host and port). A
  run nobody watches cannot save a profile that needs a new binding, and a save
  that moves where a profile's credentials go removes the tokens they minted.
  (#1937)
- A built-in provider's client secret is left out of the secret names the
  model sees, a `secret:` reference to it is refused, and `ask_secret` does
  not collect it. (#1921)
- In a turn of a person the owner let in the owner's secret names are not
  shown, and `ask_secret` `list` answers one fixed sentence. A secret's mask
  shows its last four characters only from 16 characters on; the security
  model page says so. (#2042, #2063, #2067)
- `secret:` references are refused in fields that name a file and, for a token
  held by a connection, off that connection's grant. The "unknown secret name"
  hint offers only names the `secret:` gate would accept. (#1887, #1965,
  #2093)
- In a restricted session the `http` tool compares the host with stored
  secrets regardless of case, and the write question's mask reads `%uXXXX`
  escapes as a server does. (#2044, #2075)
- The engine's own env secrets are masked in tool results and tool errors,
  also in a headless workflow step (values of 8 characters or more;
  `GOOGLE_CLIENT_ID` and `LYNOX_MANAGED_CUSTOMER_EMAIL` are not masked).
  (#1996)
- Child agents and workflow steps started from a chat write under the chat's
  review: their writes are saved, "Rollback all" undoes them, and moves are
  refused while the review holds changes. A rollback deletes a file the run
  created only while it is still the file the run wrote; a write is blocked
  when the file could not be saved for the review. (#1948, #1958)
- A hard block in a run nobody watches is refused with a tool result.
  Agent-written text in danger prompts is shown as a single escaped line.
  (#1956, #1977)
- The bash guard reads curl's arguments and a wrapper's command as the shell
  does, asks about curl options it cannot read, and reads more of its rules
  in linear time. (#1876, #1984, #1990, #2002, #2009, #2028, #2037, #2061)
- `batch_files` refuses the eviction placeholder landing in the artifacts
  directory, and gallery saves and artifact restores refuse content that is
  only the placeholder (422 on the gallery route). (#1938, #1947)
- The voice paths pass the same input guard as `media_process`. (#1933)

### Fixed

- A bulk run no longer stalls when its first target already held the planned
  value; such targets take no place of the approved maximum and are not
  undone. Runs approved before the update keep counting such targets. (#1994)
- A failed IMAP search, or a connection that drops before the fetch, is
  reported as an error instead of an empty mailbox. (#2005)

### Internal

- Env registry rows for the egress proxy; a test requires every tier on rows
  emitted always and a secret stance on credential-named rows. (#1863, #1866)
- Tests: the second TLS hello, connected-account host forms, erasure of grant
  records, token-slot cases, shared grants through the real paths, held-back
  profile updates, the halt placement, the reviewed-grant GET override, a lost
  judged run resuming, the importer's mark, the state cookie of a person the
  owner let in and client-secret release, bulk judge wiring, failed extraction
  against the cost limit, force-push rules staying bounded, the
  restore-backlog shutdown. (#1862, #1868, #1879, #1901, #1905, #1910, #1913,
  #1915, #1920, #1923, #1986, #2024, #2045, #2050, #2072, #2079, #2081, #2088)
- Inbox eval relabels and pinned sets. (#1873, #1881, #1882, #1885)
- Interrupted-turn eval script and local embeddings in its tests; the shared
  hidden-character detector with a drift test. (#1902, #1917, #1927)
- CI: `eslint` in its own job, the error-text census names its difference,
  image scans fail without OS packages, a guard for run-group starters,
  `timeout-minutes` on every `ci.yml` job, hook checks at lower CPU priority,
  smoke cookies with the owner principal. (#1925, #1962, #1964, #1978, #2020,
  #2030, #2038)
- The unread untrusted-content epoch counter is removed; a strict decrypt
  that says whether it read the stored text, which the stores' lenient
  readers now go through; `mail_reply` and `mail_send` split into prepare,
  consent and commit in one call; Microsoft contract types. (#2000, #2010,
  #2035, #2082)
- Comments, test names and docs wording, including the Docker access-token
  command. (#1875, #1877, #1884, #2091, #2094, #2096, #2122)

## 2.16.0 — 2026-10-16

This release contains security fixes. Upgrading is recommended for every instance.

### Upgrade notes

- On first start `engine.db` moves from schema **27** to **36**, `history.db`
  from **58** to **62** and `agent-memory.db` from **6** to **7**. Every step
  is additive and there is no down path. `engine.db` gains
  `knowledge_entries.source_thread_deleted_at` (v28), the tables
  `entry_sources`, `profile_seeds` and `profile_seed_backfill` (v29): existing
  knowledge entries get the conversation they came from as their source in
  `entry_sources` at migration, and `profile_seeds` is filled once from the
  profile block when the engine first opens its knowledge store. Then
  `subject_mints` (v30), `bulk_runs.principal` and `mandate_id` (v31), the
  `bulk_runs.list_*` columns (v32), `connection_grants` (v33),
  `audit_log.recorded_at` (v34), `bulk_runs.cost_usd` and `cost_cap_usd` (v35)
  and the bulk judge columns on `bulk_runs` and `bulk_targets` (v36).
  `history.db` gains `pending_prompts.closed_reason` (v59),
  `pending_prompts.mandate_id` (v60) and the tables `deleted_threads` (v61)
  and `bulk_cost_days` (v62). `agent-memory.db` gains
  `memories.source_thread_deleted_at` (v7). The push-subscription store gains
  `created_by` and `mandate_id` columns. The mail state does not change.
  (#1689, #1693, #1698, #1700, #1718, #1738, #1743, #1746, #1757, #1793,
  #1802, #1819, #1846)
- On an instance provisioned by the hosting control plane (a hosted billing
  tier in `LYNOX_BILLING_TIER` or the legacy `LYNOX_MANAGED_MODE`, or
  `LYNOX_MANAGED_INSTANCE_ID` set), the owner signs in once more after the
  update: a session cookie without the owner's principal is refused there.
  Self-hosted instances keep accepting the old cookie and move it to the new
  form on the next refresh. (#1722)
- Backups made by an engine with a vault key are now signed. A restore of a
  backup without a signature (every backup made before this release, and one
  made without a vault key), with one that does not match, or on an engine
  without a vault key answers 409 with `code: 'unverified_backup'`
  until it is sent again with `allow_unverified: true`. The web UI asks before
  it sends that. (#1850)
- A request body without a `Content-Type` is refused with 415. API clients
  that send JSON must send `Content-Type: application/json`. (#1762)
- A server without `LYNOX_HTTP_SECRET` answers only when the `Host` header is
  `localhost`, an IP address, the host of an origin listed in
  `LYNOX_ALLOWED_ORIGINS`, or missing; other requests, the health route
  included, get 403 with a sentence naming both remedies. Such a server takes
  writes from a browser on localhost only from its own port. For the web UI's
  dev server, start the engine with
  `LYNOX_ALLOWED_ORIGINS=http://localhost:5173`. Entries of
  `LYNOX_ALLOWED_ORIGINS` that are not an http(s) origin are named at start
  and ignored. (#1759, #1825)
- A model id with a `[1m]` suffix is now sent as its base id, without the
  `context-1m` beta header, and gets the base model's context window:
  `claude-sonnet-4-6[1m]` now has 200k tokens, `claude-opus-4-6[1m]` and
  `claude-opus-4-7[1m]` keep 1M. (#1787)
- A write `http_request` sends to an account connected through a built-in
  sign-in provider is asked about every time, also for the owner. No
  capability contract or workflow grant covers it, so an unattended run with
  no one to ask no longer writes there through `http_request`; an approved
  bulk run writes there only in a measured form. (#1791)
- Workflow pre-approval is removed. A manifest step that carries
  `pre_approve` is refused by validation and at run time; remove the field.
  Library users: see Removed below. (#1789)
- The bexio preset no longer allows read access to bills, expenses, bank
  accounts, bank payments, transactions or the file archive. A profile that
  still names one of these scopes gets no connect link, and `fetch_token`
  does not renew its token, until the scope is removed with `api_setup
  update`. A profile on `api.bexio.com` that does not go through the preset
  can no longer write there. (#1812, #1821)
- `POST /api/sessions/:id/changeset/review` must send back the `runId` of the
  changeset it answers; without it, or with an earlier run's id, it answers
  409. (#1732)
- `pipeline_prompt_budget` is capped at 10 prompts per workflow run, whatever
  the configured value. (#1694)
- Approving an external bulk run that writes to a form nobody has measured
  needs `"unmeasuredConfirmed": true`; without it the approval answers 409
  `unmeasured_unconfirmed`. Bulk runs ship switched off
  (`bulk_runs_enabled`). (#1774)
- The Drive backup uploader no longer finds its `lynox-backups` folder by
  name. The first upload after the update creates a new root folder once;
  backups in the earlier folder stay in Drive but no longer appear in the
  restore list. (#1758, #1784)
- `magistral-medium-2509` and `magistral-small-2509` are removed from the
  model registry. With a `tier_preset` set, a `tier_set` slot in
  `config.json` that names one stops the engine from starting; replace
  such a slot before updating. (#1768)
- On an instance the control plane provisioned, engine plugins are not
  loaded, whatever `LYNOX_FEATURE_PLUGINS` says, and the
  `LYNOX_HTTP_ADMIN_SECRET` bearer reaches only the control plane's own
  routes. (#1753, #1783, #1813)
- A custom OAuth2 API profile whose `token_url` or request URL is plain
  `http:` stops working, including on a private network or loopback; move it
  to https. (#1856)

### Added: a scheduled workflow can ask its owner and wait for the answer

- A saved workflow whose steps ask questions only through `ask_user` can now
  be scheduled. Workflows that may ask for a secret (`ask_secret`) or ask a
  person another way (`ask_human`) stay unschedulable. One check decides this
  for the scheduler, `task_create`, the schedule preview, `POST /api/tasks`
  and the workflow library listing. (#1690, #1694, #1699)
- During a scheduled run, a step's question is stored, written to a thread of
  its own (one per run, marked unread) and sent to the owner as a
  notification. The run waits for the answer; steps of a parallel phase ask
  one at a time. A question waits up to 24 hours. A question that expires
  unanswered ends the run as failed before the next step ("Question not
  answered: …"), one that could not be put to the owner ends it with
  "Question not asked: …"; in both cases the owner gets the failure
  escalation. The
  owner's stop withdraws an open question and ends the run as stopped. Time
  spent waiting does not count toward the workflow's wall clock or the step
  timeout. (#1694)
- Asking gives a step no way to approve anything: the question goes through a
  channel of its own that no consent gate or guard reads. Such a step keeps
  `ask_user` and loses `ask_secret` and `ask_human`. (#1690)
- A value of `pipeline_prompt_budget` that is not a finite number falls back
  to the default of 5. (#1694)
- Such a workflow runs on its schedule or from an interactive chat: `POST
  /api/workflows/:id/run` answers 403 for it, `run_workflow` from an
  autonomous caller refuses it, the library shows no Run button for it, and
  `task_create` points to the library. The library's schedule dialog lists the
  steps that may ask and says that each answer is waited for up to 24 hours
  and that the schedule starts no other run while one waits. `update_workflow`
  says when an edit takes a workflow off its schedule. The workflow listing
  carries `schedulable` and `askingSteps`; against an engine without
  `schedulable` the web UI keeps the old rule. (#1699)

### Added: what a person the owner lets in holds ends with their access

- A request whose session belongs to a person the owner let in is refused
  with 403 and `code: 'mandate_revoked'` when that access has no recorded end,
  has passed its end or was revoked. The end is recorded first, so a revoke
  cannot be undone by a later login. On that code the web UI shows its
  session-expired notice with a link to sign in again. (#1733)
- Questions such a person's runs asked close when the access ends: at boot,
  every 5 minutes, and at once when a revoke is recorded, with
  `closed_reason = 'mandate_ended'`; the run waiting on one is released. Each
  question records the access it was asked under, and an answer given under a
  later access for the same address is refused (403). An answer that arrives
  after the access ended is not used. A question from such a person stored
  before this release counts as ended. (#1738)
- With `bulk_runs_enabled` on, bulk runs such a person planned and nobody
  approved end with the access, as
  `aborted` with the halt reason "the access that planned this run has ended
  before it was approved"; approve and resume answer such a run 409
  `mandate_ended`. Every new run records who planned it. A run from before
  this release counts as the owner's only when it was planned after
  2026-10-12 09:33:19 (UTC), in a conversation the owner started; any other
  such run ends. Approved runs are never ended this way. (#1743)
- Running work of such a person ends with the access, on a revoke and every
  5 minutes: their chat runs, the worker runs they started or whose question
  they answered, and the live run streams they follow. Runs are matched on who
  started them, so the owner's run in a conversation such a person created
  goes on. A chat run checks the access again once it is registered, a worker
  turn just before the model call. (#1750)
- Push subscriptions such a session added are tied to its access: after it
  ends nothing is sent to them, and they are removed at the next send or
  change. Such a session may turn on push for its own device, keeps at
  most 5 subscriptions, never replaces the owner's, and removes and tests only
  its own. (#1700)
- New admin route `POST /api/admin/mandates/revoke` with
  `{ "revoked_mandate_ids": string[] }` (at most 1000 ids). It applies the
  list idempotently and answers `{ "newly_revoked": n }`; 400
  `invalid_revocation` when the list cannot be read, then applying none of it,
  and 503 `mandate_ends_unavailable` without `engine.db`. (#1753)
- The web UI renews such a person's session before it ends, through
  `POST /auth/renew`, 4 minutes and again 1 minute before the end. The server
  asks the control plane only within the last 5 minutes, at most once per
  access every 30 seconds, with a 5-second timeout; without a valid answer the
  session ends at its time as before. Renewal stops 8 hours after the login,
  and a session created before this release is not renewed. The route answers
  403 to a request that does not come from the instance's own pages, and
  renews only where `LYNOX_MANAGED_INSTANCE_ID` and
  `LYNOX_MANAGED_CONTROL_PLANE_URL` are set. Logging out stops the renewal in
  every tab. The owner's session is not touched. (#1769)

### Added: the trail of a person the owner lets in

- Every GET or HEAD such a person's session makes to an `/api/` route it may
  read writes a `read` row to the instance log before the route answers: the
  route as registered, the request path and the values of the query parameters
  the route selects its data by. Other query values are left out and
  credential-shaped values are masked. A read whose row cannot be written is
  answered 503 and not run. The owner's reads write nothing. (#1777)
- Every other request of such a session that reaches its route writes an
  `attempt` row before the route runs and an outcome row after it: `done` for
  2xx, `refused` for any other answer the route gives below 500, `failed` for
  a 5xx or no answer. The row's target is the request path, masked where it
  holds a secret's shape; a chat request's outcome row follows when its run
  ends. These rows replace the per-route rows of the workflow delete, the
  task delete and the hand start of a trigger. A change whose attempt row
  cannot be written is answered 503 and not made. Such a person's OAuth
  consent writes its attempt row before the token exchange. (#1779)

### Added: erase one person from memory

- The owner can erase one person from the subjects view (a person subject,
  not the owner's own). `POST /api/privacy/person-erasure/preview` with
  `{ subjectId }` lists what would be removed, text included. Entries bound to
  the person always go; name matches are only shown and go only when the owner
  selects them. `POST /api/privacy/person-erasure` erases that set; it needs
  `"confirm": "ERASE_PERSON"` and the preview's `plan`, and answers 409
  `plan_changed` when the set changed since the preview. Both answers carry
  `Cache-Control: no-store`. (#1763)
- The erasure is refused with 409 while a chat runs (`runs_active`) or
  `DELETE /api/data` erases the instance (`erasure_in_progress`), with 503
  `stores_unavailable` when the memory stores are not open, with 503
  `key_unavailable` when stored text cannot be decrypted, and with 503
  `audit_unavailable` when the audit log cannot be written. The audit log
  gets an attempt and an outcome row with ids and counts only. A failed step
  answers 500 with the steps done and the one that failed; previewing and
  erasing again finishes the job. Deletes run with SQLite `secure_delete` on,
  and afterwards the write-ahead logs are folded in and truncated; `scrubbed`
  in the result says whether that finished. The erasure removes the person's
  subject, the knowledge entries and memories bound to them and the selected
  name matches; every preview and every result states its scope. On an
  instance the control plane provisioned, both routes refuse every bearer token with
  403 (`session_required`, or the control plane's own refusal for its admin
  bearer). Erasing the last person keeps the result panel open.
  (#1763, #1776)
- `deleteEntry` and `deleteBySubject` remove the erased text from the profile
  block before they delete the rows. If that step fails, the call throws and
  the rows stay, so a retry finishes the job. (#1748)

### Added: bulk runs (behind `bulk_runs_enabled`)

- `bulk_plan` takes `source_list` for `target_system: "http"`, beside
  `source_file` and `source_collection`; exactly one is required. The one list
  form is WooCommerce products (`/wp-json/wc/v3/products`), with filter values
  for `category`, `tag`, `status`, `sku`, `type` and `stock_status`, an
  `id_field` and the `after` fields to set on every element. The engine
  builds the page address itself, and links in the response are never
  followed. (#1746, #1752)
- Nothing is read when such a run is planned. Once the owner starts it, the
  engine reads the list page by page (50 per page, ordered by id, at most
  4 MiB per page) and halts so the owner can review the targets; each target
  is read only after a second start. `GET /api/bulk/runs/:id` returns
  `listFirstPage`, `listStartChecksum` and a `listNote` saying that a list
  read page by page can miss or skip elements that move while it is read.
  `POST /api/bulk/runs/:id/resume` needs `listChecksum` for a list still to be
  read. What the list holds is never shown to the model. (#1746)
- Write forms whose effect on unsent fields was measured on a real provider
  decide whether a run is "measured": WooCommerce products (PUT, PATCH and
  POST to `/wp-json/wc/v3/products/<id>`) and bexio contacts (POST to
  `/2.0/contact/<id>` on `api.bexio.com`). Approving an unmeasured apply run
  needs `"unmeasuredConfirmed": true`, and such a run needs a confirmed probe
  of its own before it writes more than one target. `GET /api/bulk/runs/:id`
  returns `writeFormNote` and `writeFormConfirmation`, and the run's status
  carries `writeForm`. An undo restores under its source run's confirmation.
  (#1774)
- `bulk_plan` takes `judge` instead of per-target `after` values: a rule (up
  to 4000 characters), a schema of up to 20 fields and a model tier (`fast` by
  default). It applies to `data_store` and `http` targets. No model is called
  until the owner starts the judging with a spend limit (`costCapUsd`) and the
  rule's hash (`judgeRuleHash`); for a list run that is the start after the
  list was read. Then one model call per target, with no agent tools and a
  structured answer only, decides that target's fields, and the owner approves
  the verdicts before anything is written. Only the schema's fields are sent,
  and only when they hold nothing shaped like a credential. A second judged
  run while one is started and unapproved needs `supersedes` with that run's
  id (else 409 `supersede_required`); starting it ends that run, and what it
  spent stays booked. (#1846)
- Every judge call is checked against the run's limit and the daily and
  monthly limits before it is made and booked when answered; the spend counts
  toward those limits and appears in the usage summary. On a hosted instance
  whose model key the control plane does not supply, starting a judged run
  answers 409 `judge_unavailable`.
  `bulk_status` shows a run's model spend and limit and how many targets have
  no verdict yet; `GET /api/bulk/runs/:id` adds `judgeModel`, and for the
  owner `judgeRule` and `judgeRuleHash`. A judged run started and never
  approved is deleted with its encrypted before-states 30 days after its
  start. A failure after a target's paid call releases the target and halts
  the run, so a restart judges it again. (#1819, #1846, #1851)
- A bulk run refuses an after-state that sets a field whose value has an
  effect at the provider: a WooCommerce order's `status`, `set_paid` or
  `customer_id`, a customer's `password` or `email`, any write to a
  WooCommerce webhook,
  and bexio payments and order repetitions. Such targets are marked
  `effect_field`, and the same check runs on every write the run sends. A list
  run whose list path is no longer offered halts. (#1760)
- A bulk run writes to an account connected through a built-in provider only
  in a measured form, after the person approved the run as a whole; an
  unmeasured write there is refused when sent, even after
  `unmeasuredConfirmed`. (#1791)

### Added: bexio writes

- The bexio preset allows five write scopes: `contact_edit`, `note_edit`,
  `task_edit`, `kb_offer_edit` and `kb_invoice_edit`, requested only when the
  profile names them. A profile that names `note_edit`, `task_edit`,
  `kb_offer_edit` or `kb_invoice_edit` must also name `contact_show` or
  `contact_edit`. (#1791, #1794)
- Before a write to a connected bexio account is asked about, lynox reads the
  account and shows what the write concerns: an existing invoice or quote by
  number, recipient and total (an invoice also by its open amount), a new one
  by recipient and the sum of its positions, and any other `/2.0/` write whose
  body names a `contact_id` by that contact's name. Other writes (a contact
  itself, a note or task edit without `contact_id`, paths outside `/2.0/`) are
  asked with the body only, as before. The write is refused without asking
  when such a reading fails, when a position cannot be summed, when a new
  invoice or quote names no `contact_id` or `currency_id`, when an edit of one
  has a body that is not a JSON object or changes its currency, when the path
  is percent-encoded or routes ambiguously, or when a `/2.0/` path targets
  another `kb_` document type. (#1794)
- Before a connect that asks for write access, the connect link first shows a
  page on the instance with bexio's customer text and the write scopes it
  asks for; the person continues to bexio only from that page. A confirmation
  without `Sec-Fetch-Site: same-origin` is refused (403), and one whose
  profile now asks for a different set of scopes than when the page was shown
  answers 409. (#1812)

### Added: bash in a separate shell container, when configured

- When `LYNOX_SHELL_EXEC_SOCKET` is set, the `bash` tool sends each command
  over that unix socket to an exec daemon in a separate container
  (`dist/shell-sidecar/exec-daemon.js`, same image) instead of running it in
  the engine's container. There is no fallback: with the socket set, a missing
  or refusing daemon fails the call, and a set but empty value is an error.
  Unset, `bash` runs in the engine as before. In this mode each call starts in
  the sidecar's workspace directory (`LYNOX_EXEC_WORKSPACE`, default
  `/workspace`), and two `bash` calls of one turn can run side by side.
  (#1816)
- The daemon runs each call as a uid of its own from a pool, and reuses a uid
  only after it has killed every process of it and removed what it left in IPC
  objects, `/dev/shm`, `/dev/mqueue` and its call directory. A call gets
  `HOME` and `TMPDIR` in its own call directory and a fixed `PATH`; engine
  path variables are dropped. A call's time limit is at most 15 minutes; a
  `timeout_ms` of 0, unlimited in the engine, becomes 15 minutes. The
  daemon's own settings (`LYNOX_EXEC_*`) are read by the sidecar only. The
  image adds `tini`, a group `lynox-ws` (gid 1002), which the engine user
  `lynox` joins, and `/run/lynox-exec`.
  (#1816)

### Added: a workspace root outside the data directory

- `LYNOX_WORKSPACE_ROOT` names the directory that holds the workspaces.
  Unset or empty, it is `<data dir>/workspace` as before, created when
  missing. A `LYNOX_WORKSPACE_ROOT` that does not exist or is not a directory,
  a root that cannot be read or entered, or a context directory below it that
  cannot be read, written or entered stops a server boot with a message naming
  the path. A root that is the data
  directory, contains it or lies inside it is refused, by path and by device
  and inode. A path naming the old `<data dir>/workspace` location is mapped
  onto the configured root by the file tools and the file area once
  `<data dir>/workspace` is empty; while it still holds files, such a path is
  refused. (#1823, #1845)
- Backup, migration export and import and the data erasure reach the
  workspace through a directory handle opened on the root at boot and do not
  follow symbolic links below it; a root moved or replaced after boot makes
  them fail until the engine is restarted. `GET /api/admin/workspace/status`
  (admin scope; on an instance the control plane provisioned, its admin bearer
  reaches it) reports `workspace_root_mode`, `workspace_root_is_mount` and
  `workspace_legacy_pending`, or answers 500 `workspace_root_unusable`.
  `node dist/scripts/data-dir-sweep.js` takes `--workspace-root=PATH` (else
  `LYNOX_WORKSPACE_ROOT`) and, with an external root, reports files left under
  `<data dir>/workspace`; it exits 1 when it finds any.
  (#1823, #1824, #1839, #1845)
- `LYNOX_WORKSPACE` is read by the CLI only and is no longer copied into the
  `workspace_dir` config key, which nothing read; `workspace_dir` is still
  accepted in `config.json`. (#1823)

### Added: other

- The schedules view shows a "Running" badge and a "Stop run" button on a
  trigger whose run can be stopped. `GET /api/triggers` marks each row with
  `running` and `stoppable`; a person the owner lets in gets both only for
  runs they started. `POST /api/tasks/:id/stop` now answers its 409 with a
  `code` (`not_running`, `unstoppable` or `ambiguous_id`), and the view gives
  a sentence for each. (#1764)
- `validateAgainstSchema` accepts `minLength` / `maxLength` on strings,
  counted in code points, and `additionalProperties: false` on objects; both
  are opt-in. (#1773)
- The tier vocabulary gains the value `managed_max` for `LYNOX_BILLING_TIER`
  (and the legacy `LYNOX_MANAGED_MODE`), a tier on which the control plane
  supplies the LLM key. The web UI reads the tier through one check. (#1805)
- Requests to `api.fireworks.ai` carry a `prompt_cache_isolation_key` derived
  from the instance's cache-key salt. (#1818)
- The artifact list and `GET` of an artifact mark `lostOnSave` when the
  stored file (at most 2 KB) holds the engine's placeholder for a saved body;
  the list badges it "Content missing", and the view shows a notice instead of
  rendering it and hides print and share. (#1844)

### Changed: private mode

- A memory write already in flight when a chat switches to private mode is
  dropped; an extraction already paid for
  is billed once. A document uploaded into a private chat is not chunked into
  the knowledge archive, and a switch during a long ingest stops the remaining
  chunks. (#1715, #1716)
- From this version on, a durable entry records every chat that says it,
  with that chat's wording; an entry created before the upgrade has its first
  chat as its only source. When one chat goes private, only its contribution goes: an entry
  also said elsewhere stays, in the remaining chat's words, trust and pin; an
  entry with no source left is deleted. `GET /api/export` lists each source's
  wording under `durable_knowledge.sources`, masked. A line of the `profile`
  block is removed only when it was seeded from the removed entry. (#1718)
- Subjects a chat created are removed when it goes private, once nothing else
  holds them. (#1698)
- A workflow started from a chat runs its steps in that chat's private mode,
  read live, including nested pipelines, saved-workflow runs and their
  retries. What a workflow step or a `spawn_agent` child stores is recorded
  under the chat it runs for and goes when that chat goes private. A
  sub-agent running when the switch is flipped stops capturing too. Scheduled
  and headless runs carry no chat and are unchanged. (#1721, #1736, #1741)
- The chat header's switch shows "off" with an error toast when the request
  got no answer, or a server error that names no stored state. The toggle
  explains what private mode keeps and that workflows saved in the chat run
  later without private mode. (#1721, #1761)

### Changed: deleting a conversation

- `DELETE /api/threads/:id` still keeps the durable entries and memories
  captured in that conversation, and now stamps them `source_thread_deleted_at`
  (`KnowledgeEntry.sourceThreadDeletedAt`); they stay recallable. If marking
  fails, the route answers 500 and the conversation is not deleted. (#1689)
- A deleted conversation's id is recorded, and no thread is created under it
  again; `POST /api/sessions` answers 410 `thread_deleted` for it, and the web
  UI says the conversation was deleted and marks its queued turns as failed.
  Questions a running workflow waits on there are withdrawn and the run ends
  ("Question withdrawn"; a scheduled one as `stopped`, without retry or
  escalation). An escalation or a worker answer whose conversation was deleted
  continues in a new one. (#1757)

### Changed: questions

- When the user closes an `ask_user` question or it expires, the model gets a
  sentence saying so and telling it not to act on any option. In a batch, an
  unanswered question reads `(no answer)`, and a plan in `plan_task` that got
  no answer approves nothing. (#1697)
- `plan_task` is exempt from the 15-minute tool timeout, like `ask_user`. When
  another tool times out while its question is open, that question is
  withdrawn, and this does not count as the user's denial for the rest of the
  batch. (#1697)
- An answer to a question an engine restart closed gets 410 with code
  `process_restarted`. `POST /api/triggers/:id/run` refused as already running
  names `leaseUntil`. (#1693)
- Answering a secret question or a mail connection by `promptId` settles
  exactly that question: an unknown id answers 404, one of another session or
  kind 409, an expired one with the reason it was closed, an answered one 200,
  and one that can no longer be settled 410. Only a request without a
  `promptId` settles the open one. (#1696)

### Changed: changeset review

- `GET /api/sessions/:id/changeset` and the `changeset_ready` event carry a
  `runId`, which the review must send back (see Upgrade notes); the review
  answers 409 while a run is in progress. (#1730, #1732)
- A file that was backed up but not changed is not reported, and the
  changeset is settled when its run ends, so "Rollback all" resets only what
  the review showed. An existing file whose read or copy failed stays
  `modified` and is not deleted by "Rollback all". The changeset is relative
  to the workspace. (#1691, #1730)
- Only files a write tool can change are tracked: the workspace, `/tmp` and
  the artifacts directory. An artifact edited with `edit_file` can be reviewed
  and rolled back. The diff preview reads the file as the write tool resolves
  the path. (#1836)
- In the web UI, a typed message, a voice transcript and a retry are kept when
  an open review holds the send, and the automatic re-send on reconnect waits
  for the review. (#1691, #1732)

### Changed: deleting a schedule while it runs

- `DELETE /api/tasks/:id` on a schedule whose `run_workflow` or `run_agent`
  run is in flight also stops that run when the caller may stop it. The
  response carries `run`: `stopped`, `not_running`, `effect_kept`,
  `not_stopped`, `unstoppable_now` or `stop_failed`. (#1695)

### Changed: models and pricing

- Every Anthropic and Vertex client the engine builds drops or rewrites
  request fields a model rejects, from rules on the model's capability entry
  (sampling fields, `thinking: {type: 'disabled'}`, a forced `tool_choice`
  becomes `auto` with an instruction). Message batches, the endpoint key test
  and the Docker installer's key check are shaped the same way; a batch that
  forces a tool on a model that rejects it is refused before sending. Ids not
  in the capability table get no rules; a `[1m]` suffix is still removed.
  (#1681, #1781)
- The capability table gains `claude-opus-5-5`, `claude-sonnet-5-5` and
  `claude-haiku-5-5` with prices; they are not offered in a model selector.
  The `[1m]` variants no longer have entries of their own (see Upgrade notes);
  the first request with such an id writes one line to stderr. (#1681, #1787)
- A forced-tool reply that skipped the tool or was cut off at `max_tokens` is
  booked once and reported on stderr at every site that forces a tool; the
  search reranker then reports `skipReason: 'cut-off'`. A plan reply without a
  plan and a refused structured extraction are booked too. The follow-up
  suggestion budget is 960 tokens (was 512). (#1681, #1705)
- A helper call aborted before its reply counts toward the run ceiling and
  the session cap with an upper bound of its cost; it is not debited to the
  customer. The search reranker's timeout now aborts its request. (#1706)
- Six Fireworks ids the provider no longer serves leave the model picker
  (`glm-5p2`, `deepseek-v4-pro`, `deepseek-v4-flash-0731`, `qwen3p7-plus`,
  `kimi-k2p6`, `kimi-k2p7-code`); they keep their prices. A tier slot that
  names one shows the tile's first model in the settings editor, and the next
  save of that page stores it. DeepSeek v4.1 Flash
  on Fireworks is priced at $0.30 input, $0.006 cached and $1.20 output per 1M
  tokens (was $0.22 / $0.007 / $0.66). (#1735, #1767)
- Retired Mistral ids that Mistral answers with a successor are priced, and
  given the window, of the model that answers (`mistral-medium-2508` and
  `mistral-medium-latest` as `mistral-medium-2604`, `ministral-8b-2410` and
  `open-mistral-nemo` as `ministral-8b-2512`, `ministral-3b-2410` as
  `ministral-3b-2512`, `magistral-small-latest` as `mistral-small-2603`).
  `mistral-small-2603` is priced at $0.15 / $0.60 with a 262 144-token window;
  `ministral-3b-2512` has 131 072 tokens (was 262 144).
  `magistral-medium-2509` and `magistral-small-2509` are removed from the
  table (see Upgrade notes). (#1768)
- The inbox classifier's default Mistral model is `mistral-small-2603`
  instead of `mistral-small-latest`, with its cost rates taken from the model
  registry ($0.15 input, was $0.20). The installer and setup banner offer
  `codestral-2508` instead of `codestral-latest`. (#1768, #1772)

### Changed: exports and logs

- `GET /api/export` includes every flat-file memory scope (`memory_scopes`,
  also when memory is off) and every contact, deal and DataStore row; the
  contact, deal and DataStore rows are read from one shared budget of
  250 000 rows. `contacts_may_be_incomplete` and `deals_may_be_incomplete`
  say when that budget ran out, `datastore_may_be_incomplete` also when a
  collection could not be read, and `memory_scopes_may_be_incomplete` when a
  memory file or directory could not be read.
  (#1714, #1745)
- The debug export's durable-knowledge block gains `status_counts`. (#1751)
- The opt-in measurement logs and the wire capture are written to the
  configured data directory, also with `--data-dir`, and are removed by
  `DELETE /api/data` instead of blocking it with 409. (#1704)
- The vault rotation route re-keys the vault in the configured data
  directory, and the prompt-cache salt follows `--data-dir`. (#1817)

### Changed: Google

- When a Google connect comes back without access, the Google settings card
  says why, also on a self-hosted setup, which no longer shows Google's raw
  error page. A revoked-grant message mentions that a Workspace admin may
  have blocked the app. (#1740)
- The Drive uploader keeps the id of its `lynox-backups` root in
  `gdrive-backup-root` in the data directory and finds the root only through
  it, never by its name. Without a
  stored id, or when the stored folder is gone, in the bin, no longer the
  user's or the account changed, it creates a new root. A failed Drive lookup
  or a pin that cannot be read or written fails the upload. Disconnecting
  Google deletes the backup files lynox uploaded and the user owns, in every
  folder named `lynox-backups`. `fileRootPin` and `RootFolderPin` are
  exported, and `GDriveBackupUploader` takes an optional `{ rootPin }`;
  without one it refuses to upload. (#1758, #1784)
- The `create_event` confirmation lists every field the request sends, and
  the `update_event` confirmation each changed field and whether the guest
  list is replaced or cleared; the request is built from the object shown.
  `update_event` refuses an `updates` field outside a fixed list, and both
  refuse a guest without an email address. (#1811)

### Changed: API profiles

- Each API profile carries a grant, an id for one epoch of its credentials,
  recorded in `engine.db`. A new grant starts when the profile is created, on
  a new OAuth consent, when a save changes the credentials or where they go,
  when a credential it reads is stored or found changed at boot, and on a
  token renewal the grant did not record. Existing profiles get one at the
  first boot. After a new consent the grant record is built new.
  `GET /api/api-profiles` and `GET /api/api-profiles/:id` do not return the
  grant's credential fingerprints. (#1793, #1795, #1807)
- A profile that keeps its OAuth client id or secret under one of its own
  token names is refused on save and not registered at boot; `fetch_token`
  refuses an `output_secret_name` that is the client id or secret slot.
  Saving a profile under an id another kind of connection uses is refused.
  (#1806, #1815)

### Changed: backup, restore, migration and erasure of the workspace

- A backup skips FIFOs, sockets, devices and names that are not valid UTF-8
  in the workspace, as it already skipped symbolic links, and lists all of
  them as `skipped`. A
  workspace file that cannot be read, or a mount below the root, fails the
  backup. (#1839)
- A restore stages the workspace files inside the root and commits them only
  after the data-directory files are swapped in. An encrypted backup's
  workspace files and the key check are decrypted in memory. The migration
  export names files it could not carry as `skipped`, and the import names a
  path the target cannot store. (#1839)
- The data erasure empties the workspace root in place, follows no link below
  it, refuses before deleting anything when a mount is below it or when bind
  mounts make root and data directory overlap, and fails with
  `failed: ["workspace"]` when it cannot reach the root. (#1839, #1845)

### Changed: other

- An uploaded document cut at the extraction limit says so in its first line
  ("CUT: only the first N of M chars are included"). (#1755)
- The `mail_send` and `mail_reply` previews quote the account id and add the
  display name the recipient sees. (#1770)
- `GET /api/files` answers a failed listing with an error (404, 400 or 500)
  instead of an empty folder, and a path with a NUL byte with 400. (#1822)
- On boot, empty CRM collections in the CRM's current shape are kept instead
  of being dropped and recreated. (#1834)
- The voice settings say that a chosen voice is used for every language.
  (#1703)

### Removed: workflow pre-approval

- Workflow manifest steps can no longer pre-approve tool calls: a step that
  carries `pre_approve` is refused by `validateManifest` and `runManifest`; a
  warned call is asked about when someone is watching and refused in an
  unattended run. The pre-approval tables in `history.db` stay; nothing writes
  them. The CLI pre-approval dialog and the `lynox:preapproval:*` diagnostics
  channels are removed. (#1789)
- Breaking for library users: `extractMatchString`, `matchesPreApproval`,
  `buildApprovalSet` and `isCriticalTool` are no longer exported
  (`globToRegex` still is); `AgentConfig` loses `preApproval` and `audit`,
  `ManifestStep` loses `pre_approve`, `spawnInline` / `spawnViaAgent` lose
  their `preApproval` parameter, the types `PreApprovalPattern`,
  `PreApprovalSet` and `PreApproveAuditLike` are gone, and `RunHistory` loses
  its five `*PreApproval*` methods. (#1789)

### Security: what a session of a person the owner lets in may do

- Adding a passkey, creating a device link code and revealing the access token
  or the vault key are owner-only; any other session gets 403, and the passkey
  `status` reports `canRegister`. (#1688)
- The owner's session cookie carries a signed owner principal
  (`LOGIN_PRINCIPAL_VERSION` 2; see Upgrade notes). (#1722)
- Every user route, GET included, declares what such a session may do;
  `GET /api/google/oauth-url` is owner-only. Such a session's GET and HEAD
  requests are subject to the cross-site check before their read is written
  to the trail. (#1717, #1826)
- An owner's vault name is released to such a person's profile only when
  every address it goes to is https. The release question names every field
  whose change ends the release and that the profile also sends it for the
  owner's own and bulk runs. (#1849)
- The managed login page takes any address, and a rejected code shows its
  own text. (#1731)

### Security: the control plane's access

- On an instance the control plane provisioned, its admin bearer reaches only
  `GET /api/export`, `POST /api/admin/mandates/revoke`,
  `GET /api/admin/google/status`, `POST /api/admin/google/revoke` and
  `GET /api/admin/workspace/status`; every other route answers 403. Its
  requests act as a principal of their own. Registering a fixed-path route
  twice fails the boot. Self-hosted instances are unchanged. (#1753,
  #1783, #1823)
- Every request of the admin bearer and the migration token that reaches a
  route writes an `attempt` row and an outcome row to the instance log, with
  the actor `cp-admin` or `cp-migration` and ids only; `recorded_at` is when a
  row was written, `ts` when the act happened. Refusals of the admin bearer on
  other routes are rate limited. The export's answer carries
  `X-Lynox-Audit-Target` and a `Content-Length`. (#1802)
- The control plane's Google revoke answers 400 `drive_deletion_owner_only`
  for any `delete_drive_backups` value but `false`. (#1780)

### Security: requests a browser sends on its own

- Without `LYNOX_HTTP_SECRET`, a write from a browser is refused unless its
  `Origin` is an allowed origin or this server itself, reached as `localhost`
  or by IP address, on its own port; requests with neither `Origin` nor
  `Sec-Fetch-Site` (curl, the CLI, MCP clients) pass this check but still meet
  the `Host` check (see Upgrade notes), and an `Origin` of `null` is never
  allowed.
  (#1759, #1825)
- A request another site made the browser send, signed in by the session
  cookie or sent to a server without a secret, is refused with 403 when it
  writes or when it is a GET or HEAD on a route that does more than read.
  Bearer tokens are not affected. (#1762)
- The Google sign-in loopback callback checks the flow's state before it
  reads anything else. (#1825)

### Security: the `http_request` write gate

- Every header of the `X-Forwarded-*`, `X-Original-*` and `X-Rewrite-*`
  families is refused on a write; `X-Forwarded-For` and `X-RapidAPI-Host` stay
  allowed. (#1737)
- The write gate reads method overrides in more forms. A write that names
  several methods is gated as all of them, and one whose method cannot be
  determined is gated as the strongest method.
  (#1701, #1709, #1756, #1765, #1798)
- The gate reads a request again after the engine attached a profile's
  credential, in `http_request` and in bulk runs; a request whose method,
  named writes or re-targeting header changed is not sent. (#1797)
- An approved write is not followed as a write across a redirect that changes
  scheme or port, except plain http upgraded to https on the default ports.
  (#1734)
- A write approval question hides any part that decodes to a stored secret.
  (#1742)
- An API profile's `auth.header_name` may not be a method-override header, a
  re-targeting header, `Content-Type` or `Content-Encoding`. (#1766, #1798)
- A reviewed workflow grant whose step templates set a header a run under it
  may not send is refused when accepted; the refusal names the headers (up to
  three, the rest counted). (#1712)
- A profile on a built-in provider's API host must go through that provider:
  another profile there is refused on save, and a write through one saved
  earlier is refused before its credential is attached. A write to such a
  host with no profile is refused, and a redirect onto it is not followed.
  (#1821, #1835)
- A write to a connected account is refused when its path or query is
  percent-encoded, too long to show or not plain `key=value` pairs, or when it
  sets a header other than `content-type: application/json` (optionally with
  `; charset=utf-8`) or `accept: application/json` / `*/*`. A provider profile
  that names its own token header is refused. A write whose body the question
  cannot show whole is refused. (#1791, #1812)

### Security: shell, files and the image

- Every rule in the bash danger list states what happens in an unattended
  run. Commands that reach another system, run fetched or decoded code, read
  `/proc`, or change services, cron, firewall or users are asked about in an
  unattended run and refused where there is no one to ask; a capability
  contract lifts the question, except for rules blocked outright (such as
  `git push`). In a chat, rules only the unattended list held are
  asked about too. (#1687)
- The bash danger check normalizes line breaks and line continuations before
  it matches a command. (#1782)
- The secret-file rule of the bash and file guards is built from the
  data-dir inventory. (#1707, #1713)
- The file area refuses a dangling symbolic link and a missing path below a
  link that points out of it. (#1822)
- In the Docker image every program is execute-only for the runtime user, and
  the code under `/app` and the entrypoint belong to root and are read-only
  for it. (#1804, #1828)
- The artifact print preview runs only its own script, by a per-document
  nonce. Mermaid diagrams are rendered with `securityLevel: 'strict'`.
  (#1796, #1801)

### Security: secrets, triggers and backups

- `POST /api/sessions/:id/run` masks credential-shaped values in a typed
  message before the run starts, and a credential typed as the answer to an
  open question is masked before it is stored or given to the model.
  (#1728, #1747)
- `task_update` checks a firing trigger's title and description for
  instructions as `task_create` does. (#1708)
- The retrieval shadow log stores an HMAC of the query under a per-process
  salt. (#1704)
- Backup manifests carry an HMAC keyed from the vault key (see Upgrade
  notes). Each file is checked against its manifest checksum before it is
  staged, and in an encrypted backup every file must be encrypted. A restore
  and a backup verify refuse a manifest entry whose path leads outside the
  backup. (#1843, #1850)
- Drive backup download and delete act only on a backup folder directly under
  the uploader's own root that the user owns and this app created; a download
  checks the whole tree before writing and creates files exclusively. (#1775)
- An OAuth2 API profile's client secret and the access token it mints travel
  only over https: saving a profile with a `token_url` that is not `https:` is
  refused, a token exchange or renewal against a non-https endpoint is refused
  before anything is sent, and an OAuth2 request to a non-https URL is refused
  before any vault read. Built-in sign-in presets are unaffected. (#1856)

### Fixed

- An evicted `artifact_save` call loses its `content` field. (#1686)
- After a run stopped server-side mid-answer, the live chat shows the run's
  note below the partial answer without a reload. (#1723)
- The agent's "please continue" turn after a `max_tokens` stop is no longer
  shown as a user message. (#1727)
- A sub-agent's `error` event carries `subAgent` / `subAgentId` and is
  forwarded as non-fatal. (#1711)
- A chat stop that arrives while a turn is still being prepared ends that turn
  before the model call. (#1750)
- A fact marker with an unknown provenance tier is shown as the lowest tier.
  (#1749)
- A workflow step's recorded tool calls pair each result with its call by
  tool-use id and name; `tool_call` and `tool_result` events carry an
  optional `toolUseId`. (#1788)
- The usage summary counts a run on a window's first and last day in the
  right window, and a window ending mid-day has a bucket for its last day.
  `GET /api/history/runs` compares `dateFrom` the same way and answers 400 to
  a `dateFrom` or `dateTo` that does not start with a `YYYY-MM-DD` date.
  (#1840, #1854)

### Internal

- Tests: the delegation row waits for its children; spawned children run
  neither helper fallback; the bulk targets route and profile reads by a
  person the owner lets in go together; the brokered Google reload on
  disconnect. (#1710, #1719, #1744, #1792)
- Comments only: the format-character fold, the history.db v43 migration,
  how a voice is chosen. (#1724, #1739, #1786)
- Bash pre-approval patterns were narrowed before the feature's removal; no
  effect in this release. (#1785)
- Online checks for Fireworks picker ids, the Mistral served-as map and
  priced Anthropic ids; a model-tier eval for the bulk judge; the inbox eval
  names fixtures it archived without a match; a test against Mistral
  `-latest` aliases. (#1735, #1768, #1771, #1772, #1778, #1841)
- CI and build: Docker Hub images through mirror.gcr.io; the Whisper model
  through `scripts/fetch-pinned.sh` with a second source; a pre-push eslint
  hook; per-lockfile osv scans; override floors checked in both lockfiles;
  `nanoid@3` floor `^3.3.18`; docs dependencies; each test run gets its own
  home; shell sidecar and image smoke probes. (#1720, #1726, #1754, #1800,
  #1803, #1808, #1809, #1810, #1816, #1828)
- The PR record check: security gate for the web UI's login code, legal
  sign-off read as approver and date, PR title and body checks, and its prose
  and link parsing. (#1799, #1814, #1820, #1827, #1832, #1833, #1837, #1838,
  #1842, #1848)
- Docs: Mistral location wording; the Mistral sub-processor row; README test
  count. (#1729, #1829, #1830, #1831)
- Contract types and a token-error classifier for a future sign-in provider.
  (#1847, #1853)
- `data_dir` resolution through one helper; opt-in retry, cut-off and pricing
  options in the structured-output helper. (#1817, #1846)

### Rollback to 2.15.4

2.15.4 boots on the migrated databases: its migration loops do nothing at a
higher version, and every new column is nullable or has a default. The
schema stays at the new versions.

Before rolling back:

1. Do not roll back an instance whose `LYNOX_BILLING_TIER` is `managed_max`:
   2.15.4 does not know the value. It keeps the usage hook and the
   managed-instance refusals, but drops the control plane's config and secret
   locks and reports the instance as self-hosted.
2. If `config.json` has a `tier_preset`, no `tier_set` slot may name
   `claude-opus-5-5`, `claude-sonnet-5-5` or `claude-haiku-5-5`; 2.15.4 does
   not know them and stops loading the configuration.
3. With an external `LYNOX_WORKSPACE_ROOT`, move the files back under
   `<data dir>/workspace` first: 2.15.4 ignores the variable, and files under
   the external root are neither visible, backed up nor erased.
4. Where `bulk_runs_enabled` is on, finish or abort every list or judged bulk
   run first; 2.15.4 does not know either kind.

After rolling back:

- Every owner session cookie 2.16.0 issued or refreshed carries the owner's
  principal, which 2.15.4 refuses: the owner signs in again.
- Every protection of this release is gone, among them the host and
  cross-site checks, the admin-bearer scope, the access-end handling and trail
  of a person the owner let in, session renewal, the per-write question for
  connected accounts and the other write-gate rules, the backup signature and
  manifest path checks, OAuth over https only, the plugin lock on provisioned
  instances and the unattended bash rules. `GET /api/api-profiles` returns the
  grant fingerprint fields again. A bexio profile that names a write scope
  gets no connect link and no token renewal until the scope is removed; the
  access token it already holds keeps its write scope until it expires, so
  disconnect such a profile before rolling back.
- Deleting a conversation no longer stamps what it captured, and 2.15.4 shows
  entries that 2.16.0 stamped as ordinary entries. A deleted conversation's id
  can be reused. 2.15.4 finds the Drive backup folder by
  name again and may list a different root than 2.16.0 used.
- Backups made by 2.16.0 restore on 2.15.4. What 2.16.0 removed stays
  removed: private-mode and person erasures and expired judged runs.
- Upgrading again runs no schema migration a second time; the grant check runs
  at every boot. Backups made under 2.15.4 are unsigned: after the upgrade
  their restore answers 409 `unverified_backup` until it is sent with
  `allow_unverified: true`. Knowledge entries, created subjects, questions and
  bulk runs written under 2.15.4 carry none of the new bookkeeping; such a
  question from a person the owner let in counts as ended, and an entry
  written then can be removed when a chat that later restates it goes private.
  Connection grants are repaired at the next boot.

An export from 2.15.0 or later must not be restored onto an instance running 2.14.x or older: those versions restore only the parts they know and report success, silently dropping merge ledgers, `apis/` and `workspace/`. Upgrade the target first.

## 2.15.4 — 2026-10-12

### Added: access for a person the owner lets in, not active

- This release contains the engine side of time-limited access for a second
  person, alongside the owner. Such a login exists only when the hosting
  control plane answers a login with it; a self-hosted instance never gets
  one. Without such a login every request acts as the owner and behaves as
  before. (#1605, #1609, #1616, #1624)
- A session for such a person is carried in the signed session cookie. It
  ends at most 15 minutes after login or when the access ends, whichever is
  first, and is not renewed. The web UI's login requests to the control plane
  carry a `principal_version`; a login answer whose principal the web UI
  cannot read is refused rather than taken as the owner, and one whose access
  has already ended gives no session. The engine stores when each access ends
  and refuses a session whose access ends before the session would. (#1616,
  #1653)
- Every write route a user session can reach declares what such a session may
  do there; the admin routes are closed to it. Among others, the routes that
  change the configuration, memory, knowledge or onboarding progress; store or
  delete a secret; connect or disconnect Google; add or remove a mail account
  and act on the inbox; confirm a schedule or grant a workflow unattended
  writes; run, rename or delete a workflow from the library; approve, resume,
  confirm the probe of or undo a bulk run; take back a merge; save or delete
  an artifact; delete a contact, an API profile or files; create a backup; or
  erase all data (`DELETE /api/data`) answer such a session 403. (#1605,
  #1641, #1642)
- Conversations, runs, questions waiting for an answer, to-dos, schedules and
  API profiles record who made them. Such a session may keep to-dos of its
  own. A run such a person started is not retried. (#1605, #1638, #1644, #1652)
- A schedule such a person created or last changed does not run, whatever its
  effect, until the owner confirms it. They may start such a schedule by hand,
  once per request, without changing its next run. (#1605, #1609)
- A turn such a person starts gets only a fixed set of the engine's built-in
  tools: no shell, no file tools and no plugin or MCP tools. This applies to
  every agent the turn builds, including sub-agents and workflow steps. Such a
  turn resolves no `secret:` reference at all; a secret reaches a request only
  through an API profile, which attaches it. In such a session no
  `http_request` write approval is kept: each write that no capability
  contract covers is asked about on its own, a write to an account connected
  through a built-in sign-in preset is refused, and the session is told to
  propose the change to the owner instead, and a write whose body the
  question cannot show (over 64 KiB, or holding a stored secret in an escaped
  or encoded form) is refused. (#1624, #1638, #1639, #1651, #1674)
- An API profile such a person set up reads a stored secret of the owner's
  only after the owner released that name to exactly that profile. Saving
  such a profile records which of the owner's names it asks for; the owner
  sees the open requests in `api_setup` answers and releases one with
  `api_setup` `release_secret`, which asks the owner in person and names the
  hosts the value goes to. It is refused in a run without a person present.
  `withdraw_release` takes a release back. A release ends when the profile's
  destination or authority changes, when the access ends, and does not count
  for another person's access. Only credentials the engine attaches can be
  released; provider keys, infrastructure secrets, values from the engine's
  environment, connection tokens, names a built-in provider's profile reads
  and names a profile from another person's access reads cannot. (#1674)
- Such a person can set up and connect accounts of their own through a
  built-in sign-in preset. Their tokens go only to that profile's own token
  names, and a connection stops working when the access ends. Once the access
  has ended, the owner's `api_setup` answers name such connections, and the
  owner can take one over with `api_setup` `adopt_connection`, which asks
  first. (#1657, #1663, #1665)
- Each write such a person makes outside the instance, each schedule they
  start by hand and each schedule they delete is recorded in an append-only
  log before the act. When that record cannot be written, the act does not run; a request to the API then answers
  503. The owner's acts are not recorded there,
  except releasing a stored secret to such a profile or taking a release
  back. (#1641, #1674)

### Changed: erasing all data

- `GET /api/export` now includes threads without messages and no longer stops
  at 200 threads; if the thread list may be incomplete, the answer says so with
  `threads_may_be_incomplete: true`. Before, it stopped at 200 threads without
  saying so. (#1596)
- `DELETE /api/data` now empties every table of `history.db` (runs, tool
  calls, answers to questions, request snapshots, the security log) except its
  migration ledger and one backfill marker, every table of `agent-memory.db`
  (including retired memories) except its migration ledger, and every thread,
  including threads without messages. Before, memories were only marked
  inactive, the run records stayed, and so did threads without messages and
  threads past the first 200. What the daily and monthly spend limits and the
  hourly and daily limits of the `http_request` and mail-send tools count
  starts again from zero with them. (#1596, #1606, #1615)
- Vault entries written after start-up, such as mail credentials and Google
  tokens, are erased too. (#1628)
- Mail state, push-notification subscriptions and the memory files of every
  scope are erased as well. (#1631)
- The erasure also removes the files the instance keeps in its data directory
  and its local backups, and the backups lynox wrote to a configured backup
  directory outside it; other files there are left alone. It keeps files that
  hold no user content: the vault key, the
  HTTP secret, the login token, `.env`, the push identity, plugins, and a few
  markers and caches. The data directory is scanned first: an entry the
  instance does not know stops the erasure before anything is deleted, and so
  does a link, or an entry on another filesystem, among the entries it would
  remove. Unknown
  entries can be confirmed by sending the reported `unknown` list back
  unchanged as `remove_unknown`; if any of them changed in the meantime, none
  is removed. The 409 answer that reports unknown entries also lists what the
  erasure removes and what it empties in place. (#1631)
- It answers 409 and deletes nothing while a mail account is set up, Google
  is connected or being connected, an API sign-in is in progress, the inbox is
  working, or a backup or restore runs. Each such answer has a `code` and says what to do.
  Remove mail accounts and disconnect Google before erasing. (#1631)
- Running chats are stopped before the erasure starts. A chat request during
  an erasure answers 409, and one that an erasure overtook answers 410. If a
  chat does not stop within five seconds, nothing is erased and the request
  answers 409 (`runs_did_not_stop`). A second erasure at the same time answers
  409 (`erasure_in_progress`). While an erasure runs, connecting Google or an
  API account, adding a mail account, backing up and restoring answer 409 as
  well.
  (#1623, #1631)
- The answer now says when part of the erasure failed: a
  failed store gives HTTP 500 with `deleted: false` and the list of failed
  stores, and a store that could not be opened while its file exists counts as
  failed. When every store was erased but a later step failed, the answer is
  HTTP 500 with `deleted: true` and a `degraded` list. (#1596, #1627, #1628, #1631)
- Every database that holds user data now overwrites deleted rows on disk.
  After an erasure, each database is rebuilt without its free pages and its
  write-ahead log is emptied. (#1621, #1631)
- After an erasure, contact reads work again without a restart. (#1596)
- The route is still refused (403) on hosted instances, and only the owner may
  call it. (#1641)

### Changed: debug captures are deleted after seven days

- The extended debug capture now keeps each snapshot for seven days. On every
  start, and hourly while it runs, the engine deletes `wire_snapshots` rows
  older than that (by capture time) from `history.db`, and capture files older
  than that (by modification time) from the two developer capture directories
  (`LYNOX_DEBUG_WIRE_SINK` and `LYNOX_DEBUG_WIRE_RAW_SINK`, by default
  `wire-sink` and `wire-sink-raw` in the data directory). This runs whether
  capture is switched on or not. A capture directory is cleaned only when it
  is a real directory with mode 700, and only files with the capture's own
  file name pattern are removed. A backup that already holds a snapshot keeps
  it until the backup is deleted. The settings text says so. (#1649)

### Changed: disconnecting Google deletes lynox's Drive backups

- `POST /api/google/revoke` deletes the backup files lynox uploaded to Google
  Drive before it revokes, when the request is sent as `application/json` with
  `{"delete_drive_backups": true}`. Without that body it only revokes, as
  before. Only files that the connected Google client created and the user
  owns, in dated backup folders under `lynox-backups`, are deleted; backups
  uploaded through another Google client stay, and folders are kept, so copies
  the user placed there stay. The answer has a new `drive_backups` field with
  the status, the number of files deleted, the number of folders kept and the
  reasons anything may remain. The disconnect goes ahead either way, and a
  backup made while it runs is kept locally but not uploaded to Drive. (#1637)
- The Disconnect button in Settings now asks first, names the Drive step when
  the connection can reach Drive, and sends that body; afterwards a notice
  says how many backup files were deleted, or that some may be left. (#1637)
- Drive backups are written only into a `lynox-backups` folder that the user
  owns and that this app created, and only that folder is listed for restore.
  When there is none, a new one is created. Backups in another
  `lynox-backups` folder no longer appear in the restore list. (#1670)
- The agent's Google Drive upload can no longer create folders. (#1637)
- A Google connection brokered by the hosting control plane is revoked at
  Google through the control plane on disconnect. Without a confirmation from
  the control plane the engine revokes directly, as before. (#1668)

### Changed: mail

- The API hosts of SendGrid, Mailgun, Postmark, Resend and Brevo are treated
  like a mail provider's API: no capability contract grants a request to them,
  and a bulk run refuses to write to them. (#1587)
- `mail_read` and `mail_triage` keep every header value the sender wrote on
  one line. In `mail_read`, the Message-ID and attachment names and types are
  listed in the header block, the body is in a block of its own, blocks are
  labelled by account and message number instead of the sender's address, and
  a subject made only of line breaks shows as "(no subject)". (#1608, #1620)
- The mail tools accept a mail address as the account; when an address
  matches more than one account, the error lists them. Send, mass-send and
  reply confirmations show the address a mail goes out from first, then the
  account id when it differs; for Gmail, that is the connected Google
  account's address. When it cannot be read, nothing is sent. (#1659, #1664)
- Scheduled mail refuses a receive-only account when it is sent, as an
  immediate send does, and a send from an account with no stored configuration
  is refused. (#1654, #1655)
- Reply-all leaves out the address the reply is sent from, and adds an
  explicit cc recipient who was already on the message only once.
  (#1667, #1671)
- A long encoded Subject is folded onto lines of at most 76 characters when
  sent through the Gmail API. (#1673)

### Changed: web requests that write, API profiles and the workflow grant

- An approval of an `http_request` write now covers one method and one host,
  and lapses when outside content other than that host's own answer enters
  the conversation. Before, it covered a host for the whole session. A `DELETE`,
  and a write to a path the engine knows sends or issues something, is asked
  each time, and no
  capability contract grants the latter. Method overrides in headers or a
  `_method` query parameter count as the method; a write may not set a header
  that re-targets it; a write's redirect is followed only where the approval
  covers it. The question names the path, the query keys and the body fields,
  and on the instance shows the body's values, masked, up to 64 KiB; a body
  that holds a stored secret in an escaped or encoded form is not shown.
  Notifications carry only the field names. Several questions are asked one
  after another. (#1639, #1648, #1651)
- A changed `network_policy`, `network_allowed_hosts` or `enforce_https`
  applies to the tools without a restart. (#1590)
- An OAuth2 profile can name the header its access token is sent in with
  `auth.header_name`; the token is then sent as it is, without `Bearer`.
  Unset, or set to `Authorization`, it stays `Authorization: Bearer`. A
  profile that already names another header now sends its token there, and
  one whose `auth.header_name` is not a valid header name sends no token until
  it is corrected. (#1618)
- An OAuth2 profile whose id would store its tokens under the name of one of
  the instance's own credentials is refused when saved and is not loaded at
  start-up. The start-up message says that the profile and its vault entries
  are kept and how to delete it. `fetch_token` refuses such names before doing
  anything. The count of profiles loaded from connections counts only the
  ones registered. (#1603, #1610, #1613, #1614)
- A profile that uses a built-in sign-in preset saves without `vault_keys`,
  endpoints, guidelines or avoid rules and cannot be switched off that
  preset; `api_setup` `view`
  shows the scopes it may ask for. A missing `schema_version` is read as 2,
  and a scope that is not text is refused. `api_setup` describes the presets,
  and the catalogue lists the authorization-code flow as supported through a
  preset. (#1630, #1643, #1645, #1646, #1647)
- `api_setup` `delete` asks before it deletes a profile and names the tokens
  the vault loses; with no one to ask, nothing is deleted, and in autonomous
  mode it is blocked. (#1650)
- `fetch_token` no longer quotes the token endpoint's answer: a failed
  exchange is described by its field names and OAuth error code. (#1640,
  #1663)
- `api_setup` `bootstrap` reports a failed fetch or extraction by its kind,
  field and rule, without repeating text from the remote page or server.
  (#1586, #1600)
- Wrapped external content can no longer open a data block of its own, and
  the injection check on tool results exempts only the block closers the same
  tool call produced. (#1626, #1634)
- The injection check also recognises role lines that start after a vertical
  tab, form feed or Unicode line break. (#1662)
- A numeric workflow parameter too large to represent is refused. (#1594)
- The workflow write grant still ships switched off. Where it is switched on,
  a request under a grant may set only `content-type`, `accept`,
  `accept-language`, `idempotency-key`, `if-match`, `if-none-match` and
  `*-version` headers; a parameter value that is exactly the accepted one is
  inserted into step instructions as plain text, not marked as outside data;
  a grant whose values or parameter names hold invisible characters is
  refused, and a scheduled run whose stored grant holds one runs without it,
  with a note. A grant name keeps only visible characters, at most 120 of
  them; a name without a letter or digit is left out. (#1594, #1619, #1622)

### Changed: what an unattended bash call may do without asking

- In autonomous mode, a bash call is now asked about, not run, when it passes
  code inline to an interpreter (`node -e`, `python -c`, `sh -c`, input piped
  to an interpreter and similar), sends data over HTTP (`curl` with `-d`,
  `-F`, `--json` or `-X POST|PUT|PATCH`, `wget` with `--post-…`, `--body-…`
  or `--method`), or writes into the lynox data directory outside
  `workspace/`. (#1585)
- A `curl` call that sets any method but `GET`, `HEAD` or `OPTIONS` is now
  asked about however the method is written (`--request DELETE`,
  `--request=DELETE`, `-sX DELETE`, and methods such as `PURGE`), in a chat
  and in autonomous mode. So is a `curl` config file (`-K`, `--config`). The
  new check reads `-X` case-sensitively, as curl does, so the proxy option
  `-x` is not taken for a method. `-X DELETE`, also written `-XDELETE`, stays
  blocked in autonomous mode. (#1683)
- The secret-file paths are also recognised when written with empty or `.`
  segments, such as `.lynox//vault.db`. (#1601)
- Each unattended bash call is now recorded in the local security log with
  whether a fixed grammar of read-only commands covers it. The record holds
  the program name when it is on that grammar's list (otherwise `other`), a
  reason word and what the guard decided; no arguments or paths. It does not
  change any decision. It is not part of the aggregate the instance reports.
  (#1607)

### Added: scheduled and background work

- A new setting, `background_model`, chooses the model for background runs
  and watch analyses through `PUT /api/config` (`null` clears it). It is held
  to the model blocklist and the `max_tier` ceiling and answers 400 when it
  cannot run; on a managed plan with the operator's key it cannot be changed
  (403). Without it, background runs use the model they used before.
  (#1629, #1632)
- A scheduled agent task can have its own model tier (`fast`, `balanced`,
  `deep`) through `PATCH /api/tasks/:id` with `modelTier`; `null` clears it.
  Only agent tasks and watches take one; on a managed plan with the operator's
  key it cannot be set (403). (#1633)
- Lowering the model tier ceiling now applies to open conversations from
  their next turn, and raising it gives the tier back. (#1593)
- `POST /api/tasks/:id/stop` asks a running scheduled or background task to
  stop. It answers 202 and says what the stop reached. A bulk write or undo
  stops before its next target, an atomic one is rolled back, and a workflow
  ends its running step and starts no further one. It answers 409 when the
  task is not running, when a short id matches more than one task, or when
  nothing in the task's current phase can be interrupted: always for a backup
  or a notification, and for an agent task or watch until its model run has
  started. Pause the schedule with `PATCH {enabled:false}` instead. (#1500,
  #1669)
- A stopped run is recorded as `stopped`, not as a failure: it is not retried
  or escalated, a recurring schedule keeps its status, and a one-time task is
  closed. The assistant's task list says the owner stopped it. (#1500, #1669)
- When a scheduled agent task that still needs confirmation comes due, the
  owner gets one notification saying where to review it. More than three at
  once are summarised. A task stored with an empty confirmation is treated as
  unconfirmed. (#1652, #1656)
- Each trigger records whether its last escalation reached anyone. (#1666)

### Changed: a run that needs an answer and has no one to ask stops

- When a run asks a question and has no way to reach a person, it now ends
  instead of carrying on without the answer. The conversation shows a note
  saying so. Before, the question tool returned a sentence the model worked
  around, and a missing prompt store answered "no" for the user. (#1604)
- The Google Calendar, Drive and Sheets tools and `mail_reply` pass such a
  stop on instead of returning it as text. Sub-agents pass it up.
- A question asked by a run started by hand keeps that origin across a
  restart. (#1644)

### Changed: Claude Sonnet 5 price

- Claude Sonnet 5 is priced at $2 per million input tokens and $10 per
  million output tokens, $4 for a one-hour cache write and $0.20 for a cache
  read. The cost figures and the web UI's estimates used $3 and $15 before.
  (#1676)

### Changed: web UI

- The workflow library shows its card actions on touch screens and narrow
  windows, with buttons large enough to tap. (#1595, #1597)
- The chat keeps streaming through an engine error the engine recovers from.
  (#1611)
- The Triggers view shows a stopped run muted, and the outcome of each
  trigger's last escalation. (#1500, #1666)
- Disconnecting Google asks first; see above. (#1637)

### Fixed: other

- A refused sub-agent fan-out no longer counts against the session budget.
  When the refusal suggests a budget figure, the figure is one the engine
  would admit for the whole batch. A sub-agent's name may contain only
  visible characters and spaces. (#1598, #1602, #1612)
- A question past its expiry now expires on time. Before, it stayed open and
  answerable until the UTC date changed, up to a day past its 24-hour limit.
  (#1684)
- `artifact_save` refuses content that holds the placeholder the engine puts
  in place of a saved artifact's body. Nothing is saved, and an existing
  artifact keeps its content. Before, a model could copy the placeholder into
  a new save, and the file then held only the placeholder. The web UI shows no
  artifact card for a refused save. `write_file` and `edit_file` refuse the
  same placeholder when they write it into the artifacts directory. (#1677,
  #1682)
- Switching a chat to private mode now also deletes the durable knowledge
  entries captured in that chat, whatever their status, and a profile line
  seeded from them. Before, only the chat's memories were removed, and a
  failed removal still answered as done. Now `PATCH /api/threads/:id` answers
  500 with `skip_extraction: true` when a removal fails; private mode stays
  on, switching it on again retries, and the web UI says so instead of
  showing private mode as off. (#1672)
- In a private chat, `remember`, `memory_block_edit`, `memory_store` and
  `memory_update` refuse to store anything, also when a sub-agent started
  with `spawn_agent` from that chat calls them. Such a sub-agent no longer
  captures memory when the chat it came from does not, whether because of
  private mode or `memory_extraction: false`. (#1672)
- Entity extraction no longer sets a temperature, so it no longer fails when
  the fast slot holds a model that accepts only its default sampling, such as
  Claude Sonnet 5. (#1679)
- A named-agent workflow step and the steps of a nested pipeline now run with
  the engine's tool context: their guard decisions reach the audit trail,
  their helper model calls are metered, and the API profiles are used for the
  check on where a secret may be sent. The inline steps of a nested pipeline
  also run under the engine's network egress policy. (#1680)
- When a schedule is deleted while one of its runs is in flight, the run now
  ends normally instead of failing to record its result and logging a lost
  lease on every heartbeat. A failed run that will not be retried now goes to
  the notification channels in cases that were reported nowhere before: its
  schedule was deleted, it ran on a cron or watch schedule with retries set,
  or its one-time task was completed, disabled, parked or marked failed during
  the run. (#1685)
- The security log now starts at boot even when run history fails to start,
  and says so on stderr when it cannot start itself. It is closed when the
  engine shuts down. (#1675)
- Error reports mask the values of query parameters named like credentials,
  whatever their length, and the text of user feedback. (#1591)

### Changed — BREAKING (library consumers)

- `IAgent` has a new required read-only member, `principal`, the identity
  that started the turn. An `IAgent` implemented outside this package needs it
  to compile. `AgentConfig` gains an optional `principal`, `Agent` exposes
  `principal`, and `IAgent` gains the optional `noteForeignContent`,
  `approvalEpoch` and `approvalBatch`. (#1624, #1639)
- `ToolContext` has three new required members, `auditLog`, `mandateEnds` and
  `secretReleases` (each may be `null`); `createToolContext` sets all three to
  `null`. A `ToolContext` built by hand needs them. (#1641, #1663, #1674)
- `SessionCounters` no longer has `approvedOutboundDomains` or
  `pendingOutboundPrompts`; it gains the optional `untrustedEpoch` and
  `approvedWrites`. (#1639)
- `NotificationChannel.send` now resolves to `'delivered' | 'skipped' |
  'failed'` instead of a boolean. A channel that still returns `true` is read
  as `skipped` and `false` as `failed`. `NotificationRouter.notify` resolves to
  what each channel did instead of `void`. (#1666)
- `RunHistory.vacuum()` is renamed `scrubFreedPages()`. It now runs `VACUUM`,
  a full rewrite of the file, and throws when another connection blocks the
  WAL checkpoint; `resetDatabase()` does the same.
  `RunHistory.clearLegacyVerbDefs()` is removed. For an erasure use
  `RunHistory.deleteAllData()`, which empties every table but the migration
  ledger and one backfill marker; there is no replacement for the narrower
  delete. (#1606, #1621)
- `WorkerLoop.runTriggerNow()` can return the reason `awaits_owner_stamp`,
  which an exhaustive `switch` over its result must handle. (#1605)
- Additive: `WorkerLoop.stopTask()`; `TriggerRecord` gains optional
  `created_by`, `edited_by`, `confirmed_by`, `model_tier`,
  `last_escalation_at` and `last_escalation_outcome`; `TaskRecord` and
  `ApiProfile` gain optional `created_by`; `TaskManager.recordTaskRun` accepts
  `'stopped'` and now returns whether it scheduled a retry (was `void`);
  `TaskUpdateParams.modelTier`; the object `Engine.getSecurityAudit()` returns
  gains `close()`;
  `LynoxUserConfig.background_model`; `runManifest` options accept optional
  `principal`, `isAcceptedParam` and `stopSignal`; `spawnPipeline` accepts an
  optional last argument, the parent `ToolContext`; `Engine` gains
  `getAuditLog()`, `getMandateEnds()` and `getSecretReleases()`;
  `RunHistory.pruneExpiredWireSnapshots()`; and further optional members and
  methods. (#1500, #1605, #1621, #1622, #1623, #1624, #1628, #1629, #1633,
  #1638, #1641, #1648, #1649, #1652, #1653, #1666, #1669, #1672, #1674,
  #1675, #1680, #1685)

### Internal

- The gate-record CI check fails with its own message when it cannot compute
  the diff of a merged pull request. (#1584)
- A system prompt example uses a neutral admin path. (#1636)
- Tests and the exfiltration evaluation harness. (#1588, #1617, #1625,
  #1660, #1661)
- The model-fitness rosters and judge no longer call Fireworks models the
  provider has withdrawn or a Mistral id that now answers with a different
  model, and an online test checks that their Fireworks and Mistral models are
  still served under their own names. (#1678)

### Upgrade and rollback

On first start `engine.db` moves from schema **19** to **27** and `history.db`
from **56** to **58**. Every step is additive: `engine.db` gains columns on
`triggers` (who created, changed and confirmed a schedule, its model tier, its
confirmation reminder, its last escalation) and on `tasks` (`created_by`), and
the tables `audit_log`, `mandate_ends`, `secret_release_requests` and
`secret_releases`; `history.db` gains `created_by` on `threads`,
`pending_prompts`, `active_runs` and `tasks`, and `pending_prompts.hand_run`.
Every schedule already confirmed is marked as confirmed by the owner. There is
no down path. `agent-memory.db` and the mail state do not change. 2.15.3 opens
both databases at the new versions and ignores the new columns and tables;
this was walked on a staging instance.

On first start, and then hourly, debug captures older than seven days are
deleted: `wire_snapshots` rows in `history.db` and capture files in the
capture directories (see above). There is no switch; copy them away before
upgrading if you need them. Also from the first start: each scheduled agent
task that still awaits confirmation and is already due is reported to the
owner once (more than three at once arrive as one summary); an OAuth2
profile whose id would store its tokens under one of
the instance's own credential names is not loaded (it stays on disk); an
OAuth2 profile that names a header other than `Authorization` in
`auth.header_name` sends its token there; stored contracts and bulk runs that
write to the sending services named above are refused; and unattended bash
calls of the kinds listed above stop to ask.

Rolling back to 2.15.3:

1. Clear `background_model` first, with `PUT /api/config` and
   `{"background_model": null}`. 2.15.3 ignores the whole `config.json` when
   it holds a key 2.15.3 does not know, and its next settings save writes a
   config that keeps none of the earlier settings.
2. A schedule that a person the owner let in created or changed is held until
   the owner confirms it. 2.15.3 holds only an unconfirmed agent schedule;
   every other kind, such as a notification, or a workflow schedule whose
   workflow is confirmed, runs. Confirm or delete such schedules
   before rolling back. 2.15.3 also does not know the owner's releases of
   stored secrets to such a person's API profiles, nor that such access ended:
   every profile again reads the stored secrets it names under 2.15.3's rules,
   whoever set it up and whether or not the owner released them, and a
   connection such a person made works again. Review or delete those
   profiles before
   rolling back. None of this applies where nobody was ever let in.
3. `DELETE /api/data` returns to the earlier, partial erasure.
4. A trigger's `model_tier` is ignored and the trigger runs on the default
   background model. An OAuth2 profile that sends its token under its own
   header sends it as `Authorization: Bearer` again, and an OAuth2 profile
   refused for its token names is loaded again; delete it first if you do not
   want it back. A scheduled agent task stored with an empty confirmation runs
   again without one. Backups 2.15.4 uploaded into a new `lynox-backups`
   folder in Drive can be missing from 2.15.3's restore list, which takes the
   first folder of that name. The unattended bash questions and the refusal of
   the sending-service hosts are gone, and a changed network policy needs a
   restart again. The assistant's task list reports a task recorded as
   stopped as a failed run. Claude Sonnet 5 is priced at $3 and $15 again.
   What 2.15.4 deleted stays deleted: debug captures, Drive backups deleted on
   disconnect, and files an erasure removed.

Library consumers need the changes listed under BREAKING above.

An export from 2.15.0 or later must not be restored onto an instance running 2.14.x or older: those versions restore only the parts they know and report success, silently dropping merge ledgers, `apis/` and `workspace/`. Upgrade the target first.

## 2.15.3 — 2026-10-08

### Added: a reviewed write grant for saved workflows, switched off

- This release contains a grant that lets a person allow a saved workflow
  specific writes in advance. It ships switched off: the grant preview
  (`POST /api/workflows/:id/grant-preview`) and accepting a grant through
  `POST /api/tasks` answer 403, and scheduling a workflow without a grant
  works as before. `GET /api/workflows` reports whether the grant is available
  on the instance (`grantEnabled`). (#1573)

### Changed: what an unattended run reports about writes

- An `http_request` write refused in a scheduled or background run now names
  the method and the address (scheme, host and path, never the query) in its
  refusal. A scheduled workflow run's record and notification, and the
  response of `POST /api/workflows/:id/run` (`writeNotes`), list those lines,
  from top-level steps and up to ten; that response's `grantNote` says when a
  run went ahead without its grant. Before, such a refusal was
  visible only in a tool result. A refused write still leaves its step
  completed and the run recorded as a success. (#1573)
- No capability contract grants a request to a known mail provider's API,
  whoever wrote the contract.
- When a granted write is answered with a redirect the grant does not cover,
  the redirect is still not followed. The tool now says the write may have
  landed and should not be repeated, instead of reporting it as blocked.
- The scheduling dialog lists a stored contract as one line per method and
  address.

### Changed — BREAKING (library consumers): `IAgent` gains `governingContract()`

- `IAgent.capabilityContract` is removed, and `Agent.capabilityContract` is now
  private. `IAgent` has a new required method, `governingContract()`, which
  returns the contract that applies to the current tool call, or none and why.
  An `IAgent` implemented outside this package needs it to compile. (#1573)
- New exports: the types `GoverningContract` and `ReviewedGrantStamp` and the
  functions `withAfterUntrusted` and `liftsAfterUntrusted`. `PlannedPipeline`
  gains an optional `reviewedGrant`, and `FeatureFlag` gains
  `'workflow-reviewed-grant'`. The options of `runManifest` gain an optional
  `runId` (a UUID; anything else throws, and with `runHistory` passed so does
  one already in use) and `observeToolCall`.
  (#1573, #1581)
- Contracts given to `runManifest` or an `Agent` no longer lift a refusal after
  the run has read external content, unless the contract is marked with
  `withAfterUntrusted(contract, true)`. A `reviewed` contract grants only https
  URLs without port, credentials, query or fragment, and no request that
  re-targets itself through its headers. A refused call in a non-interactive
  run is now also streamed as a `tool_result` event. (#1573)

### Fixed: a workflow Run is not started twice for one click

- `POST /api/workflows/:id/run` accepts an optional `idempotencyKey`, a
  string that is not blank and at most 200 characters; anything else answers
  400. A
  repeat with the same key does not start a second run: while the first is
  starting or running it answers 409, naming that run where it is known, and
  once it has completed it answers with that run's outcome. A run that failed
  or was interrupted is started again on a new run id, and the answer names the
  earlier run and what it cost. A repeat whose earlier run may have spent money
  but left no record answers 409 instead of running again. (#1581)
- The workflow library sends one key per attempt, kept across a reload and a
  second tab, so a double click or a second tab starts one run. A 409 for a run
  that is still starting or running is shown as a notice. When an earlier
  run's outcome was never recorded, the library says so and asks whether to
  release the attempt for a new run.
- Requests without a key behave as before.

### Fixed: stored API profile text is kept apart from the engine's own text

- The API summary at the start of a conversation now keeps what the profiles
  store and what the engine says apart: profile names, descriptions and
  addresses sit in one block, one entry per profile starting with its id, and
  the engine's guidance about maintaining profiles in a separate block. A
  stored value can no longer start a line of its own, carry invisible
  formatting characters or open or close a block. (#1579)
- `api_setup` `view` and `list` put every stored profile value inside one
  marked block, with a note on what that text is and that it grants nothing.
  Only the heading with the profile's id and the engine's description of how
  the credential is attached stay outside. Profiles created from a docs page
  keep their free-text fields marked as untrusted data, as before. (#1578)
- `api_setup` `refine` on a stored profile that is invalid on its own refuses
  without repeating the stored values, and points to `update` with a complete
  profile. A patch that repairs the invalid field still saves; an invalid
  patch on a valid profile gets the specific error as before. (#1576)
- `api_setup` `bootstrap` returns everything it derived from an OpenAPI spec
  or a docs page — summary, name, address, auth type, linked sections, other
  API hosts the page mentions, the draft JSON — inside one marked block whose
  preamble says it is data for the profile and holds no instruction to
  follow. The engine's own head line and next steps stand outside the block.
  Before, those values were printed as plain lines among the engine's
  instructions. (#1582)
- In any structured extraction, a value refused for not matching an allowed
  set or pattern is quoted, escaped and cut at 40 characters in the error.
  Before, the whole value went into the message. (#1582)
- `auth.header_name` and `auth.query_param` are checked when a profile is
  created, updated or refined, whatever its auth type, and the error does not
  repeat the value: a header name must be a valid HTTP header name, a query
  name letters, digits and `. _ -`, each at most 64 characters. A stored
  header name that is empty or not a header name is refused when the
  credential is attached, with a message naming the profile. (#1583)
- `api_setup` `view` for `auth.type: "query"` now says the engine does not
  attach the key, and how to put it in the URL
  (`?<name>=secret:<VAULT_KEY>`). An auth type it does not recognise gets its
  own sentence instead of being described as query auth. (#1583)
- `api_setup` `connect` and `fetch_token` print the auth type and vault slot
  names from a profile only when they have the expected shape, and show a
  placeholder such as `<unprintable>` otherwise. (#1569)
- `fetch_token` resolves a vault slot only when the whole configured name is a
  slot name. Before, a name that merely began with one resolved to that slot's
  value with the rest of the name appended, and that combined text was sent to
  the token endpoint as the client id, client secret or refresh token.

### Fixed: bash commands with options before the subcommand

- The bash guard now also recognises a command when global options stand
  between the command and its subcommand, for example `git -C repo push`,
  `git -c user.name=x commit`, `kubectl -n prod delete …`,
  `helm -n ns upgrade …` or `python3 -X dev -m http.server`. Such a command is
  now treated exactly like the plain form: blocked in autonomous mode, and
  asked about in an interactive session where the plain form is (`kubectl`
  and `helm` already were). This works without a list of tools, so it covers
  other command-line tools with global options too. (#1571)
- The read-only git commands `git merge-base`, `git merge-tree` and
  `git commit-graph` are no longer asked about, or blocked in autonomous mode,
  as if they were `git merge` or `git commit`.
- A flag that takes no value can make the next word look like its value, so an
  occasional read-only command may now be asked about, or blocked in
  autonomous mode.

### Fixed: a refused sub-agent fan-out says what actually stands in the way

- When sub-agents cannot be started because of the money available, the
  refusal now names the cause: the run's remaining budget, the sub-agent's own
  budget, the other sub-agents in the same batch, or a sub-agent given no
  budget, and which kinds of change can help in that case. Before, one
  sentence covered all of them and was wrong for most. (#1568)
- The hint after a sub-agent stops at its budget prints figures rounded so
  that the suggested minimum is enough.

### Fixed: request-body repair note

- The note `http_request` adds after removing a stray closing tag from a JSON
  request body appears only when a body is actually sent, so no longer for GET
  or HEAD. It now also appears when the request times out, and it says what
  the engine did to the body rather than claiming the request reached the
  server. (#1577)

### Changed: mail confirmation wording

- The mail documentation now describes what happens before an email is sent:
  lynox shows the recipients, the subject and the message (very long text
  shortened, with a note) and waits for your answer. A scheduled task asks the
  same way and waits up to a day; a saved workflow has no one to ask, so the
  mail tools refuse to send. The onboarding note now says that email from your
  mailbox goes out only after you approve it. No behaviour change. (#1574)

### Internal

- A pre-commit hook warns about added lines that describe work as put off; it
  does not refuse a commit for what it finds. (#1567)
- Source comments describe what the code does. (#1575)
- vitest is capped at two worker forks in the repo configuration. (#1572)
- The node test project refuses to load Svelte modules, and vitest started
  from `packages/web-ui` runs with the repo configuration. (#1564, #1580)

### Upgrade and rollback

`engine.db` and the mail state (17) do not change. With #1581, `history.db`
moves from schema **54** to **56** on first start: a new table,
`workflow_run_claims`, and a unique index on its run id. There is no down path.

Rolling back to 2.15.2: 2.15.2 opens a `history.db` at schema 56 without
complaint and does not use the new table; it ignores `idempotencyKey`, so a
repeated Run request starts a second run again. The workflow write grant ships
switched off; where it was never switched on, rolling back needs no step for
it. Where it was switched on and a grant accepted, delete that workflow before
rolling back (Delete in the workflow library, or `DELETE /api/workflows/:id`):
2.15.2 applies a stored contract without the checks this release adds.

Library consumers implementing `IAgent` need `governingContract()` (see above).

## 2.15.2 — 2026-10-07

### Changed — BREAKING (library consumers): `IAgent` gains three budget methods

- `IAgent` has three new required methods, used by the fan-out budget fitting
  below: `getRemainingRunBudgetUSD()`, `reserveExternalCost(usd)` and
  `releaseExternalCost(usd)`. An `IAgent` implemented outside this package needs
  them to compile. `CostGuard` gains the matching `remainingBudgetUSD()`,
  `reserveExternalCost(usd)` and `releaseExternalCost(usd)`. (#1545)
- Additive: `IAgent.runSignal` and `PromptMeta.signal` (both optional) carry the
  asking run's abort signal to prompt implementations, and `Agent.send` accepts
  a `disposableDeadline` option. (#1548) `ownEntry` and `profileNamed` are new
  exports. (#1554) `Engine.resolveWorkerRunModel()` is new. (#1551)

### Fixed: a sub-agent fan-out's budgets are fitted to what the run that started it has left

- Before a fan-out started, only an estimate of its cost was checked, and only
  against the session ceiling. The sub-agents' own budgets — `max_budget_usd`,
  $5 by default — were not compared with what the delegating run still had under
  its own cost ceiling. A fan-out could therefore start sub-agents whose budgets
  together exceeded that remainder. On a run with a cost ceiling, the budgets of
  a fan-out are now checked before any sub-agent starts: when they add up to
  more than the run has left, each is scaled down in proportion so that together
  they fit, and each sub-agent is held to its scaled budget. The spawn result
  then carries a note that names, per sub-agent, the budget asked for and the
  budget given, and says that a sub-agent which stopped at its budget did not
  fail. A run without a cost ceiling is unaffected. (#1545)
- On a run with a cost ceiling, a fan-out in which a sub-agent's share would be
  less than an estimate of one first turn on that sub-agent's model is refused,
  with a message naming the sub-agent, its share and that estimate. The estimate
  is priced on the model resolved for that sub-agent (#1558) and on the output
  limit resolved for its call — its own `max_tokens`, else its profile's, else
  the model's default — so a lower output limit also lowers it (#1562). A share
  of zero is always refused. Amounts under one cent in these messages are shown
  to four decimal places.
- The shares are held against the run's ceiling as soon as a fan-out is
  admitted, so two fan-outs started in the same turn cannot both be given the
  same remainder: the second is refused if the first already took it. Each share
  is given back when its sub-agent finishes. (#1545)

### Fixed: the 10-minute spawn time limit stops the sub-agent

- A spawned sub-agent has a time limit of 10 minutes, but reaching it did not
  stop the sub-agent, so one that hung held its parent's run until something
  else ended it. The limit now stops the sub-agent: it stops waiting for tool
  calls still in flight, and fails with "Stopped after the 10-minute spawn time
  limit without finishing." Its run is recorded as failed with the stop reason
  `spawn_timeout`; a stop by the parent is still recorded as aborted. Its share
  of a fan-out's budget is given back. (#1548)
- Time a sub-agent spends waiting for a person — a question, a confirmation or a
  secret request — does not count against the limit. Once a sub-agent has
  finished, a question from work it left behind is not passed on to its parent.
- When a chat run over the HTTP API (the one the web UI uses) is stopped, a
  question it still has open — a question, a confirmation or a secret request —
  is now withdrawn. An answer given after the stop is not acted on, and a
  question raised by a run that was already stopped is not shown.

### Fixed: chat turns that could not start

- A chat turn whose start failed before the server answered — no connection, a
  request cut off, a session that could not be re-created — left the chat marked
  as running with an empty reply, and the turns queued behind it did not go. Now
  the message is kept and marked failed, the empty reply is removed, the chat is
  free again, and the error is shown. If the connection is up when the turn
  fails, the next queued turn goes. (#1547)
- Such a turn may still have reached the server, so tapping the failed message —
  or reconnecting — first asks the server whether a turn is still running in
  that chat. If one is, nothing is sent again: the chat says so and shows the
  running turn's answer. If the server cannot be asked, nothing is sent either.
- When the turn fails after you have moved to another chat, or while its own
  chat is being reloaded, the message is marked failed in that chat's saved copy
  instead of being lost when the server's transcript arrives, and it can be sent
  again from there. A chat deleted in the meantime is not brought back. (#1555,
  #1559)

### Fixed: OAuth renewals in `http_request`

- `http_request` renews an OAuth access token from five minutes before it
  expires onward, including after it has expired. A renewal that failed was
  attempted again on every following request. After a failed renewal, the
  profile is now held back for one minute: requests in that minute go out with
  the stored token, and the log says that the renewal was skipped and until
  when. A change to the profile's OAuth settings, a new token expiry or a newly
  stored refresh token lifts the hold at once, and a successful renewal clears
  it. The hold is kept in memory only. (#1560)
- A renewal that succeeded but left the profile still due for renewal — the
  profile could not be saved, or the provider issues tokens that live less than
  five minutes — was run again on the next request. When the new token's
  lifetime is known, the profile is now held back after such a renewal as well,
  for at most a minute and never longer than the new token can still carry a
  request. (#1563)
- When a provider refuses the requested scopes (`invalid_scope`), `api_setup`'s
  `fetch_token` called this a temporary failure and suggested retrying later. It
  now says the provider refused the scopes, names the scopes asked for, says
  nothing was changed and that retrying unchanged will not help, and points to
  the profile's scope setting — or, for a profile set up from a provider preset,
  to a new consent through `api_setup connect`. (#1556)

### Fixed: a JSON request body with a stray closing tag

- Some models append a closing tag such as `</body>` to the JSON body of an
  `http_request` call. The API then received invalid JSON, rejected the call,
  and the model could repeat the same call. When a body looks like JSON or is
  declared as `application/json`, does not parse, and parses once a single
  trailing closing tag is removed, that tag is now removed before the request is
  sent, and the result tells the model that its body was repaired. Any other
  body is sent as before. (#1565)

### Fixed: secret scanning of long text

- The patterns that find JWT-shaped tokens took time growing with the square of
  the input's length on long base64-like text without the token's dots. They now
  run in time linear in the length of the text, with the same matches. This
  covers credential masking and detection, the outbound scan of `http_request`,
  debug output, security-audit previews, the redaction applied before a
  conversation is saved as a workflow, the inbox's sensitive-content rules, and
  the web UI's masking and pasted-key guard. (#1552)
- The web UI's Telegram bot token mask bounds the length of the numeric id for
  the same reason; a token directly after `/bot` in an API URL is still masked.

### Fixed: model ids and profile names that match built-in object properties

- A model id or a model-profile name such as `toString`, `constructor` or
  `__proto__` was looked up on plain objects and found built-in properties
  instead of nothing, so it could come back as a capability, a price or a
  profile. Such a name is now treated as unknown: model capabilities and prices
  fall back to their defaults, `spawn_agent` refuses it as an unknown profile,
  and a `worker_profile` naming one is cleared at load. A `"__proto__"` entry in
  `pricing.json` or in `LYNOX_MODEL_PROFILES_JSON` is kept as an ordinary entry.
  The web UI's cost display reads its prices the same way. (#1554)

### Fixed: refusing to take back a merge in a chain

- Taking back a merge whose resulting entry was later merged again (A into B,
  then B into C) was refused with "This merge is no longer in effect — it was
  taken back already, or the entry was merged elsewhere since.", which did not
  describe that case. The refusal now names the merge to take back first — the
  latest in the chain — and says to try again afterwards; it carries the code
  `merge_chained`. When no such merge can be named, the refusal says that the
  later merge cannot be taken back here, so this one cannot either. (#1550)

### Changed: sub-processor contact

- The contact section of `SUBPROCESSORS.md` now lists only the privacy address;
  the link to an EU representative was removed. (#1553)

### Internal

- The rule that picks a session agent's model and the provider serving it now
  lives in one function, which a worker run can also call before its session
  exists; behaviour is unchanged. (#1551)
- The web UI's Svelte rune-module tests run in jsdom, compiled as the browser
  runs them; `jsdom` joins the web UI's dev dependencies. A test checks that the
  Markdown sanitizer removes the marker the renderer puts on its own controls.
  (#1546, #1561)
- The JWT linear-time test has a longer time budget, so that it also passes
  under coverage. (#1557)
- The pull-request template's `gate-record` skeleton can be filled in as
  written, and its format is held to one source by a test. (#1566)
- The chat view's floating promises are handled, so the lint rule against them
  is an error in every web UI component. (#1547)

### Upgrade and rollback

No schema changes: `engine.db` stays at **19**, `history.db` at **54** and the
mail state at **17**. Rolling back to 2.15.1 needs no step.

## 2.15.1 — 2026-10-07

### Fixed: scheduled agent tasks start again under a daily spend cap

- The background worker reserved every scheduled agent task's worst case — the
  most such a run may spend, $15 for an ordinary scheduled task — against the
  daily and monthly spend caps. Where the daily cap equalled that, the first cent of
  recorded spend made the reservation exceed the cap, and no such task started
  again until the day rolled over; where the daily cap was smaller, such a task never started at
  all. The worker now reserves the smallest of the run's worst case, the headroom
  still free under the caps, and the per-run session ceiling, and lowers the
  run's own cost cap to that same amount. With less than $0.05 of headroom the
  task waits. (#1537)
- A scheduled task held back for budget now says so in the log, with the
  reason, at most once every ten minutes while it waits, and once more when it
  is admitted again. Before, it waited without a word.
- A scheduled agent task that stops at its cost cap or its turn limit with tool
  calls still pending is recorded as failed, and its notification is marked as
  a failure. It used to be recorded as a success.

### Fixed: a model profile sets endpoint and model as one pair

- An agent whose connection comes from a model profile — a background task or a watch's analysis
  run with `worker_profile`, or a sub-agent without a profile of its own spawned
  by a profiled agent — used the profile's endpoint and key but took its model
  from the tier. The OpenAI-compatible wire sends any model id that is not a `claude-` id
  unchanged, so on an instance whose tier resolves to such a model (a Fireworks
  model, for example) the request named a model the profile's endpoint does not
  serve, and failed. Whenever a profile supplies the endpoint, the profile's model
  is now sent with it; without a profile, the tier decides as before. (#1541)
- The same holds for work that inherits a profiled agent's connection: workflow
  steps, the planner, workflow extraction on save, search reranking and
  structured-output helper calls.
- The run record and the cost of such a run name the model that actually ran,
  including a workflow step pinned to the profile's model.

### Fixed: a sub-agent's cost counts against the run that started it

- A spawned sub-agent's spend reached the daily total but not the cost cap of the
  run that delegated to it, so that run's next turn computed with more room than
  it had. The sub-agent's actual cost is now booked on the delegating run's cost
  cap, on self-hosted, BYOK and managed instances alike. (#1542)

### Changed — BREAKING (library consumers): `IAgent` gains `chargeExternalCost`

- `IAgent` has a new required method, `chargeExternalCost(usd)`, used to book a
  spawned sub-agent's cost on the run that delegated to it. An `IAgent`
  implemented outside this package needs it to compile. (#1542)

### Fixed: credential masking catches a key glued to an identifier or an escape

- Credential shapes with a known vendor prefix (Anthropic, OpenAI, Stripe,
  GitHub, AWS, Google, Slack, Shopify) only matched at a word boundary, so the
  vendor rules did not recognise a key written directly after `_` — as part of a
  variable name — or after a JSON or URL escape; where only those rules apply it
  was neither masked nor detected, and could come back whole in an API error. It is now masked and
  detected there too. A snake_case name that merely contains such a prefix, with no digit in the letters and digits right after it, is still not taken
  for a key. (#1540)
- The same rule applies to the web UI's pasted-key guard and display masking, and to the redaction applied before a conversation is turned into a saved
  workflow.

### Changed: rendering hardening for chat Markdown

- Code fences in a rendered message are found on the parsed, sanitized DOM
  rather than by a pattern over the sanitized string, and replaced as nodes.
  When highlighting fails, the fence shows the escaped code. (#1534)
- The diagram buttons and artifact cards in a message act only on controls the
  renderer built itself, not on similar-looking markup in the message
  content. (#1544)
- Saving a diagram as an artifact reports a failed save; before, it said
  nothing. (#1543)

### Fixed: a scheduled workflow inherits what its creator had taken in

- A workflow task created with `task_create` runs later from the background
  worker, with no conversation of its own, so its run started as if nothing
  untrusted had been seen — although its parameters came from the conversation
  that scheduled it. The task now records whether that conversation had taken in
  untrusted content (for example web or mail content, or an external tool's
  result) and its run
  starts from that state: each step's actions are judged with the untrusted-content state of that
  conversation. A task created from a conversation that had taken in nothing
  runs as before. (#1528)
- The record lives in the new `engine.db` column `triggers.created_untrusted`
  (schema v19). A task that is saved again never loses a recorded state, and a
  stored value this version does not recognise is read as untrusted.

### Fixed: web UI errors that went unreported

- Chat: an answer to a question prompt that cannot be delivered after one retry
  is reported. A stop whose request fails is reported and leaves the run
  stoppable again. A dismissed secret or mail-connect prompt whose dismissal does
  not arrive comes back in the same thread with an error, so it can be dismissed
  again. Copying reports a clipboard the browser refused. (#1536)
- Elsewhere: a failed read of the backup settings, of an entity's relations in
  the knowledge graph, or of an artifact is shown as an error instead of as
  empty. (#1539)

### Internal

- The Svelte components of the web UI are linted, the Markdown renderer
  included, and floating promises in the web UI outside the chat view are handled or marked; in
  the chat view, the prompt-answer, stop, dismissal and copy calls are handled.
  (#1527, #1536, #1539, #1543)
- `tests/online/` calls real provider APIs and now runs only with
  `LYNOX_ONLINE=1`; an ordinary local run leaves it out and says so. The checks
  in it that need no provider moved to `tests/online-guards.test.ts`. (#1538)
- A data-store test fixture removes the temporary directories it creates.
  (#1533)

### Upgrade and rollback

The upgrade moves `engine.db` from schema **18** to **19** on first start: one
additive column, `triggers.created_untrusted`. `history.db` (54) and the mail
state (17) do not change. There is no down path.

Rolling back to 2.15.0: 2.15.0 opens an `engine.db` at schema 19 without
complaint and leaves the column alone, but does not read it. A workflow task
created from a conversation that had taken in untrusted content therefore runs
with a clean state again after a rollback, as it did before this release.

Rolling back further, to 2.14.x: the two steps under 2.15.0's **Upgrade and
rollback** still apply — settle every parked trigger, and check scheduled mails
already claimed for sending — as does its note on the withdrawn preset models.

## 2.15.0 — 2026-10-07

### Changed: stopping one conversation no longer stops work in another

- Pressing stop, deleting a thread, or ending a session used to abort **every**
  sub-agent and every workflow step running anywhere in the process, not just
  the ones belonging to that conversation. Another window's fan-out, and a
  background task's workflow steps, died with it — and a background task whose
  run was cut that way was recorded as failed and started again by its retry
  backoff. A stop now reaches the agents of its own conversation and the
  agents those started, and nothing else.
- ⚠ One thing this takes away: a **saved workflow launched on its own** — from
  the workflow library, by a schedule, or through the API — has no conversation
  to belong to, so a stop in a chat no longer ends it. Previously it did, by the
  same over-broad reach. Such a run is still bounded by its own wall-clock,
  iteration and spend limits; it simply cannot be stopped from elsewhere. A way
  to stop it deliberately is a separate piece of work.

### Fixed: deleting an API profile removes the tokens its exchanges wrote

- Deleting a profile — with `api_setup delete` or on the settings page —
  removed the profile and left every token `fetch_token` had written for it in
  the vault. `fetch_token` now records each name it writes together with a
  fingerprint of the value, and a delete removes a name only while the vault
  still holds that very value — unless another profile still references the
  name, or the name is one a tenant cannot recover: an infrastructure secret
  or the slot holding their own provider key. Neither a name nor a record alone
  is enough: a name derived from the profile id, or one an exchange wrote
  earlier, can hold a token the user has stored there by hand. A refresh token
  the provider hands back unchanged — the very one it was sent — is neither
  rewritten nor recorded. Tokens from before this change are not on any record
  and stay.
- `api_setup delete` names what it removed and which of the names the
  profile used still hold a value — apart from a platform slot or the
  tenant's own provider key, which are not this profile's to offer — and says
  to ask the user before removing the rest.
- The `vault_keys` column of a connection also lists the token names an
  oauth2 profile uses at runtime, the names its exchanges recorded, and a
  basic profile's `username_key`/`password_key`.
- `api_setup` refuses an `auth.vault_keys` that is neither absent nor a list
  of names.

### Changed: a failed token refresh says whether the grant was revoked

- `fetch_token` reads a failed token exchange the way the Google path already
  did (the classifier now lives in `src/core/oauth-refresh-failure.ts` for
  both): `invalid_grant` from the client that minted the refresh token is a
  revocation; `invalid_client` and its siblings, or `invalid_grant` from a
  different client, are a client problem that leaves the grant alone;
  anything else changes nothing. Which client minted a token is stamped with
  the token, as fingerprints of both, so a refresh token stored later is
  judged on its own. When the refresh token in the vault has changed or gone
  by the time the rejection arrives — a concurrent exchange in the same
  process rotated it, or a token was stored or removed meanwhile — nothing is
  recorded, and the reply says what changed. A rejection that arrives before a
  concurrent exchange finishes can still record a revocation; that exchange's
  success clears it.
- A revocation is recorded on the profile (`oauth_grant`, engine-owned like
  `custom_endpoint_ack`: a value in a create or update is discarded, and the
  reply says so) and projected into `connections.status` while the profile
  exchanges a refresh token. `fetch_token` will not resend the rejected
  refresh token, and `http_request` refuses the profile with the way back,
  instead of a 401 whose hint called it an expired token. A different refresh
  token in the vault clears the way for both; the next successful exchange
  clears the record. A profile that reads its refresh token from a slot of its
  own naming gets no verdict, because `fetch_token` stores rotated tokens under
  the derived name.
- `fetch_token` runs its checks on `output_secret_name` before it posts
  anything, rather than after the exchange has already spent a refresh token,
  and one check is new: a name where the profile keeps its refresh token is
  refused, because the access token would be written over it.

### Changed: two API profiles can no longer share a host

- `http_request` picks a profile's credential by hostname alone, so two
  profiles on one host were last-write-wins: the credential of whichever loaded
  last went out, without a word. Saving a second profile on a host another
  profile holds is now refused, with the holder's name. Profiles that already
  share a host keep loading and can still be saved in place; the host is
  marked, the boot logs it, and a request there that would carry a credential
  is refused, naming both and asking for the user's choice, until one is
  removed or moved. Moving a profile to a new host releases the old one.
- Two public (`auth.type: none`) profiles on one host are not refused at
  request time; there is no credential to mix up.
- An update that removes a profile's `rate_limit` now also drops its rate
  bucket, and when one of two profiles on a host goes, the one that stays
  gets its own limit back.

### Fixed: a new instance can create its first table

- The six `data_store_*` tools were registered at boot only if the store
  already held a table, and on an instance with neither a table of its own nor
  a CRM record it never did: boot drops the CRM's own empty collections just
  before that check, and the CRM recreates them later in the same boot. So
  `data_store_create`, the tool that makes the first table, was offered only
  once a table existed. The base prompt routes quantitative data to
  `data_store_insert` all the same, so a model that followed it would get
  "Tool not found". Workflows on those instances lacked the tools too,
  although workflow steps list `data_store_query` and `data_store_insert` as
  available.
- The tools are now registered as soon as the store opens, all six together,
  and the *Data Tables* section of the system prompt comes with them. Together
  rather than create first: an agent keeps its tool list for the whole turn, so
  "make a table for these receipts and put them in" needs insert to be there
  when create runs.
- Instances with neither a table of their own nor a CRM record now carry those
  six definitions and that prompt section, roughly 2,000 tokens by a character
  estimate. Instances that already had either are unchanged.

### Deprecated: `Session.registerDataStoreTools()`

- The engine now registers the data-store tools itself during `init()`, as
  soon as the data store opens, so this method has nothing left to do. It
  stays; a call changes neither the tool list nor the registry version.

### Changed: `data_store_query` and `data_store_list` results go through the injection scan

- `data_store_query` returns stored rows, and a table can hold text that came
  from outside; `data_store_list` prints each table's scope label, which is
  free text stored with the table. Like `recall`, both now pass through the
  tool-result injection scan: a flagged result reaches the model with the
  usual warning line and is recorded as a security event. The other
  `data_store_*` tools return status text and stay exempt.
- Known false positive: a column whose name is also a word the scan looks for
  (`email`, `post` and similar) can make an ordinary row trip a pattern,
  because the JSON copy of the rows puts the column name next to the values.
  It costs a warning line and an audit event; nothing is blocked.

### Changed: the docs and the card now describe the connection you actually get

- The Google docs still described a product from before the scope re-cut: a
  setup that "applies to all deployments", an access toggle called *Read only* /
  *Full access*, and a default level said to read "Gmail, Sheets, Drive, Calendar,
  Docs". None of that is true — the default asks for calendar events, free/busy
  and the Drive files lynox creates, and nothing else. Rewritten, with the cost
  of each level named (verification vs. an annual CASA assessment) rather than
  implied.
- **The full-access description now says that it moves your inbox.** Full
  includes a Gmail read scope, and lynox then reads that mailbox over the Google
  connection instead of over IMAP. Every other item in that list is a capability;
  that one changes something already working, and the copy did not mention it.
- "Credentials saved. Restarting engine…" said something the route does not do —
  it reloads the Google credential in the running engine. A user watching for a
  restart was waiting for nothing.
- **Drive results say which Drive they came from.** Under `drive.file` Google
  returns only files lynox created, so an empty answer is honest and looks
  exactly like "you have no such file". Searches and listings now carry one
  sentence saying so, and the card carries the way out — which differs by
  connection, because a managed connection through lynox's own Google client has
  no toggle that widens it.

### Fixed: a Google connection without Gmail access no longer looks like a broken mailbox

- A Google *connection* and a Google *mailbox* are two different things, and
  until now the mail path asked the same question for both — is Google
  connected. That was invisible while the default consent set granted
  `gmail.readonly` to every connection; it stops being invisible now that the
  default set grants Calendar and Drive-file access and no Gmail at all. On such
  a connection the mail provider was built anyway and every Gmail call came back
  403, on every poll.
- The gate is now the scope, not the connection: `gmail.readonly`, `gmail.modify`
  or `mail.google.com/`. Without one, no provider is registered (one log line at
  init, not one per poll) and no placeholder mailbox row is created. **An
  existing row is kept** — it is the user's mailbox and it works again the moment
  the scope is there — **on the next start of the instance**, because nothing
  re-registers a mail provider at runtime. The card's badge clears immediately,
  since it is computed per request. The log line names no mailbox: one line per
  start, with a count.
- The mail card names the reason and the way out: a *no mailbox access* badge and
  a link to the app-password guide, in both languages. An account that is listed
  and does nothing reads as a fault in lynox rather than as a permission the
  connection never asked for.

### Added: a `connections` row that follows the Google grant

- A Google connection now registers itself in the `connections` table —
  `id: 'google'`, the granted scopes, which source supplied the client pair, and
  when consent was given. Nothing reads it yet: the row is the plug-point a
  later Google push source needs (`triggers.source_connection_id`), and this
  release writes the slot and moves nothing. The token stays in its vault slot;
  the row names it by key and holds no material.
- `GoogleAuthOptions` gains `onTokenChange`, which fires on a new grant, on a
  refresh and on a disconnect. It is a mirror, not a gate: the vault write has
  already happened when it fires, and a throw from the hook is logged and
  swallowed rather than failing an OAuth flow that succeeded.
- `granted_at` records the CONSENT and is not rewritten on a refresh — a
  timestamp that moved on every refresh would answer "when was this last used",
  which is a different question.

### Changed — BREAKING (integrators): the Google scope sets are re-cut

- **`READ_ONLY_SCOPES` and `WRITE_SCOPES` are removed** from the package's
  public exports. They were a read/write split, and Google's own split is
  non-sensitive / sensitive / restricted — the two do not line up. `drive.file`
  is a *write* scope that costs no verification at all, and it sat in neither
  list; an export named `READ_ONLY_SCOPES` returning write scopes was going to
  mislead somebody eventually.

  Replaced by `STANDARD_SCOPES`, `SENSITIVE_EXTRA_SCOPES`, `RESTRICTED_SCOPES`
  and `FULL_SCOPES` (the union). Nothing that was accepted before is rejected
  now: every one of the twelve previously-valid scopes is still in the union,
  pinned by a test, because a narrowed allowlist breaks a re-consent for anyone
  carrying one of them in `google_oauth_scopes`.

- **The default consent set changed**, and this is user-visible at the Google
  consent screen. It was the five `*.readonly` scopes (Gmail, Sheets, Drive,
  Calendar, Docs); it is now `openid`, `userinfo.email`, `calendar.events`,
  `calendar.freebusy` and `drive.file`. The point of the new set is that no
  scope in it is *restricted* by Google's classification, so it needs app
  verification but no annual CASA assessment. **Existing connections are not
  touched** — the change applies to the next consent.

- **The `full` mode requests three scopes more and one fewer.** Added:
  `openid`, `userinfo.email`, `calendar.freebusy`. Dropped: **`gmail.modify`**
  — measured, nothing writes a Gmail label, trashes a message or calls
  `messages.modify`; the provider only lists, searches, fetches and sends, and
  reads `labelIds` out of a list response, all of which `gmail.readonly`
  authorises. An existing connection keeps whatever it was granted; the change
  applies to the next consent. The bundle is deliberately NOT the union of the three
  classification sets — a request bundle has to stay minimal, because Google's
  verification requires "the least amount of access … necessary" and a scope no
  code path exercises is by definition not necessary. `mail.google.com/`,
  `gmail.compose`, `gmail.metadata`, `drive.metadata.readonly`, `calendar` and
  `calendar.calendarlist.readonly` are therefore **accepted** if a connection
  already holds them and **not requested**.

- **An existing connection will now describe itself as `legacy`**, and that is
  accurate rather than a downgrade: a grant taken before these sets existed
  satisfies neither named set, because it holds no `openid`, `userinfo.email`
  or `calendar.freebusy`. Nothing about the connection changes; the card states
  it and parks the toggle at *Standard* without calling it a mismatch. Picking
  a mode and re-consenting moves it onto the named set.

### Changed: every Google tool action is gated on the scope it actually calls with

- Read actions were gated by nothing. That was invisible while the default set
  granted every read scope, and it stops being invisible on a connection that
  grants Calendar and Drive-file access only: a `google_sheets read` there was
  authorised by nothing lynox had asked for, so it reached Google and returned
  a bare 403 body into the conversation. Each tool now declares one scope table
  over its own actions, and an action with no authorising scope refuses before
  the request, naming the missing scope and where this connection can widen it.

- Two consequences worth knowing: `google_calendar free_busy` now requires
  `calendar.freebusy`, `calendar.readonly` or `calendar` — `calendar.events`
  does **not** authorise `freebusy.query`, and a grant holding only that scope
  used to fail at Google instead. And `google_drive move`/`share` continue to
  require full `drive` rather than `drive.file`, because both take an arbitrary
  file id that `drive.file` does not reach.

### Changed — BREAKING (operators): `network_policy` now covers Google

- **A tenant on `network_policy = deny-all` loses their connected Google account,
  including Gmail over OAuth.** Until now every authenticated Google Workspace
  call — Drive, Sheets, Docs, Calendar, Gmail-over-OAuth, the token refresh, the
  revoke, and the Drive backup upload — went out through a bare `fetch()` and
  was invisible to `network_policy`. The setting's own documentation named
  Google and the backup upload as *outside* its scope, so an operator who chose
  `deny-all` had Google traffic leaving the box anyway and no way to see or stop
  it. That is now closed: those calls ride a third egress surface (`connector`)
  and obey the policy like every other one.

  **This takes something away from a setting a customer chose deliberately, and
  it is not visible in a diff** — hence a release note rather than a line in the
  changelog's usual sense. What changes, per policy:

  | `network_policy` | before | now |
  |---|---|---|
  | `allow-all` (default) | Google reachable | unchanged (public endpoints) |
  | `guarded` | Google reachable, unpoliced | Google reachable — admitted by its own fixed host set |
  | `allow-list` | Google reachable, unpoliced | reachable **only** if you list the Google API hosts |
  | `deny-all` | Google reachable, unpoliced | **blocked**, Gmail-over-OAuth included |

  **If you are on `deny-all` and use Google:** switch to `guarded`, which admits
  a connected integration to its own provider while still gating the surfaces a
  prompt-injected agent can aim.

  **On `allow-list`**, add `www.googleapis.com`, `sheets.googleapis.com`,
  `docs.googleapis.com`, `gmail.googleapis.com` and `oauth2.googleapis.com` to
  `network_allowed_hosts`.

  ⚠ **On a lynox-hosted instance, add your control plane's hostname as well.**
  `allow-list` is uniform across every egress surface by design — it consults
  only your list, never an integration's own hosts — and a hosted instance
  refreshes its Google token through the control plane, not through Google. List
  the five Google hosts and nothing else and everything keeps working until the
  access token expires, typically within the hour; after that the refresh is
  refused and Google stops working with a network-policy error. The token itself
  is not lost: a policy-blocked refresh fails before the response is read, so
  nothing is classified as revoked.

  A refresh blocked by policy fails *before* the response is read, so no token
  is classified as revoked and nothing is deleted — a policy change cannot cost
  you a grant.

### Changed — BREAKING (library consumers)
- **`createGoogleTools` no longer builds the credential, and its signature changed.**
  It was `createGoogleTools(options) → { tools, auth }`; it is now
  `createGoogleTools(resolveAuth: () => GoogleAuth | null) → { tools }`, and the
  credential half moved to the new `createGoogleAuth(options) → GoogleAuth`. Both
  are exported from the package barrel, as is the new `GOOGLE_NOT_CONNECTED`
  constant.

  The reason is not tidiness: the four Google tools are now registered from boot
  whether or not Google is connected, so a model that can see the tool can tell
  the user the feature exists and how to switch it on. A tool that must exist
  before its credential does cannot close over that credential — hence the
  resolver. Each tool answers `GOOGLE_NOT_CONNECTED` until there is something to
  resolve, and the resolver is re-read per call so a reconnect takes effect
  without a process restart.

  **Migration:** `const { tools, auth } = createGoogleTools(opts)` becomes
  `const auth = createGoogleAuth(opts); const { tools } = createGoogleTools(() => auth);`

### Changed — BREAKING (operators): a project-directory config can no longer set seven keys

- A project config (`.lynox/config.json` in the working directory) is merged over
  the user config (`~/.lynox/config.json`), limited to a list of keys considered
  safe for a directory to set. Seven keys came off
  that list because each of them decides more than a value:
  `embedding_provider`, `plugins`, `changeset_review`, `bugsink_dsn`,
  `backup_dir`, `backup_retention_days` and `backup_encrypt`. A directory could
  pick which installed plugins run, where error reports go, where backups are
  written and how long they are kept, or switch backup encryption off.
- They still work from the user config, and the environment variables that
  already existed (`LYNOX_EMBEDDING_PROVIDER`, `LYNOX_BUGSINK_DSN`) still take
  precedence. A project file that sets one of them is now ignored for that key.
- `embedding_provider` is the one with a lasting effect: memories are stored with
  the vectors of the provider that wrote them and there is no re-embed path, so a
  per-directory switch could leave two providers' vectors mixed in one store.
- The docs now describe `changeset_review` as what it is: a backup before each
  write plus a diff after the run, not a staging area.

### Changed — BREAKING (operators): IMAP requires STARTTLS when implicit TLS is off

- An IMAP account with `secure: false` now upgrades the connection with STARTTLS
  and refuses a server that does not offer it — the same rule SMTP already
  followed. Before, the connection could continue without TLS when the server
  offered no STARTTLS. Accounts with implicit TLS (all presets, port 993) are
  unchanged.
- The account settings report a server without STARTTLS as its own error rather
  than a generic connection failure. Switch the account to implicit TLS (usually
  port 993) where the server supports it.

### Changed — BREAKING (operators): Google Drive backup upload is opt-in and needs an encrypted archive

- `backup_gdrive` was documented with a default of `false`, but nothing read it:
  any instance with a Google connection that had Drive access uploaded its
  backups to Drive. The setting is now read, from the user config only, and is
  checked at each upload, so turning it off through the config API
  (`PUT /api/config`) takes effect without a restart; a hand-edited config file
  takes effect at the next restart.
- An archive is uploaded only if it is actually encrypted. Opting in without a
  vault key logs that the upload was skipped instead of uploading plaintext; a
  failed upload is reported.
- On a lynox-hosted instance the Drive upload is skipped: the hosting side keeps
  its own backups.
- **If you relied on the Drive upload, set `backup_gdrive: true` in your user
  config** and make sure a vault key is set.
- Corrected in the docs: `backup_encrypt` defaults to "on when a vault key is
  set", not `true`; file contents are encrypted, but the list of files in the
  manifest is not.
- `verifyBackup` no longer reports an encrypted backup as invalid.
- The backup settings page no longer shows a *Backup schedule* control: it wrote a key nothing read. `backup_schedule` stays valid in config
  files.

### Changed — BREAKING (library consumers): the stream `error` event says whether the turn is over

- `StreamEvent` of type `error` carries `fatal`: `true` when the run has ended
  (for example at the iteration cap), `false` when the turn continues (for
  example after a tool input that could not be parsed). The web UI used this to
  stop showing a live, still-billing turn as "not sent, tap to retry".
- The published type keeps `fatal` optional, so handlers keep compiling, but
  everything core emits is typed with it required. Reading `agent.onStream` back
  as a plain `StreamHandler`, or forwarding a stored `StreamEvent` through it, no
  longer typechecks.

### Changed: a secret is sent only where it belongs

- A `secret:NAME` reference in a tool call is filled in by the engine before the
  tool runs. It now also needs a destination it belongs to. For `http_request`,
  a secret goes without asking only to a host that a person accepted for the API
  profile that names it. **Any other host is confirmed per destination**: a
  dialog names the secret and the host, and an approval holds for that secret
  and host for the rest of the session.
- Other tools cannot say from their input where a value goes, so each call that
  carries a secret is shown to the user with the tool and the input, and asked
  about — also in background sessions that have someone to ask. An input too long
  to show is refused.
- **With no one to ask, a secret goes only where it is bound.** `http_request` to
  a host the secret is not bound to is refused, and other tools carrying a secret
  run only if the conversation had taken in no untrusted content before that
  batch of calls. For `http_request` the refusal names the way out: connect the
  service with `api_setup` and accept it, add the secret to the accepted profile
  for that host, or make the call from an interactive session.
- A reference in the userinfo or host part of a URL is refused, and on a
  redirect to another origin any header whose value carries a secret is dropped,
  whatever it is called.

### Changed: outbound requests with a body carry `Content-Length`

- Requests sent through the engine's pinned network path (used by `http_request`
  and the calls to the hosting control plane) went out with `Transfer-Encoding:
  chunked` when they had a body, because no length was set. Some receivers refuse that with `411
  Length Required` — among them the hosting control plane, which broke claiming
  and refreshing a brokered Google connection.
- Every such request with a body now carries `Content-Length` and no chunked
  framing.
  **This applies to `http_request` POST/PUT/PATCH to third-party APIs too**: an
  API that accepted chunked bodies sees a length instead, and one that refused
  them now works. A `Content-Length` or `Transfer-Encoding` header passed to
  `http_request` is replaced by the real framing; on a request without a body,
  framing headers passed by the caller are dropped and the request is framed as
  usual (`Content-Length: 0` for a POST without a body).

### Changed: switching a tool off reaches open threads from their next turn

- A change to the tools an agent may use (Tool Toggles), its prompt, its context
  window or its memory settings used to reach new conversations only; an open
  thread kept the agent it was built with. An open thread now picks the change up
  on its next turn. A turn already running keeps the tools it started with.
- The rebuild keeps the conversation, its autonomy level, iteration cap and
  profile, and whether it has taken in untrusted content.

### Fixed: reversing a subject merge keeps what happened since

This concerns the subject graph (`subject_graph_enabled`): on for new hosted
instances, off by default on self-hosted ones.

- When A was merged into B and then B into C, the older merge could still be
  reversed: it reported success and left the data split between entries. Reversing
  an older merge in such a chain is now refused until the newer merge is reversed;
  after that, the older one reverses cleanly.
- **Edits made after a merge survive its reversal.** Aliases learned since the
  merge stay, and only the ones the merge added are removed; a detail field edited
  since the merge keeps its edit, with an amount and its currency judged together.
- A reversal is refused when the merge is not in effect on this instance (already
  reversed, replayed, or its rows are gone) instead of reporting an undo that
  restored nothing. `subject-sweep --rollback` exits non-zero when it fails.
- An owner can list merges with `GET /api/merges` (applied, in effect, superseded)
  and reverse one with `POST /api/merges/:id/rollback`, which answers with fixed
  reasons when it refuses.
- The merge ledger files are now included in backups and in an instance
  migration, so a restore no longer makes past merges irreversible. Because they
  hold contact data, ledgers older than 90 days are deleted at start and on each
  merge; the newest is always kept.
- `subjects_merge` no longer describes a merge as reversible from chat: its
  confirmation says that undoing it is a step outside the chat.
- Erasing memory (an erase request, a private-thread purge) now also removes the
  subjects that memory created when nothing else refers to them, instead of
  leaving their names behind.

### Added: run history records which connection each `http_request` went through

- Each `http_request` call in the run history now carries the API profile its
  host resolved to and that profile's creation time (`run_tool_calls.connection_id`
  and `connection_created_at`, history schema v54). The value is written by the
  engine, never from tool input, and outlives the profile.
- `NULL` means **unknown**, not "no connection": every row from before this
  release, calls refused before the request was prepared, calls whose host
  matched no profile (or a host two profiles share),
  workflow-step calls and every tool other than `http_request`. Read the column as
  a lower bound, never as "everything that went through connection X".

### Added: a background task can ask a question and wait for the answer

- A scheduled task or trigger that asks the user something now parks in a
  `waiting` state for up to 24 hours instead of failing or carrying on without an
  answer. Its question goes through the same prompt store as chat questions,
  answering it makes the task due again, and the resumed run is told the question
  and the answer — the answer capped, both masked against stored secrets, and marked as data, not
  instructions. A task whose question went unanswered is no longer reported as a
  success, and its wall-clock budget pauses while it waits.
- **A parked question survives a graceful restart** and an engine restart. Chat
  questions still expire at restart, as before.
- *Run now* (`POST /api/triggers/:id/run`) on a task waiting for its answer is
  refused with `awaiting_answer`.
  Pressing stop on a run waiting for an answer now actually frees it; before, the
  stop answered OK and later messages to that thread got 409.
- A task in progress now holds a lease on its row (engine schema v16), so a second
  process or a restart does not start it again; a run lost mid-way is recorded as
  interrupted and not re-run when that would repeat its effect.
- The schedules view shows a task the agent scheduled that waits for your
  confirmation — with the instruction it would run or the address a watch would
  fetch, and how often — and a *Confirm* button. The task list says when a
  schedule is off, and for a failed one why it failed and whether it will try
  again.
- A saved workflow is no longer marked as confirmed by saving it; it is confirmed
  when a person schedules it. Scheduling a workflow from chat that cannot run
  unattended yet (not autonomous, not saved, or not confirmed) is refused with the
  missing step named, instead of promising a next
  run that never comes.

### Fixed: a scheduled mail is sent at most once

- Each due scheduled mail is now claimed before it is sent (`mail_scheduled.sending_at`,
  mail state schema v17), so a second poll or a second process cannot send it again.
  Only a failure that proves nothing was sent is retried; a timeout or an ambiguous
  answer is recorded and not re-sent. Cancelling works only on a mail that is still
  waiting.

### Changed: error texts sent to the client hide credentials

- Error responses of the HTTP API and the run-stream error — including the run
  error shown in the banner, the toast and the copy button — are masked for credential shapes (API
  keys with a known prefix, passwords in URLs) and for the values stored in the
  vault, and the run-stream error is length-capped. Masking runs before the cap,
  so a cut cannot leave half a key readable.
- Error reports sent to the configured error tracker are masked for credential
  shapes, including long opaque tokens, across the whole cause chain, breadcrumbs and the request URL; request headers
  and cookies are not sent, and the SDK's data collection is set explicitly. If
  masking itself fails, the field is replaced with a marker rather than sent raw.

### Changed: rendering hardening for Markdown, print and HTML artifacts

- Links and tables in rendered chat Markdown are now built by walking the
  sanitized DOM rather than by pattern over markup, and print/export styles are
  appended at the end of the document. One visible effect: print
  styles now win a tie against an artifact's own CSS.
- Code fences are put back into the rendered message verbatim, so a `$&` or `$1`
  in a code block shows as typed.
- The preview of an HTML artifact that brings its own document (in chat and in
  the gallery) gets its content security policy and resize script inserted as DOM
  nodes, so the artifact's own
  markup cannot displace them.
- Detection of untrusted-content boundaries sees through invisible Unicode format
  characters, and neutralising a stray boundary tag no longer swallows the text
  that follows it.

### Changed: wider credential detection on outbound content

- The scan that stops a credential from leaving in a request or a mail now uses
  one shared list of credential shapes, which adds OpenAI project keys, Stripe,
  Slack, Shopify and Google OAuth tokens, the remaining GitHub token prefixes and
  more private-key block types. It reads a URL as written and percent-decoded once, and an HTTP method nobody
  listed is treated as a write. A refusal names the way out. Configured API
  profiles still send the key they hold.
- The web UI's pasted-key guard and its display masking use the same list.

### Changed: tighter limits on what agents and sub-agents can reach

- **A sub-agent gets only the vault keys its order names** (`secret:NAME` in its
  task or prompt), not the whole vault of the agent that spawned it.
  `spawn_agent` takes `secret_scope` to name more, or `all`, which only an agent
  holding the whole vault can grant. When a child asks for a key it was not given,
  the parent is told which one and how to grant it.
- A role's tool statement (`readOnly`, `allowTools`, `denyTools`) now bounds a
  child on every route, an explicit tool list can only ask for less, and a
  `readOnly` role resolves only from tools whose effects end with the run.
  Workflow steps honour tools the user switched off. Spawned agents and workflow
  steps inherit the session context of the session that started them.
- With web search switched off, the provider-side web search is no longer handed
  back to workflow steps, chat sessions or spawned agents.
- Database files in the lynox data directory are now recognised by location and
  extension rather than a list of names, and are protected like the secret stores:
  blocked in autonomous runs and confirmed otherwise, for shell commands and
  `read_file`/`write_file` alike. An API profile can no longer
  point any of its key fields at an infrastructure secret or at the slot that holds
  the tenant's own provider key.
- Dialogs say who is asking: the credential dialog has a fixed title with the
  agent's explanation quoted below it, a question asked with `ask_user` is shown
  as the agent's text rather than as product text, and a dialog raised by a
  sub-agent says so.
- Results of `api_setup`, and mail opened through *Answer in chat*, go through the
  injection scan and are marked as untrusted, like the mail tool already was.
- The agent no longer tries to install a tool it does not have.

### Changed: API connections

- **Authorize in the browser:** `api_setup connect` hands the user a link to
  authorize a provider that has a redirect preset, instead of asking for a pasted
  token; the profile then renews its own token. A preset fixes the token endpoint and the scopes a profile may ask for.
- An oauth2 profile's token is renewed shortly before it expires instead of the
  connection breaking at expiry.
- A second profile whose id would share a vault slot with an existing one (`x-y`
  and `x_y`) is refused instead of reported as created.
- On a 401 from a profile whose credential the agent fills in, the reply says
  which part the agent owns and whether the vault holds a value under that name
  (names only), so the agent stops blaming a missing secret.
- A timed-out tool call, and a timed-out request that writes, now tell the agent
  the call may still have taken effect and to check before repeating it.
- Refused `http_request` calls and tools that fail with a normal-looking result
  (a non-zero `bash` exit, a failed research read) are booked as errors in run
  history, so `error_count` stops counting them as successes. What the model reads
  is unchanged. `ToolSoftFailure` is exported for plugins.
- The suggested-API catalogue the agent answers from now actually ships in the
  container image (it never did), and lists seven business providers in a section
  of their own.

### Fixed: hosted Google connections

- *Connect with Google* works again on instances that use the hosted Google
  connection, the connection is rebuilt at boot and survives a config reload, and
  its token is refreshed through the hosting side rather than with a client secret
  held by the instance.
- Revoking Google access says whether Google confirmed the revoke, not only that
  it was attempted.
- The Google client ID and secret are resolved as one pair from one source (vault,
  environment or config), so halves from two sources can no longer be combined;
  an empty environment variable no longer hides a working config file. On hosted
  instances a customer can save their own Google client pair.
- A service account is granted the scopes its token asks for (Gmail and Drive
  backup excepted).

### Fixed: chat and web UI

- After a dropped connection or a non-fatal error, the web UI asks the server
  whether the turn completed before marking it failed, so a finished turn is not
  sent and billed again. A tool call still running is no longer shown with a
  green check, and a lost question prompt comes back while its run is alive.
- A context compaction shows how much it freed instead of a progress figure, and
  the summary is written in the conversation's language, so a German thread no
  longer switches to English after compacting. `LYNOX_LANGUAGE` now reaches the
  model for the languages the product supports; before, it was recorded but not
  applied.
- Research answers carry their source links; links are underlined and off-site
  links open in a new tab.
- When the turn or cost cap stops a turn mid-tool-call, the thread keeps a note
  saying why, and the cost-cap message no longer points to settings that do not
  exist.
- Sub-agents: when all of them fail, each is named with its status; one that
  returns nothing is shown as returning nothing, not as a success; one stopped by
  its turn or budget cap says so.
- Memory: facts from a chat turn are captured again at the end of each web-UI
  turn, named after the people, organisations and products they are about, and
  shown in the thread where they were learned; facts from web or mail content
  still go to review. The review queue shows which subject an approval would
  attach to, and a decided chip no longer shows its "why queued" line.
- Mail: a mailbox's background polling error shows in its account settings, and a
  dropped IMAP connection during a search no longer breaks the mail listing.
- Voice: the voice list shows all of the provider's voices, `POST /api/speak`
  uses the requested language to pick one, and an empty recording on iPhone
  resets the microphone for the next attempt.
- The iOS app's chat composer can no longer be dragged into blank space
  (pull-to-refresh is off as a result); the welcome greeting follows the clock;
  an automatic reload now happens only for a script or style chunk that failed
  to load.
- The debug export includes durable knowledge and says why it can list fewer
  messages than stored rows.

### Changed: what the product says leaves your machine

- Settings, the voice label and the model catalogue no longer say that only the
  model call leaves a self-hosted instance or that "nothing leaves your machine": search, `http_request`, mail and connected APIs reach the network too.
  The sub-processor list and the `network_policy` description (deny-all blocks
  `http_request`, `api_setup`, research and connected Google accounts; the model
  call, IMAP/SMTP mail, voice and push are not covered by it) say what actually
  happens.

### Changed: network policy and models

- `network_policy`, the operator host list, `enforce_https` and the session cost
  cap are applied at boot even when run history fails to open. A wildcard in
  `network_allowed_hosts` is validated, and one ending in a numeric label is
  ignored with a warning.
- Two Fireworks preset models the provider withdrew are replaced with working
  ones. A model that cannot switch its thinking off fails with a clear error
  instead of an empty answer when the output budget is too small for its thinking. The catalogue notes that gpt-oss is a weak chat
  model.
- Backups now include `apis/`, `workspace/` and `artifacts/`, and instance
  migrations carry the whole of these directories (binary files survive), and an import refuses a bundle with a part
  it does not know instead of reporting success.
- The Docker image no longer downloads the onnxruntime GPU provider.

### Security: dependency updates

- `sharp` 0.35.5 for GHSA-wq5f-xc86-pv6w, in the package and in the docs site.
- `source-map-js` 1.2.2, `devalue` ≥ 5.9.3, `brace-expansion` ≥ 5.0.11,
  `@xmldom/xmldom` 0.8.15, `adm-zip` 0.6.1, `nodemailer` 10.x, `imapflow` 2.2.1, `better-sqlite3` 13.0.3 (uses its bundled prebuild)
  and `@sentry/node` 11.1.0.

### Internal

- Bulk changes with undo exist behind `bulk_runs_enabled`, which is off; their
  tables are created by the schema upgrade either way.
- On managed instances, where lynox supplies the model key, the engine reports a
  provider billing stop to the control plane, and the usage wire says explicitly whether an account is balance-gated.
- Release, CI and repository guards were tightened; tests run in their own temp
  directory on free ports.

### Upgrade and rollback

The upgrade moves three databases forward on first start, each step additive:
`engine.db` to schema **18** (from 11), `history.db` to **54** (from 52) and the
mail state to **17** (from 16). There is no down path, but 2.14.2 opens databases
at these versions: it does not refuse a newer schema and ignores the columns and
tables it does not know.

Before rolling back to 2.14.x, two steps:

- **Settle every parked trigger first** — every row in `engine.db` `triggers` with
  `status = 'waiting'`: answer its question or cancel the task. 2.14.x does not
  know the waiting state and treats a parked trigger as due on every tick. Its
  question would not survive the rollback either: 2.14.x expires all pending
  questions at start.
- **Check scheduled mails already claimed for sending** — rows in
  `mail_scheduled` with `sending_at` set and neither `sent_at` nor `failed_at`.
  2.15.0 claims a mail before sending it and does not send a claimed row twice;
  2.14.x does not read the claim and would send it again. Check the mailbox's sent
  folder and mark or remove those rows before rolling back.

Rolling back also brings back the two Fireworks preset models the provider has
withdrawn, which answer 404; pin a working model for those slots.

## 2.14.2 — 2026-08-18

A second repair, on the slot 2.14.1 brought back to life. Pointing the `fast`
slot at an id the provider still serves was necessary and not sufficient: the
model in it thinks before it answers, and its thinking floor is larger than the
output budget most of its callers give it. So it answered — with an empty
string, HTTP 200, `finish_reason: 'length'`, no error anywhere.

### Fixed
- **The `fast` slot returns output to the callers whose budgets are too tight to
  afford its thinking.** Measured against the live provider at each caller's real
  `max_tokens`: 4 of 6 came back empty — thread titles (64), retrieval HyDE
  (256), entity extraction (512), search reranking (512) — each having spent its
  whole budget on reasoning tokens. Nothing surfaced it: every one of those
  callers treats an empty result as "nothing to do". A model may now declare
  `defaultReasoningEffort: 'none'`, which the openai adapter applies at or below
  a budget bound. With it, all four answer, in roughly half the tokens and half
  the latency, and quality did not drop where the caller already worked — memory
  extraction stopped translating its output to English and stopped inventing
  three "durable facts" from a note that says nothing was discussed. (#1235)

  Two narrowings are deliberate and both came out of review. The declaration
  **wins** over the existing `features.reasoningEffort` ladder rather than
  yielding to it, because `features` is a shared object across six models — so
  flagging any one of them would otherwise silently un-suppress this one, and the
  ladder's lowest rung was measured not to suppress the floor at all. And it
  applies only at or below 1024 output tokens, the largest budget any of those
  callers passes, so a `spawn_agent` on the fast tier keeps its thinking.

### Known limits
The bench that put this model in the fast slot measured it WITH thinking, so
below the bound the shipped configuration is no longer the benched one. That is
not new with this release — today's shipped configuration is not the benched one
either, it is one that returns an empty string — but nothing re-benches the
suppressed slot yet.

The failure mode itself stays silent: an HTTP 200 with `finish_reason: 'length'`
and no content assembles into an ordinary empty message, so a future model in
this slot could reproduce the bug with no error anywhere. A detector for that
shape is owed, not shipped here.

### Upgrade and rollback
No schema migration, engine or control plane. Rolling back to 2.14.1 restores the
empty responses on the four tight callers.

## 2.14.1 — 2026-08-18

A repair release. The `fast` slot had been naming a Fireworks model id the
provider stopped serving on 2026-08-14, and every caller that routes to that
band — compaction, memory and knowledge extraction, a workflow step that
declares no model — had been failing daily since, on all four production
instances, without surfacing anything: each of those callers catches. The other
two entries are the same shape of quiet wrongness. A number that was right
about the wrong thing. A limit the agent could hit but not see.

### Fixed
- **The `fast` slot names a DeepSeek id Fireworks still serves.**
  `accounts/fireworks/models/deepseek-v4-flash` was withdrawn in favour of
  `…-flash-0731`. Nothing made the failure visible: compaction leaves the
  summary empty and its guard deliberately suppresses the reset, so the thread
  survives and no one looks; extraction skips; an undeclared workflow step dies
  at step 0 with an empty `stepErrors`, which reads like a cap. A new online
  test inverts the usual skip rule for this class — with a provider credential
  present, a slot a preset pins that answers anything but 200 now FAILS instead
  of skipping. Without a credential it still skips, because then we genuinely
  did not test it. The next withdrawal is caught by the suite rather than by a
  customer four days later. (#1232)
- **A workflow step is recorded against the model that ran it, not the one it
  requested.** The row stored the DECLARED tier, so any step whose request was
  clamped — the headless `deep` → `balanced` rewrite, an account-tier ceiling,
  a blocked model id — was filed and priced as the tier it had asked for. That
  row is what the consent dialog estimates a run's cost from, so a clamped step
  made the estimate read high against a run that would have been cheap. Price
  and label now read one resolver call. (#1231)

### Changed
- **The agent can see the per-conversation request cap and plan around it.**
  `http_request` is capped at 100 calls per conversation, and that budget is
  SHARED with sub-agents — so splitting a bulk job into children buys nothing.
  Neither fact was stated anywhere the model could read it, so a job larger
  than the cap walked into the wall blind. Both are now in the tool
  description, together with the escape that does work: a stored workflow fired
  once per batch, where each firing gets its own budget. `task_create`
  therefore accepts `params` to re-target a stored workflow per firing —
  rejected without a `workflow_id`, scanned for injection like every other
  free-text field it carries, and counted as a firing by the confirmation gate,
  which had not been counting `workflow_id` at all. (#1233)

### Upgrade and rollback
No schema migration, engine or control plane. Rolling back to 2.14.0 restores
the dead `fast` slot, so an instance that rolls back should carry an explicit
`compaction_model` until it rolls forward again.

## 2.14.0 — 2026-08-18

A routing release. The control plane can now decide which model sits behind
each band of an instance, which is what makes a customer's bill movable
without asking them to change how they work. Everything else in here is what
that turned out to require: the pin has to be honest about whether it took
effect, it must never cost the instance its boot, and the money it moves has
to be metered against the model that actually ran.

### Changed
- **The control plane can pin a routing preset per instance, and a tenant's own
  choice still wins.** `LYNOX_TIER_PRESET` names one of the shared presets; the
  engine expands it to the same `{routing_mode, tier_set}` the settings picker
  produces. It is a SEED, not a lock: it fills an empty selection and never
  overwrites one the tenant made. That is a reversal from how it shipped
  mid-cycle, and the reason is measured rather than argued — as a lock it bound
  only the picker (a tenant writing explicit slots already beat it) and there it
  failed silently: the write was accepted, persisted, reported back, and then
  discarded at load. (#1217, #1220)
- **An unknown pin is ignored, not fatal.** The name is validated before it is
  adopted. Previously an unrecognised value reached a fail-closed expander that
  throws, and `loadConfig()` in the engine constructor has no catch — so a pin
  the running image did not know took the container down, with the settings UI
  needed to clear it served by that container. The same now holds for an
  unresolvable name in the instance's own config: it is dropped with a warning
  and the instance keeps its default routing. The fail-closed guard that
  protects money — a preset that resolves but names an unregistered model — is
  unchanged. (#1223)
- **The preset ladder is one axis: the main slot.** Two Fireworks sets that
  differ in exactly that slot, plus an all-Anthropic set. `efficient` →
  `balanced` buys a stronger main for 3.7× the output price, and the main is
  the slot that runs every turn, which is why it is the only axis worth a
  separate preset. A preset name and its table are now two halves the compiler
  joins, so neither can exist without the other. (#1185, #1187)
- **A workflow step is priced against the model that ran it.** Step cost, the
  budget reservation and the persisted `model_id` resolved through the base
  provider's tier map, so on a hybrid instance they named a model that never
  ran — roughly a tenfold over-charge against the tenant's included budget
  under the cheap presets. The comment above the call already claimed this
  property; the base-provider half had been fixed and the hybrid-slot half
  missed. (#1221)
- **The workflow step cap is config-overridable, and in-session runs inherit
  the same limits as saved ones.** Parallel phase concurrency is bounded, and
  two fail-open gaps in the spend guards are closed — a malformed width no
  longer switches backpressure off entirely. (#1204, #1205, #1206, #1216)
- **`spawn_agent` asks before it spends a deep tier**, with a
  deny→balanced downgrade instead of an all-or-nothing refusal, and headless
  runs clamp rather than prompt. The proactive-deep guidance offers the deep
  tier instead of spawning one. (#1200, #1201, #1202, #1215)
- **Large chat uploads are stored as files instead of inlined.** A 200k-character
  paste used to enter the conversation whole and be re-read as a cache write on
  every subsequent turn. Oversized tool results are parked and recallable rather
  than dropped. (#1190, #1212)
- **Model picker labels state the context window**, and `active_model` resolves
  through the tier_set rather than the base provider map — on a hybrid instance
  the two used to disagree, and the capability flags beside them inherited the
  wrong answer. (#1165, #1194)
- **`GET /api/config` reports the routing strategy the engine runs**, not the
  raw config file. A pinned instance carries no preset in its file at all, so
  the response said "no preset" about an engine that was routing one — which is
  also the surface an operator uses to check that a pin took effect. (#1224)

### Fixed
- **A display name can no longer add a mail recipient.** A non-ASCII name went
  out as an RFC-2047 atom in a context whose grammar forbids it, so a name written by
  someone else could inject an address the consent preview never showed.
  Found and fixed on the Gmail path, then found again on IMAP/SMTP, where it
  was worse: recipients went pre-serialised to nodemailer, which re-parses them,
  and the injected address became the sole envelope recipient. Fixed
  structurally — addresses are passed as objects — rather than with more
  escaping. (#1219)
- **Encoded-words are split at the 75-character limit**, and a From-persona no
  longer breaks subject encoding. (#1197, #1199)
- **The engine's own secret files are guarded against agent reads — the ones it
  actually writes.** The list had been written from the filenames the engine's
  code creates, which is not the set a deployment ends up with: the container
  entrypoint writes two of them elsewhere, the conversation store was on no
  list, and the backup directory holds copies of all of them. Self-host only;
  managed receives these values as container environment and never materialises
  the files. (#1164, #1222)
- **The client does not re-POST a run after an SSE transport failure.** A
  stream that died with no applied events was treated as "never started" and
  re-fired, which minted duplicate billed runs out of a transport hiccup. The
  server is now the authority on whether the run is alive. (#1213)
- **Durable knowledge is judged by ownership, not by whether a tool ran**, and
  review chips survive transcript adoption, late arrival and thread resume.
  A warning fires when durable knowledge is enabled but the model is barely
  capturing. (#1167, #1169, #1171, #1175, #1179, #1211)
- **Tool-call recording has one owner** instead of N listeners, records on the
  failed-run path, and no longer attributes another conversation's calls to
  this run. (#1180, #1183, #1188)
- **Files whose name holds a non-ASCII byte are no longer skipped.** (#1184)

### Upgrade and rollback
No engine-schema migration. Four control-plane migrations from this cycle
(0050–0053), all additive and idempotent; the vendored wire contract moves with
this release and its control-plane sync must land before the control-plane
deploy.

Rolling back to 2.13.0 is safe for the engine: the new config fields are
optional everywhere, and an older image simply ignores `LYNOX_TIER_PRESET`
rather than failing on it — that is the pre-change behaviour, not a new one.
An instance that was pinned keeps routing on its own configuration.

Two known limits are stated rather than left to be discovered. A mail body's
signature block still collapses onto one line when the model hard-wraps it;
three separate attempts at a rule that could tell an author's line break from a
machine wrap were measured wrong in both directions, and shipping any of them
would have reintroduced mid-sentence breaks. And an ignored pin is reported in
the API response but no interface renders it yet — the operator-facing signal
today is a log line.

## 2.13.0 — 2026-08-09

A cost release. Its origin is one afternoon of real usage: a customer's
workflow ran a 2000-contact pagination step on the premium tier with the full
toolset — including a shell nobody asked for — and an approval dialog could not
say who was asking. Every default this release changes is one nobody had
chosen.

### Changed
- **A workflow step that declares no capability tier runs on `fast`.** The
  resolution chain is step > role > `fast`; the session default deliberately no
  longer reaches steps. Measured before shipping on the mechanical shape that
  prompted it (2000 contacts, 100 per page, stop signal = empty page, three
  repeats per tier): the fast tier was 3/3 perfect on every gate — all pages,
  no duplicates, correct total. A declared step tier and a role tier still win.
  The budget check, the step record, and the plan-time estimate share the same
  fallback, so none of the four surfaces can disagree about what an undeclared
  step costs. (#1157)
- **A generated workflow step declares its tools; `bash` is never granted
  silently.** The planner (plan_task and the auto-planner) must name the tools
  each step needs; the step gets exactly those, drawn from the inline-safe
  pool. A step that declares nothing keeps the pool minus `bash` — a shell now
  requires a declaration or a role grant, never a default. A typo'd tool name
  fails loudly at save with the grantable list instead of degrading to a silent
  "tool not available" mid-run. Validated on the wire across providers: 18/18
  generated steps declared valid sets, and neither model reached for bash
  without a reason. (#1157)
- **A saved artifact's body leaves the conversation on the next turn.** After a
  successful `artifact_save`, the body in the conversation buys nothing — the
  artifact is persisted, the result names its id and file path, and the agent
  can read the file if it needs the content again. Measured on a real thread:
  134 KB of artifact bodies re-read as cache writes on every subsequent run,
  19.1% of that thread's cost. The turn that produced the save keeps its body;
  a failed save keeps it forever (it is the only copy left); the persisted
  thread history — what the UI renders and debug-export reads — is untouched.
  (#1158)

### Fixed
- **The composer stays at the bottom of the chat.** With a tall block between
  transcript and composer — a changeset review, a batch of approval dialogs, a
  running workflow's progress — the whole column grew past the shell and the
  composer rode out of the viewport. The non-transcript stack is now capped
  and scrolls internally; the conversation keeps at least 40% of the height.
  Reported from a phone and a Windows PC during a live workflow run. (#1156)
- **The auto-planner's per-step tier choice reaches the pipeline.** The plan
  conversion dropped the `model` field, so every auto-planned step ran on the
  undeclared default despite the planner declaring a tier per step. (#1157)
- **In-session workflow spend is billed per step under the tier the step ran
  on.** One aggregated debit under the session tier would have reported
  fast-tier spend as balanced — the same mis-attribution 2.12.1's predecessor
  fixed for helper calls, on a new surface. (#1157)

### Upgrade and rollback
One engine-schema migration (history.db v52, additive: approval prompts carry
their origin). Two control-plane migrations pending from 2.12.x, both additive
and idempotent. Rolling back to 2.12.1 is safe: evicted artifact bodies exist
only in the wire-side conversation, never in stored history, and the new step
fields are optional everywhere.

## 2.12.1 — 2026-08-08

A patch for two things the status bar and the composer were getting wrong on a
hybrid setup, plus the dependency pin that forced the cut.

### Fixed
- **The status bar names every provider the router reaches.** It reported one.
  Under hybrid routing each tier can sit on a different provider, but the list
  was assembled from two hard-coded slots — the top-level provider, and Mistral
  if its key was set and the primary was not already Mistral. An instance routing
  fast→Mistral, balanced→Fireworks and deep→Anthropic therefore named one of the
  three, and when the primary *was* Mistral the second slot was suppressed too.
  The list is now derived from the tier set, and each provider is counted once
  even when two tiers share it. (#1149)
- **The deferred follow-ups tray is removed.** It captured the un-taken
  suggestions of a chip you clicked, automatically, and pinned them above the
  composer until you dismissed them by hand — then had to guess whether a later,
  rephrased suggestion was one it already held. That guess was an exact string
  comparison over text the model rewrites every turn, so it never matched: the
  shelf grew, showed near-duplicates of the live chips, and cost a permanent row
  on a phone. Follow-up suggestions are now inline only, for the turn that
  offered them. The replacement is an explicit one — you mark what to keep — and
  is being designed rather than patched in. (#1150)

### Security
- **nanoid is pinned past `GHSA-2v37-7h3g-55p8`** (CVSS 8.2), in the root tree
  and in the docs tree, which has its own lockfile. Neither was introduced here;
  the advisory is new. (#1151)

### Also worth knowing
- `GET /api/providers/status` and `GET /api/provider/status` now require
  authentication. They were public, which was defensible while they reported a
  vendor's status page — they now report which providers *this* instance routes
  to and which of them recently failed, which is instance configuration. The web
  UI already sent credentials on both calls.
- The dependency scan reads the root lockfile only, so the docs tree — a
  separate, non-workspace package — is invisible to it, including to the release
  gate. Found while fixing the advisory above and tracked; not switched on in a
  patch, because doing so fails every open branch the moment it lands.

### Upgrade and rollback
Nothing to migrate; no schema change in either repo. Rolling back to 2.12.0
restores the tray, including any entries still persisted from before the
removal — nothing was deleted from storage.

## 2.12.0 — 2026-08-07

A memory release. The durable knowledge store stops being an opt-in experiment and becomes the default for newly provisioned managed tenants, which raises a question the earlier phase could postpone: if the agent keeps what it learns, you have to be able to see it, correct it, and delete it. So this release ships the other half — a fact you can drop, a subject you can erase from both stores, a chip that says what it is asking about, and a recall surface that reports what is still waiting by count rather than by adjective. Alongside it, delegation stops being invisible: a sub-agent's activity is attributed to the sub-agent, and a delegated turn says what it cost and how long you waited. Calendar reading arrives as an ICS feed reader and ships **off on every tenant**. Two control-plane migrations, both additive; the engine schema does not move.

### Added
- **Durable knowledge is the default for new managed tenants.** The per-tenant column's default flips to `true`. Existing rows are untouched, so a tenant switched off by hand stays off, and the operator flip remains the way to change one.
- **Erasure that reaches both stores.** A subject or entry can be deleted, and the reap that removes its orphans actually runs. A tenant on durable knowledge has data in two databases, and until now only one of them had a delete path. (#1119, #1137, #1142)
- **The always-loaded profile block is seeded from the onboarding answers**, so what you told the agent on day one is present on every turn instead of waiting to be retrieved. (#1136)
- **Recall says what is waiting.** A conversation with unconfirmed facts says so, by count — never by wording that implies more or less certainty than the number supports. (#1141, #1143)
- **Calendar reading from an ICS feed**, with a settings page that says where to find the address. **Off by default and off on every tenant in this release** — with the flag off the tool is not registered at all, so the decision space and the cached prefix are byte-identical to a build without it. (#1144, #1145)
- **Sub-agent attribution.** A delegated run's activity is shown as the sub-agent's, not the main chat's, and the composer is no longer blocked while one is in flight. The run names the provider and model id it actually used. (#1100, #1098)
- **A delegated turn reports its cost and its wait.** (#1101, #1111)
- **Basic and split user/password auth** are implemented paths in API setup rather than options that could be selected and then failed. (#1138)
- **A capture-fitness evaluation with a labelled denominator** — the measurement that produced the funnel number below. (#1130, #1114)

### Fixed
- **A wrong fact can be dropped from the Wissen view**, and the knowledge chip says which subject it is asking about instead of showing an unanchored prompt. (#1137, #1139)
- **An ambiguous alias is refused instead of resolving to whichever row came first.** The lookup now returns either a resolution or the candidate list, so every caller has to decide what to do with an ambiguity rather than inherit a silent pick. (#1108)
- **The legacy memory archive is no longer written under durable knowledge**, which had been mixing two retention stories in one place. (#1135)
- **The compaction offer stays with its thread** instead of following the user to the next one, and both of its exits are covered. (#1117, and the thread-scoping fix)
- **The reasoning channel survives the OpenAI-compat wire** instead of being discarded on the way through.
- **Follow-up chips are recovered on models that skip the tool call.** (#1099)
- **The balance mirror clears on an explicit null** rather than freezing at its last value, and a tier disagreement between the mirror and its source is reported instead of hidden. (#1102, #1127)
- **The cache-miss detector is gated on what was observed on the wire**, not on what the provider config says should be possible. (#1110)
- **The calendar expander is bounded.** A contracting recurrence rule below `MONTHLY` had no bail-out, so a crafted or merely unlucky feed could search indefinitely; unexpandable rules are now detected up front and skipped, including inside timezone definitions. (#1146)
- **A helper call is no longer debited twice.** Its cost is added to what a managed tenant is *shown*, and deliberately not to what they are *charged* — the helper already reports its own metered cost under its own run id, and the deduplication is per run id. (#1147)

### Security
- **An uploaded document is treated as the untrusted content it is.** (#1140)
- **The wire-capture sinks are refused on a control-plane-provisioned instance**, where the operator is not the only party whose data would land in them. (#1103)
- **The durable-knowledge trust gate fails closed**, and the write-trust backstop's refusal is consulted rather than discarded. An approved entry derives its tier from evidence that can be re-derived, so an approval cannot silently outrank its own basis. (#1116, #1126, #1128)
- **One injection channel that detection cannot see is guarded structurally** instead of scanned. (#1113)
- **The provider key slots are protected from an agent-initiated overwrite.** They are agent-*visible* by design — which is a different question from agent-*writable*. On BYOK an injected write would have destroyed access the operator cannot recover. (#1147)
- Advisory floors raised past two high-severity findings. (#1134)

### Changed
- **The merge rule is a check rather than a paragraph.** A pull request now carries a gate record pinned to its head SHA; the check enforces that the record exists and describes the current code, and documents plainly which of its lines it can verify and which are attestations. Binding customer texts additionally require a named human sign-off with a date. (#1104, #1105, #1118)
- **The durable-knowledge capture rate is a measured number** — 3.4% of carriers on the reference corpus, 4.5% on `mistral-medium` — rather than an assumption. The first denominator this project used was three times too small, because it counted carriers as turns. (#1114)
- The Fireworks sub-processor scope was corrected to match what the code actually does. (#1109)

### Upgrade and rollback notes
- **The engine needs nothing on upgrade.** No new tables, no new columns, no schema-version move.
- **Two control-plane migrations ship**, both additive and idempotent: the durable-knowledge column default flips to `true` (inserts only — existing rows are untouched), and a `calendar_enabled` column is added defaulting to `false`.
- **Turning durable knowledge back off** is a two-part revert, and it is worth knowing before you need it: the column default has to be set back to `false` *and* the provisioner reverted, because a default is not what an already-provisioned tenant reads. A single tenant is switched with the operator flip plus an env sync. The procedure is written down in the hosting repo's release strategy.
- **Rolling back to 2.11.0:** nothing to undo by hand. Both new control-plane columns are ignored by the previous build, and durable knowledge written by 2.12.0 is readable by 2.11.0 — what changes is the default a *new* tenant comes up on, not the shape of anyone's data.
- **The calendar reader is off** and stays off unless a tenant is deliberately flipped on. It is shipped rather than held back because the surface is inert while the flag is false; the open items behind that decision are tracked, not forgotten.

## 2.11.0 — 2026-07-29

An onboarding and trust release. First run now grounds the agent in the business it is pointed at instead of starting from an empty context: it reads the site, asks the three to five questions that reading made possible, and keeps the answers as durable knowledge rather than chat scrollback. The second theme is confirmation prompts — everything the model writes into one is now rendered as text instead of parsed as markup, so a tool result cannot dress itself up as part of the question you are approving. Claude Opus 5 joins the catalog, and operators get a model blocklist. Engine schema moves to v51 (additive); one control-plane migration ships.

### Added
- **Guided first-run onboarding.** A short flow that scans the site you name, asks questions grounded in what it actually read, and records each answer as durable knowledge. Progress is tracked per flag rather than as one boolean, so a partly-finished run resumes where it stopped. (#1070, #1071, #1072, #1074)
- **Claude Opus 5 in the model catalog**, selectable in the per-tier picker. (#1067)
- **Operator model blocklist.** `LYNOX_BLOCKED_MODEL_IDS` takes comma-separated model-id prefixes the engine refuses to run, so a whole family can be locked out with one entry. It is enforced at config load, on config write, and at tier resolution, and is orthogonal to the cost band `max_tier` sets. (#1063)
- **Fireworks models in the per-tier picker**, via the catalog's tier list rather than a hard-coded branch. (#1061)
- **A waiting prompt announces itself out-of-tab.** When the agent parks a question, the title carries a badge and a notification fires, so a run does not sit idle because the tab was in the background. (#1073)
- **Same-site links from `web_research` and `http_request`.** A page read now carries the links it points at, so a follow-up read does not need a second guess at the URL. (#1083)

### Fixed
- **Confirmation prompts no longer parse model-written text as markup.** The prompt is split into the frame the system wrote and the values interpolated into it; values render as text nodes. A tool result can no longer inject markup into the sentence you are being asked to approve. (#1078, #1084, #1082, #1080)
- **Mail confirmations show the real body size** instead of a figure that ignored part of the message. (#1077)
- **Large HTML responses are extracted to text**, and onboarding no longer fetches the same page twice. (#1075)
- **`web_research` reads the whole page instead of picking part of it.** The article-selection step routinely scored a code sample or the nav bar highest on documentation and JS-rendered sites and returned that alone — and because a short wrong answer is still non-empty, the fallback never fired. Stripping the document can carry boilerplate, but it cannot silently lose the content the task needed. (#1081)
- **Identical tool-call loops are broken deterministically** instead of running until the iteration cap. (#1065)
- **Streaming usage survives a trailing usage chunk.** Providers that send usage after the final content chunk no longer produce a run with no recorded cost. (#1062)
- **Voxtral TTS is pinned to a dated snapshot** rather than a moving alias, which was silently changing voice behaviour. (#1066)
- **An existing user no longer sees the first-run stepper.** The backfill marks accounts that were already using the product before onboarding existed. (#1090)
- **Recall handles name the call they stand for**, so a memory reference in a transcript can be traced back. (#1079)

### Changed
- **The cross-repo wire contract is complete.** Auth and OAuth shapes, the guarded-capable boot marker, and the conventions the hosting side depends on now all have one source of truth in `src/contract/`, verified byte-for-byte in every consumer. (#1087, and the convention pins)
- **Internal cross-references are out of the public source** and a guard keeps them out. (#1092)
- **Recall measurement got a readable baseline.** The evaluation now replays the same corpus with archival memory off, so the bars mean something relative to the pipeline they are being compared against. (#1085)
- Durable writes record which signal put them on the untrusted side (#1089); the gold-set proposal model is pinned to a dated snapshot (#1076); brace-expansion and postcss bumped to clear advisories (#1068).

### Upgrade and rollback notes
- **Forward upgrade needs nothing on the engine.** Schema v51 adds a nullable `segments_json` column to `pending_prompts`, and the subject-graph store gains an `onboarding_flags` table plus an idempotent backfill. All three apply on boot and are additive.
- **One control-plane migration ships** with this release: an additive column on the customer table plus an idempotent backfill. It applies automatically when the release publishes.
- **Rolling back to 2.10.0:** nothing to undo by hand. The new engine columns and table are nullable or unread by 2.10.0, and the control-plane column is likewise ignored by the previous build. A prompt written by 2.11.0 renders in 2.10.0 as its flattened text, which is the same string 2.11.0 shows — the segment detail is simply not used.

## 2.10.0 — 2026-07-22

A model-strategy release. The measured finding behind it: a 14B-class main model answers deep-worthy tasks inline instead of delegating them, so the every-turn main on the managed Efficient and Balanced presets — and the BYOK-Mistral balanced tier — moves up to Mistral Medium 3.5. Claude Fable 5 becomes the max-quality preset's deep slot. The release also introduces a shared wire-contract module (one source of truth for tier vocabulary, env-ABI and wire shapes across engine, web UI and the managed control plane), opt-in extended debug capture, and feature-gated proactive deep escalation (default off). Engine schema moves to v50 (additive).

### Added
- **Floor-clearing main model for tier presets.** The Efficient and Balanced managed presets run Mistral Medium 3.5 as the every-turn main; Ministral 14B measured below the orchestration floor (it answered deep-worthy tasks inline, 2/22 escalations over the replay set). (#1045)
- **Extended debug capture, opt-in and default off.** Wire-level snapshot capture with triple redaction, encrypted at rest, bundled into debug exports with a typed wire-diff view; Settings toggle with consent copy. Deleting a thread removes its captured snapshots. (#1044, #1046, #1058)
- **Proactive deep escalation, feature-gated and default off.** (#1041, #1042)
- **Claude Fable 5 as the max-quality preset's deep slot.** (#1039)
- **Wire-contract module `src/contract/`.** Canonical tier vocabulary, env-ABI registry and money/health wire shapes with golden fixtures — the single source of truth for core, the web UI and the managed control plane, guarded by byte-equality checks on every consumer. (#1049, #1050, #1051, #1052)

### Fixed
- **Mistral deep tier moves to Mistral Medium 3.5**; Mistral Large 3 becomes a legacy catalog option. The BYOK-Mistral balanced tier is lifted to Medium 3.5 as well. (#1040, #1053)
- **Image input works on the Mistral balanced and deep tiers.** Medium 3.5's vision capability is verified live; without the flip every image message on a Mistral main failed with a pre-flight error. (#1056)
- **Main-model picker handles providers whose balanced and deep bands share one model.** Options are keyed and selected per band, so the settings page renders correctly and a deep selection stays deep. (#1057)
- **Debug-capture toggle reflects operator environment overrides** instead of silently writing a dead value; the CLI installer recommends the current Mistral default. (#1058)
- **Long streaming responses retry on dropped provider connections.** Adapter HTTP errors are classified by status code, never by response body text. (#1045)
- **Managed provider tile no longer lists internal providers; mobile status footer unclipped.** (#1037)

### Changed
- README/ROADMAP claim refresh with drift-guard fact checks (#1043); Fireworks AI added to the sub-processor list for the managed Efficient preset's deep tier (#1038); sharp overridden to >=0.35.0 (#1047); behavior-critical control-plane env vars pinned to their engine consumers (#830).

### Upgrade and rollback notes
- **Forward upgrade needs nothing.** Engine schema v50 (`wire_snapshots`) is additive and applies on boot; no control-plane migrations ship in this release.
- **Rolling back to 2.9.1:** (1) first reset any custom `tier_set` slot pinned to `claude-fable-5` — 2.9.1 either prices it at generic fallback rates or, for preset-plus-override configs, refuses to boot; (2) delete `wire_snapshots` rows — 2.9.1's data-wipe and key-rotation paths don't know the table; (3) a config saved by 2.10.0 that contains the new `debug_wire_capture` key is ignored as a whole by 2.9.1 until re-saved (self-healing, matches the 2.9.0 caveat).

## 2.9.1 — 2026-07-21

A targeted patch on 2.9.0. It stops an end-of-turn loop where a reply that ended with follow-up suggestions could re-run the model several times before finishing — a slow, token-burning turn that affected instances with plugins active (the default). It also drops the unused bundled npm/corepack from the runtime image, shrinking it and clearing a base-image dependency scan. **No migration** — clean image swap in both directions.

### Fixed
- **Follow-up suggestions end the turn instead of looping.** On plugin-enabled instances (the default), the terminal `suggest_follow_ups` step had lost its "ends the turn" marker inside a tool wrapper, so a reply that closed with suggestions re-ran the model several times before stopping. The wrapper now preserves every tool property, so the turn ends cleanly after one set of suggestions. (#1034)

### Changed
- **Smaller, hardened runtime image.** The bundled npm and corepack package managers — never used at runtime — are removed from the production image, reducing its size and attack surface and clearing a base-image dependency scan. (#1035)

## 2.9.0 — 2026-07-21

This release makes model choice a **named strategy** you pick, not a per-tier fiddle. A model preset (a "Modell-Strategie") maps each routing tier to a specific provider's model in one step — chosen from cards in settings or a compact picker in the chat header — with the backing host disclosed so you always know where a turn runs; Fireworks joins as a new provider option, gated off until its key is provisioned. Under that, the durable-knowledge capture path is hardened at the source so a poisoned or low-value fact is stopped and metered before it can enter memory, and the agent's tool prefix shrinks by loading heavy tool guidance only on first use (cache-safe, behaviour-identical). The rest is chat- and rendering-correctness: a resumed multi-step turn renders as one bubble, the first-turn briefing is clean and current, and vision works on gen-3 Mistral models. **No engine.db migration** — the engine store stays at schema v7. **Rollback caveat:** an instance that has adopted a model preset must switch its strategy back to Standard (clear `tier_preset`) *before* rolling back to 2.8.0 — the 2.8.0 engine rejects the unknown `tier_preset` key under a strict config parse and would discard the whole config file. Instances that never picked a preset roll back as a clean image swap.

New env vars (both optional, managed-only, default off): `FIREWORKS_API_KEY`, `LYNOX_MANAGED_FIREWORKS_ENABLED`.

### Added
- **Pick a named model strategy (Modell-Strategie).** A model preset maps each routing tier to a specific provider's model in one step — selected from cards in settings or a compact picker in the chat header — and the backing host is disclosed so you can see where each tier runs. An unknown or unregistered preset fails closed: it won't silently fall back to a mis-billed default. (#1022, #1023, #1024, #1028)
- **Fireworks as a provider option.** Fireworks-hosted models can back a tier, gated off until the key is provisioned — a preset that needs Fireworks is rejected rather than run against a missing key. (#1024, #1026)

### Changed
- **Smaller tool prefix — heavy guidance loads on first use.** The verbose narrative for four tools (recovery rules, anti-patterns) moved out of the always-cached prefix into a model-only block injected once per thread on first use, trimming the static prefix without changing which tools the model picks (confirmed by a real-API A/B). (#1006)
- **Workflow inline steps can browse and fetch.** Inline workflow steps now have `http_request` and `web_research` available. (#1009)

### Fixed
- **A resumed multi-step turn renders as one bubble.** Reopening a thread mid-run no longer explodes a single multi-step turn into N separate bubbles; a settled thread adopts the merged, shorter server transcript instead of the longer local one; and reopening a thread while a turn is in flight no longer drops the just-sent message. (#1018, #1019, #1032)
- **Clean, current first-turn briefing.** The opening briefing drops the internal scope/data-transport leaks and keeps the loaded-context preamble out of your message bubble; the overdue/due-today task overview it surfaces is recomputed per thread (not a stale boot snapshot), and the agent no longer auto-acts on a task it merely surfaced. (#1011, #1014, #1016, #1032)
- **Notification tap opens the right thread.** Tapping a task notification opens that task's thread. (#1017)
- **Vision on gen-3 Mistral models.** Image input is enabled on gen-3 Mistral models. (#1015)
- **Chat + artifact UI polish.** Opaque toasts, the composer's model picker reflects a settings change immediately, user bubbles pre-wrap long content, the hybrid-routing footer and keys row no longer overflow, the artifact card gained export feedback and a gallery link, and the Mermaid PNG export surfaces an error instead of a silent dead click. (#1012, #1013, #1027, #1032)

### Notes
- **Durable-knowledge capture hardened at the source.** The durable-knowledge path now stops a poisoned or low-value fact before it enters memory, with telemetry on what was caught. On **managed** plans, an `update_memory` re-extraction is now credit-gated and debited like any other model call (self-hosted is unaffected — no metering). This strengthens the substrate that remains **opt-in per instance** (default off; enabled on selected instances only). (#1029, #1030)
- **Memory write-trust hardening.** The explicit memory tools (store/update/promote) now treat a write made on a turn that read external content (a web page, a mail, a file) with the same caution as the automatic capture path — such a write is routed to the review queue rather than recorded as a trusted fact, on both the fallback and the exact-edit path. The parent↔child taint signal for spawned sub-agents was made symmetric, and the first-turn briefing is fenced against injected instructions in task titles. (#1031, #1032)
- **Supply-chain + CI.** A daily dependency scan now gates the release build, and two vulnerable transitive dependencies (adm-zip, brace-expansion) were pinned to patched versions. (#1007, #1010, #1031)

## 2.8.0 — 2026-07-17

This release lands the **Durable Knowledge** substrate: a second, archival memory tier that keeps durable facts without the byte-cap and oldest-first eviction of the working store, with a review queue and curation tools for what lynox learns, and an in-chat surface to see and correct it as it happens. The whole substrate ships **dormant** behind a per-tenant flag — default off, byte-identical engine behaviour — and is turned on per instance by an operator, not by this release. Separately, the follow-up "what next" suggestions now arrive through a structured tool instead of parsed text, so they can no longer leak as raw JSON and they survive a thread reload; the managed control plane gains a per-run cost ceiling and a live balance mirror; and the secret vault reconciles near-identical key names instead of stashing a duplicate. **No active engine.db migration** on the default fleet — the durable-knowledge table only materializes once the flag is on. Rollback to 2.7.1 is a clean image swap.

### Added
- **Durable Knowledge — an archival memory tier (dormant).** Alongside the working memory store, lynox can keep durable facts in a separate archival store with no byte-cap and no oldest-first eviction, so a long-lived fact isn't pushed out by recent chatter. Anything learned from untrusted content — a web page, an inbound mail — lands in a review queue instead of active memory, and curation tools let a fact be retired, pinned, or archived. Ships behind a per-tenant flag, default off: no behaviour change until an operator enables it. (#996, #997, #998, #1000)
- **See and correct what lynox remembers, in the chat.** When durable knowledge is on, a Knowledge view shows the active facts plus the profile and playbook blocks (secret-masked), and the moment lynox records something you see it inline: a confirmation you can undo for something you told it directly, and a review chip — keep, discard, or edit — for anything learned from external content, so an injected line can't become a durable fact without your click. (#1002)
- **A per-run cost ceiling and a live balance mirror on managed.** A managed workflow run is now bounded by a per-run cost ceiling, and the tenant's balance is mirrored into the engine so spend is visible and capped per run instead of only reconciled after the fact. (#989)

### Fixed
- **Follow-up suggestions come through a structured tool, not parsed text.** The end-of-turn "what next" pills are emitted as a tool call instead of a trailing text block, so they can no longer leak as raw JSON when a model omits the wrapper, they render live, and they survive a thread reload. Suggestions you didn't take earlier in the turn stay available in a tray. (#1003)
- **The secret vault reconciles near-identical key names.** A key stored under a slightly different name — a guessed vendor namespace, a near-duplicate vault entry — is reconciled against the existing one instead of creating a second, divergent copy, and the vault gained a list action to see what's stored. (#990, #992)
- **The agent's tier-to-model map is grounded, not guessed.** The prompt that tells the agent which model backs each tier is derived from the real routing configuration instead of a hard-coded guess that could drift from it. (#991)
- **The OpenAI-compatible stream has an idle timeout.** A stalled response from an OpenAI-compatible endpoint no longer hangs indefinitely — an idle timeout closes it. (#999)
- **Message timestamps show on Safari and Firefox.** A restored message's timestamp no longer comes up blank on Safari or Firefox (a date-parsing difference from Chrome), and the durable-knowledge review surfaces gained accessible names for screen readers. (#1005)

### Notes
- **Memory write-trust gate ships dormant.** A second-wave memory control — a write-trust gate plus a read-cosine floor — is present but default off, with no behaviour change until enabled. (#995)
- **Durable knowledge is opt-in per instance.** On hosted plans the substrate is enabled per instance by the operator; self-hosted enables it with an environment flag. Default off means no behaviour change until you turn it on.

## 2.7.1 — 2026-07-15

A small polish release for the chat surface. The composer's model picker now reflects hybrid routing honestly — a tier pointed at a different provider shows that provider's model, not the base default — and the follow-up "what next" pills no longer leak raw JSON when the agent omits their wrapper. The message footer is one coherent, mobile-swipeable line, per-message timestamps are back on your own turns, and the status bar drops the context meter that duplicated the per-message chip. No engine.db migration — rollback to 2.7.0 is a clean image swap.

### Fixed
- **Model picker follows hybrid routing.** In hybrid mode a tier assigned to another provider (e.g. balanced → Mistral Large) now shows that model in the picker and footer, instead of the base provider's default label. (#987)
- **Follow-up pills no longer leak raw JSON.** When the agent emits its "what next" suggestions as a bare trailing array without the wrapper, they render as pills instead of leaking the JSON into the message. (#987)
- **Coherent, swipeable message footer with timestamps.** The per-message stats read as one consistently-separated line that scrolls horizontally on mobile instead of truncating, and per-message timestamps are restored on your own turns. (#987)
- **Status bar drops the duplicate context meter.** The persistent context-window bar is removed; the per-message occupancy chip is now the single source. (#987)
- **Model-switch hint clears after the turn.** The "switching re-processes context" hint disappears once the reprocessed reply finishes, instead of lingering. (#987)

### Internal
- CI now runs security-scan, hex-guard, and web-ui-typecheck as jobs, and enforces the no-AI-attribution rule via a commit-msg hook plus a required check. (#986, #983)

## 2.7.0 — 2026-07-14

This release makes model choice a first-class control and workflows portable, and hardens the paths that carry credentials and money. You can pick the model for a new chat from the composer and set a per-thread execution policy, while the engine enforces your plan's tier ceiling on every path. Workflows gained a versioned export/import format with a re-consent boundary, so a recipe from one instance can be carried to another without silently carrying its secrets or trusted hosts across the trust line. Under that: the workflow run record is durable and honest, in-session workflow spend is now billed, a cluster of LLM-key-isolation fixes closes every path by which a stored key could reach the wrong endpoint, and a saved workflow now needs first-run confirmation before it runs unattended. A guarded outbound-egress policy for agent HTTP tools ships **dormant** (default `allow-all`, no behaviour change). **No engine.db migration** — rollback to 2.6.1 is a clean image swap.

### Added
- **Pick the model for a new chat, right from the composer.** New chats get a model picker that shows real model names and hides providers that only offer a single model, and a per-thread execution policy lets a thread run on the tier you choose. (#958, #960, #964, #975)
- **One-click presets for local runtimes and gateways.** Ollama, LM Studio, vLLM, LocalAI, Groq, Together AI and Fireworks each get their own tile in LLM settings, with the base URL filled in for you. Ollama's and Fireworks' are verified end-to-end: a real agent run drives a full tool call and reads the result back. The others connect, but their tool-calling is not yet proven, and the tile says so — lynox is an agent, and a model that cannot call tools cannot run it. (#941, #965)
- **Portable workflow export and import.** A saved workflow can be exported to a versioned, self-contained format and imported on another instance. Import crosses a re-consent boundary: the secret references and reachable hosts a workflow needs are re-approved on the importing instance, never trusted implicitly from the file. (#955, #959, #974)

### Fixed
- **An API key can no longer be sent to the wrong vendor.** Every OpenAI-compatible endpoint — Mistral, Groq, a local Ollama — looks the same to the engine (`provider: "openai"`), and the key was picked from the provider alone. Selecting one vendor while another's key was stored therefore sent that key, as a bearer token, to the endpoint you selected; a local runtime received it in plaintext over http. Keys are now bound to the endpoint they are sent to.
- **The connection test no longer sends a stored key to an unknown host.** Testing a connection to a free-text endpoint without re-typing a key no longer falls back to a stored key unless the endpoint is a known, vetted host — so a probe can't be used to send a saved credential somewhere it doesn't belong. (#984)
- **The OpenAI adapter no longer drops your images and text.** A message combining text and images sent through an OpenAI-compatible endpoint keeps all of its content instead of silently losing parts of it. (#961)
- **Workflow run history is durable and complete.** Real workflow spend is recorded instead of dropped, nested sub-pipeline runs are tracked (and filtered out of top-level views), step results are written as each step completes, and a run left "running" by a restart is reconciled to "interrupted" on boot. (#974, #977, #978, #979, #980)
- **In-session workflow runs count toward your budget.** A workflow run started from chat now reports its cost the same way other work does, so its spend is billed and counts against the usage cap instead of slipping past it. (#984)
- **Your plan's model-tier ceiling is enforced on every path.** A per-session model override and an agent-selected spawn profile are both clamped to your plan's maximum tier, the agent no longer has a lever to raise its own session tier, and the managed default stays `balanced`. (#954, #957, #982)
- **Saving a workflow preserves its secret references and rejects overly broad hosts.** (#963)
- **Session identity survives an agent rebuild.** (#949)

### Changed
- **If you reached Groq, Together AI or Fireworks through the generic "OpenAI-compatible endpoint" tile, re-enter your API key once.** Those endpoints now have their own tiles and their own key slots, so lynox no longer looks for their key in the slot it shared with Mistral. The engine reports the endpoint as unconfigured until you do, and the settings page shows the field to fix it — nothing is sent with the wrong key in the meantime. Anthropic, Mistral, and any other custom endpoint are unaffected.
- **The dark-theme text ramp is brighter, matching lynox.ai.** A design-token and shape contract now guards these values against drift. (#948, #962, #966-#976)

### Security
- **A saved workflow needs first-run confirmation before it runs unattended.** The library Run button, a scheduled run, and an autonomous run all require a workflow to be confirmed first. A workflow you build yourself is confirmed when you save it; an imported workflow stays inert until you review it, so an imported recipe can't run its steps headless before you've seen them. (#984)

### Notes
- **Guarded agent-egress policy ships dormant.** A per-tenant outbound-egress control for the agent's HTTP tools is present but defaults to `allow-all` — no behaviour change. (#947)
- **Tools are suppressed in the watch-analysis turn.** (#950)

## 2.6.1 — 2026-07-12

A small hardening release. Saving an API integration that sends data to a host outside lynox's vetted list now asks you to confirm out-of-band before it is saved, so a custom endpoint is only ever trusted after a real person approves it — never automatically, and the save fails closed in autonomous/background mode. Separately, the opt-in diagnostic log sinks now have a bounded retention, so enabling them can no longer let a log file grow without limit. Engine-only release; no migration — rollback to 2.6.0 is a clean image swap.

### Fixed
- **Custom API endpoints require your explicit confirmation.** Saving an `api_setup` profile that egresses to a host outside lynox's vetted sub-processor list now prompts you out-of-band to accept controller-responsibility before the profile is saved, and fails closed when no interactive prompt is available. (#945)
- **Opt-in diagnostic logs have bounded retention.** The optional telemetry log sinks now cap their on-disk size, so an enabled sink can no longer grow without limit. (#944)

## 2.6.0 — 2026-07-12

This release lands the first half of a memory-quality rework and hardens the memory foundation 2.5.0 shipped. Memories now record where each fact came from — the channel it arrived on, whether it originated in untrusted content, the embedding model used — and derive a provenance tier from that evidence: the groundwork for trust-aware recall, default-off with no behaviour change. On top of that, several correctness and privacy gaps in the erasure, masking, and compaction paths are closed: a stored memory whose text contains a wildcard character can no longer over-match and remove unrelated memories on delete; a recall-mirror reap that fails now surfaces loudly instead of silently leaving "deleted" content recallable; secrets are masked in the knowledge-graph recall mirror, not just the flat store; and compaction's internal summarizer turns no longer surface as visible thread history. **Additive engine.db migration** (three new nullable/defaulted columns on `memories`) — rollback to 2.5.0 is a clean image swap; the older build simply ignores the added columns.

### Added
- **Memory provenance evidence.** Every stored memory now carries its source channel, an untrusted-origin flag, and the embedding model used, and a provenance tier is derived from that evidence. Default-off groundwork for trust-aware recall — no behaviour change until enabled. (#942)

### Fixed
- **Erasure no longer over-matches or half-completes silently.** A stored memory whose text contains a `%` or `_` can no longer cause a delete/erase to remove unrelated memories, and a knowledge-graph reap that fails during a delete/erase/purge now surfaces instead of leaving "deleted" content recallable. (#943)
- **Secrets are masked in the recall mirror.** The knowledge-graph store — which ambient context injection reads from — now masks secrets the same way the flat store does, so a secret can't be re-injected into context or survive a delete, and the memory HTTP routes refuse content containing secret values. (#943)
- **Compaction internals stay out of thread history.** The summarizer's internal turns no longer persist as visible thread messages, and a resume summary can no longer be overwritten by an internal budget-guard message. (#943)
- **`memory_promote` removes only the promoted line.** Promotion now deletes exactly the matched line and refuses an empty pattern, mirroring `memory_delete`'s protections. (#943)

### Notes
- **Defense-in-depth on tool output.** Output from the workflow runner now passes through the same untrusted-data guard as other tool results, and the pattern scan is bounded so pathological input can't degrade it. (#943)

## 2.5.0 — 2026-07-11

This release makes the agent's long-term memory trustworthy. You can now permanently delete what it remembers; its recall on hosted instances no longer silently loses a new memory or fails to erase a deleted one; and an instance migrated from self-hosting keeps the memories it recalls from. Compaction is hardened — a summary can no longer smuggle a tool result in as a verified fact, and secrets are masked before a summary is stored — and the debug export now carries a privacy-safe snapshot of memory state so recall issues can actually be diagnosed. Groundwork for a larger memory-quality rework ships behind a default-off flag with no behaviour change. **No engine.db migration** — rollback to 2.4.0 is a clean image swap.

### Added
- **Permanent memory deletion (GDPR Art. 17).** Deleting a memory from the UI now physically erases its text and embedding from every store behind a confirmation — not just a soft hide — and reaches document-ingested entries that previously had no delete path at all. The agent's own `memory_delete` stays a recoverable soft-delete for curation, so a stray tool call can never hard-wipe a namespace. (#938)
- **A memory snapshot in the debug export.** The thread debug export now carries knowledge-graph stats and a capped set of active memories with their provenance, plus a sharing notice. Secrets are masked; it is your own data, exported by you. (#940)

### Fixed
- **Hosted recall no longer drifts silently.** On hosted instances that read from the mirrored graph store, a write that failed to mirror (leaving a memory that could never be recalled) and a delete that failed to mirror (leaving one that could never be erased) were both swallowed and reported as success. They now surface loudly, and an erase fails closed rather than half-completing. (#938)
- **Migrated instances keep their recall memory.** The migration export now includes the flat-file memory tree, so a self-hosted → managed transfer no longer arrives with `memory_recall` / `memory_list` empty. (#936)
- **Compaction can't launder a tool result into a verified fact.** The summarizer no longer tags recalled facts as tool-verified, its forgery guard is always on, and secrets are masked before the summary is written. (#940)

### Notes
- **Memory self-reinforcement emergency-stop ships dormant.** The groundwork that stops the retrieval loop from endlessly re-confirming its own recalls is present behind `memory_scoring_v2` (default off) — no behaviour change until a tenant is opted in. (#937)

## 2.4.0 — 2026-07-09

This release cuts what long conversations cost and makes compaction something you can rely on rather than something that happens to you. The summarizer that condenses a long thread now runs on a cheaper model tier by default, which is roughly a four-fold cut in what each compaction costs. The summary it produces is now written down durably, so resuming a compacted thread rebuilds context from that summary plus every message since it, instead of a fixed window of the last 40. The "prepare & compact" offer no longer gets skipped when a single large turn vaults straight past the threshold. And the agent now checks that an integration actually exists before it asks you for that integration's credential. **No engine.db migration** — rollback to 2.3.1 is a clean image swap.

### Changed
- **The compaction summarizer runs on the `fast` tier by default.** Compacting a thread is one internal, tools-suppressed turn; running it on a cheap model cuts that cost about four-fold. The summary becomes a thread's long-term memory once older messages are evicted, so this trades some summary fidelity for cost. Set `compaction_model` (or `LYNOX_COMPACTION_MODEL`) to pin the summarizer to a different tier. (#72)
- **Resuming a compacted thread loads more history.** When a durable summary exists, resume now loads every message recorded since that summary's coverage point, capped at 120, instead of always taking the last 40. Threads without a summary behave exactly as before. (#86, #80a)
- **The context occupancy chip is coloured by cost budget.** Both the chat footer and the persistent status bar keep showing the same honest occupancy percentage; only the colour now reflects how much of the cost budget the thread has consumed, so a large-window model no longer looks green when it is expensive. (#78)

### Added
- **The compaction summary is persisted.** A live mid-session compaction now stores its summary on the thread rather than discarding it, so a later resume builds on that summary instead of re-summarizing from scratch. (#86)
- **The compact offer fires on a leap past the threshold.** A single turn that jumps straight from below the offer point to past the auto-compaction point now still surfaces the "prepare & compact" offer once, rather than silently auto-compacting. (#78a)
- **Credential requests check for the integration first.** Before opening an `ask_secret` prompt for a third-party API credential, the agent verifies the corresponding integration profile exists, so you are no longer asked for a key that nothing is yet wired to consume. Standalone LLM provider keys are unaffected. (#85)
- **An online reachability matrix for lazy tool loading.** `tests/online/lazy-tool-reachability.test.ts` drives a real model against every deferred tool and asserts it is rediscovered and invoked. It runs only with an API key present.

### Notes
- **Lazy tool loading stays opt-in and dormant.** The defer-set was re-curated (#933), but the feature remains off unless `lazy_tools_enabled` is explicitly set to `true`. The new reachability matrix shows a model rediscovers only 9 of 17 deferred tools on the `balanced` tier and none on `fast`, and a tool that is never searched for is invisible with no error — so the default stays off until reachability is green on every tier. No behaviour change for any tenant.

## 2.3.1 — 2026-07-08

A small reliability patch for the chat's live view. If the live connection drops mid-run — a mobile tab going to the background, a proxy idling the stream, a frozen tab — answering an `ask_user` prompt no longer strands you: the client detects the drop, re-attaches to the still-running turn, and streams the continuation live, instead of showing your answer as "not sent" and only recovering after a manual reload-from-history. Plus a "Compact context" entry in the thread menu so you can summarize the conversation on demand to keep context cost down. **No engine.db migration** — rollback to 2.3.0 is a clean image swap.

### Fixed
- **ask_user live-resume** — when the live stream drops while a run is parked on an `ask_user` prompt, the client re-attaches to the run's resumable stream and the answer + continuation appear live, with no reload-from-history needed. (#931)

### Added
- **Manual context compaction** — a "Compact context" entry in the thread menu compacts the loaded conversation on demand, instead of waiting for the automatic prepare-offer. (#931)

## 2.3.0 — 2026-07-08

This release makes hybrid mode reliable end to end and hardens the agent's honesty. Pipeline and workflow steps now follow the hybrid tier-set — a cross-provider slot steers each step's provider, model, and key (fixing a hybrid-mode workflow that could 404). Workflow sub-agents now receive the parent's secret store, so a step's tools resolve vault secrets, and a referenced secret that can't be found is reported plainly instead of sent as a literal or papered over with invented data. The agent grounds recommendations in verified data and never fills an empty tool result with made-up figures. Plus: a run parked on an ask_user prompt no longer aborts at the 30-minute mark, warm browser tabs hard-reload onto the fresh build after a deploy, and the chat footer reads clearer. **No engine.db migration** — rollback to 2.2.0 is a clean image swap.

### Added
- **Ground-first behavior** — before recommending a strategy or plan, the agent gathers and verifies the real data it depends on and shows it as the basis; an empty or failed tool result is reported honestly rather than backfilled with estimates. (#75)

### Fixed
- **Hybrid pipeline/workflow routing** — pipeline and workflow steps follow the hybrid tier-set instead of silently running on the base provider (or 404-ing on a model/endpoint mismatch). (#65/#66)
- **Workflow sub-agent secrets** — a workflow sub-agent's tools resolve `secret:NAME` vault references, and an unresolved secret fails loudly instead of being sent as a literal. (#79)
- **Legacy key scope** — the legacy `config.api_key` fallback is scoped to an Anthropic base, so a non-Anthropic tenant's key is never used for an Anthropic slot. (#81)
- **ask_user wall-clock** — the run wall-clock pauses while a run is parked on a prompt, so answering after the 30-minute mark continues the run instead of aborting it. (#77)
- **Stale bundle recovery** — warm browser tabs hard-reload onto the freshly deployed build; Mermaid diagram chunk-load failures recover instead of rendering a syntax error. (#73)
- **Clearer chat footer** — per-turn token totals and context occupancy are co-located and labeled. (#74)
- **Private-mode toggle** — the header private-mode control uses a ghost icon and an explicit on/off label. (#76)
- **Context-cost** — repeated large tool-result payloads are de-duplicated in the resident context. (#72)

## 2.2.0 — 2026-07-07

Pick the model your main chat runs on. A new **main-chat model picker** in LLM settings lets you choose the band (fast / balanced / deep) — and its concrete model — for the primary conversation, clamped to your plan's ceiling. Under the hood, **hybrid sub-agents** can now run on a different provider than the main agent (a Mistral main can delegate to an Anthropic sub-agent, and vice-versa), each tier resolving to its own provider, model, and key. An opt-in **lazy tool-loading** mode (`lazy_tools_enabled`, default off, Anthropic-direct only) defers heavy tool schemas behind the native tool-search tool to shrink the cached prompt prefix. The rest is correctness: agent-opened escalation threads resume instead of erroring, failed and cross-provider sub-agents surface real errors instead of completing silently, and the chat's context/compaction UI got an honesty pass. **No engine.db migration** — rollback to 2.1.1 is a clean image swap.

### Added
- **Main-chat model picker (standard mode)** — choose the band and model your main conversation runs on, from LLM settings. Options come from the provider catalog (so every provider's models appear) and are clamped to your plan's ceiling; the Anthropic balanced band splits into its served-Sonnet variants (4.6 / 5). (#924)
- **Hybrid cross-provider sub-agents** — sub-agents may run on a different provider than the main agent, each tier resolving to its own provider, model, and key. (#924)
- **Lazy tool-loading (opt-in)** — `lazy_tools_enabled` (default off, Anthropic-direct only) defers heavy/long-tail tool schemas behind the native tool-search tool to shrink the cached prompt prefix; every tool stays reachable on demand. (#923)

### Fixed
- **Escalation threads resume** — an agent-opened escalation thread (`escalation-*`) can be reopened instead of erroring. (#922)
- **Hybrid sub-agent routing & error surfacing** — a hybrid base-fallback sub-agent now routes to its own tier (previously it could pair a tier's model with the wrong provider's endpoint and 404 silently); failed and hybrid sub-agents record a structured error and are marked failed instead of completing silently. (#925)
- **API-shape fails loud** — when a `response_shape.include` matches no fields, the tool reports the real top-level shape instead of returning an empty result that looked like success. (#925)
- **Honest context UI** — the compaction banner drops the misleading percentage, and a completed message keeps its usage line visible while a later reply streams. (#926)
- **Grounding** — the agent reasons from a verified fact that contradicts an assumption instead of quietly proceeding on the assumption. (#925)

## 2.1.1 — 2026-07-07

Fixes the knowledge-graph view on instances with the subject-graph enabled: the graph now renders the connected relationship subgraph (it previously showed a disconnected ring of the most-recently-touched entities), and entity mention counts reflect the real number of linked memories instead of always showing zero. No migration; rollback to 2.1.0 is a clean image swap.

### Fixed
- **Knowledge-graph view:** serve the connected subgraph (`GET /api/kg/graph` — the recent relationships plus exactly the subjects they touch) so relationships render as edges, and populate the real memory-link mention count. (#920)

## 2.1.0 — 2026-07-07

Claude **Sonnet 5** joins as an opt-in model for the balanced tier — pick it from a new in-settings variant picker, with the extended (1M-token) context window surfaced where the tier allows. Alongside it, the flag-gated subject-graph memory gains a **person-dedup** capability: when two entries turn out to be the same real person ("Ada" and "Dr. Ada Lovelace"), a new `subjects_merge` chat tool folds one into the other — confirmed, reversible, and never run unattended — and a background garbage-sweep archives extraction junk. The bulk of this release is a **correctness + data-safety hardening wave** on the memory subsystem and the boot/migration path. The subject-graph write path **stays flag-gated off** (`subject_graph_enabled`), and the read path is additionally gated (`memory_graph_reads`) — the per-tenant data cutover remains a separate step. **No control-plane database migration**; the engine applies two additive `engine.db` migrations (v6, v7 — nullable columns) on boot — rollback to 2.0.0 is a clean single-image swap (the added columns are inert on the older engine). One rollback caveat: if you set a Sonnet-5 balanced model, strip `balanced_model` from `config.json` before downgrading (or set it via the `LYNOX_BALANCED_MODEL` env, which never touches the config file) — the older engine's strict config parser otherwise ignores the whole file.

**⚠️ Self-hosted operational change.** Client-IP resolution no longer trusts `X-Forwarded-For` by default (previously the leftmost, spoofable entry). If you run behind a reverse proxy and rely on per-client rate-limiting or the IP allowlist, set `LYNOX_TRUST_PROXY=true` (and `LYNOX_TRUSTED_PROXY_HOPS=<n>` if you chain proxies) — otherwise all clients now resolve to the proxy's address. Managed instances are unaffected (the platform sets this).

### Added
- **Claude Sonnet 5 as an opt-in balanced-tier model**, selectable from a new variant picker in LLM settings, with the extended (1M-token) context window surfaced where the tier allows. Existing balanced-tier behaviour is unchanged until you pick it. (#907, #910)
- **`subjects_merge` chat tool** — fold a duplicate person entry into the canonical one (moving every note, task, and mention onto it) from chat. Always confirmed, reversible from the merge ledger, and refused in unattended/autonomous runs. (#906, #908, #909, #915)
- **Subject garbage-sweep** — a background archive phase that clears extraction junk (acronym/lowercase non-people) out of the subject graph, with an archived-recall guard so cleaned entries don't resurface. (#903, #905)
- **Agent-scheduled agent runs require human confirmation** — a trigger whose effect is to start another agent run now asks for explicit confirmation before firing. (#888)

### Fixed
- **Boot data-safety:** a database migration *error* is no longer mistaken for *corruption* — the engine fails loud and keeps the file instead of wiping it, across the engine, run-history, and agent-memory stores. (#911)
- **Memory edits stay consistent:** editing a memory in the UI now mirrors to the subject-graph store under the write flag (previously gated on the read flag), and UI memory mutations route through a single doc↔knowledge-graph sync facade. (#904, #912)
- **Person-dedup correctness:** the merge repoints the live thread anchor and applies the redirect atomically, the resolver treats name *shape* as identity (so "Ada Jr." and "Ada Sr." are never folded together, and a title-only match isn't a false duplicate), and cross-currency values are no longer stitched into one. (#913, #914)
- **Subject-graph write path (flag-gated):** engagement subjects converge through a single (name, parent) resolver; consolidation and deactivation mirror to `engine.db`; a contradiction supersede can't cross subjects and lose data; currency/qualified value changes are flagged as contradictions. (#891, #892, #893, #894, #895)

### Hardened / Internal
- CI actions + build dependencies are **pinned to commit SHAs**, and client-IP derivation is hardened against forwarded-header spoofing. (#889)
- The per-turn memory auto-extraction is metered through the managed billing gate (previously it spent unmetered on managed). (#917)
- The `subjects_merge` consent prompt strips the full set of invisible format characters before display. (#918)
- A gold-corpus recall-quality harness (real ONNX embeddings) and expanded migration-path test coverage. (#890, #896)

## 2.0.0 — 2026-07-06

Foundation Rework v2 goes active for the verb layer. Workflow, trigger, and task **definitions** now live in the consolidated per-tenant `engine.db` with a first-class **source/effect** model (a trigger's *when* and *what* are separate axes) and a **Connection** primitive over API profiles. The legacy `triggers` table and planned/executed workflow rows in `history.db` are retired from the read+write path. **On upgrade, every engine self-heals at boot**: it migrates your existing triggers, saved workflows, and tasks from the legacy stores into `engine.db` exactly once (no operator action, no data loss), leaving the legacy rows dormant as a rollback net. Alongside the verb cut: project/customer **context-scoping** (memories seat on a thread's subject anchor and recall walks the subject hierarchy), the memory-consolidation lifecycle moves onto the subject graph, a read-only **Subjects** surface, and a broad correctness + billing + security hardening wave. The subject-graph **read path stays flag-gated off** (`subject_graph_enabled`) — the per-tenant data cutover remains a separate step.

**⚠️ Breaking / migration.**
- **Verb-layer store cut (`history.db` v44).** Trigger/workflow/task definitions are read from and written to `engine.db`. The boot self-heal backfills legacy definitions the first time a 2.0.0 engine starts; v44 is **non-destructive** (legacy rows are kept dormant, not dropped — a later release drops them once the fleet is confirmed migrated).
- **Rollback is NOT a plain image-swap for this release.** A `engine.db`/`history.db` that has run the 2.0.0 migrations will not cleanly downgrade to a pre-2.0.0 image — roll back via a **cold-snapshot restore** of the tenant volume (rehearsed), not an image revert.
- **`llm_mode` / eu-sovereign routing retired** (control-plane migration `0034_drop_llm_mode`; apply after confirming zero eu-sovereign rows). The provider-agnostic routing model (provider + per-tier Tier-Set) is authoritative.
- **Env / tier ABI renames** across the engine and the CP-emitted tenant env — a version-only rollout does not re-sync tenant env; the deploy runs a fleet `sync-env`.

### Added
- **Verb layer on `engine.db` with a source/effect model.** Triggers split their legacy `task_type` into an explicit **source** (`cron` · `watch` · `manual`) and **effect** (`run_agent` · `run_workflow` · `notify` · `backup`) axis; workflows and tasks resolve their assignee through the subject graph. (#835, #836, #838, #843, #850, #852)
- **Connection primitive** over API profiles — a reusable connection a workflow/trigger plugs into. (S4b, #853)
- **Project/customer context-scoping.** A thread carries a subject **anchor**; memories written in-thread inherit it, and recall weights results by walking the subject hierarchy up from the active anchor. New `set_thread_context` agent tool. (#868, #869, #870, #871)
- **Read-only Subjects surface** — an on-demand subject footprint (records + threads timeline, adjacent memories/tasks) in the Intelligence hub, flag-gated. (#875, #876)
- **Memory-consolidation lifecycle on the subject graph** — recall, write-path dedup/contradiction, entity cutover, and the consolidation lifecycle move onto `engine.db` (flag-gated), with metrics recorded to history. (#857, #858, #865, #866, #867)
- **`media_process` tool** — a constrained ffmpeg builtin (transcode, extract-audio, thumbnail, probe) with array-arg exec, closed operation/format enums, a protocol whitelist, and hard time/size caps. (#887)

### Fixed
- **Upgrade data-safety:** engines self-heal legacy trigger/workflow/task definitions into `engine.db` on first 2.0.0 boot — exactly once, no resurrection, non-destructive. (#879)
- **Billing accuracy:** every managed pool-key spend path fires the credit gate + debit (#833); failed-run cost is counted in spend aggregates (#837); managed billing charges exact whole cents with a sub-cent carry (#855); the inbox classifier is priced per region (Mistral vs Haiku) (#864); the budget stack fails closed on non-finite pricing (#863); out-of-turn helper LLM calls (spawn children, STT byte-fallback, workflow capture) also debit the tenant balance (#885).
- **Run lifecycle:** interrupted/aborted runs are recorded distinctly instead of silently completed, surfacing a `run_interrupted` state rather than an empty turn. (#880)
- **Context estimator:** the compaction occupancy estimate is image-aware and preserves recent images across compaction. (#882)
- **Config persistence:** tier/profile fields persist across reloads. (#883)
- **Web UI:** message timestamps, queued-send drain after a run, artifact-card fallback, and artifact-id idempotency; SVG uploads rasterise client-side. (#886)
- **Mail:** prevent inbound-mail loss and duplicate scheduled sends. (#846)
- **Consent:** storing a secret via `SecretStore.set()` records consent. (#860)
- **Knowledge graph:** stop entity/relation garbage inflow at the extractor. (#832)

### Hardened
- Vault key lifecycle is crash- and corruption-safe (#839); background task cost + schedule intervals are bounded (#854); relative filesystem paths are confined to the workspace outside isolation mode (#851, #845); `api_setup` custom endpoints are gated through the sub-processor allowlist for OAuth token URLs and persisted for runtime egress (#848, #849); the bash guard scans the whole command for danger patterns (#862); whisper tmp paths sanitize the user filename (#861); Google Docs append is gated behind the destructive prompt (#859); managed import re-gates custom endpoints (#856); plus egress/consent/content-scan guards (#841, #842, #844). Vault restore is an atomic stage-and-swap with a receive-side chunk-size cap (#881); record lookups escape the LIKE prefix and workflow confirmations reset on any edit (#884); aggregate query aliases are validated against a column allowlist (#883).

### Managed hosting
- **EU right-of-withdrawal** button (Widerrufsbutton) for consumer checkout. (pro #347)
- **Per-tenant subject / memory-graph flags** emitted from the control plane, enabling the staged subject-graph cutover. (pro #349)
- **Checkout provisioning is idempotent on replay** — a duplicated Stripe event no longer double-provisions. (pro #350)
- Provisioning **reconciler for orphans + capacity drift**, a daily DNS-takeover scan, a fleet-wide spend tripwire, and root-cause fixes for provisioning/DNS leaks. (pro #337, #339, #340, #341, #345)
- Renewal **credit-grant netting** corrected with a row lock; the credit-ledger balance invariant restored. (pro #348, #329)

### Internal
- The verb-layer landed as a mirror-then-cut sequence (S3a–S3f: mirror definitions to `engine.db`, backfill legacy, then cut reads/writes over) so each step shipped dormant before the cut. (#835–#843)

## 1.22.0 — 2026-06-30

Foundation Rework v2 lands as dormant infrastructure: a new consolidated per-tenant `engine.db` subject-graph store (subjects · people · organizations · memories · relationships · artifacts · the workflow/trigger/task verb layer), wired behind the `subject_graph_enabled` flag which ships **off**. The legacy agent-memory path stays authoritative until a separate per-tenant data cutover, so this release is behaviourally inert on existing instances. Alongside it: a configurable outbound network policy, customer-route auth scoping, GDPR engine.db erasure + paginated export, a managed credit gate on voice, and cross-origin credential-replay hardening. **No control-plane database migration**; the engine creates the additive `engine.db` on boot (idempotent) — rollback to 1.21.0 is a clean single-image swap (the new DB is simply orphaned).

### Added
- **Foundation Rework v2 — the engine.db subject-graph store (flag-gated off).** A new consolidated per-tenant `engine.db` holds the subject graph (people, organizations, engagements, products, services), memories, relationships, connections, artifacts, and the workflow/trigger/task verb layer. The legacy knowledge layer additively mirrors into it, a flag-gated read path can serve from it, and an operator-run `s2-backfill` CLI re-maps existing agent-memory + CRM data. All behind `subject_graph_enabled` (env `LYNOX_SUBJECT_GRAPH_ENABLED`), default off — existing instances stay on the legacy path until a per-tenant cutover. (#821, #822, #823, #826)
- **Configurable outbound network policy.** `network_policy` (`allow-all` default · `deny-all` · `allow-list` with `network_allowed_hosts`), with env overrides `LYNOX_NETWORK_POLICY` / `LYNOX_NETWORK_ALLOWED_HOSTS`, gating the agent's `http_request`, `api_setup`, and `web_research` egress. The default `allow-all` preserves existing behaviour. (#824)

### Fixed
- **GDPR:** erasure now wipes the engine.db PII alongside the legacy stores, and the data export paginates entities so large datasets export completely. (#825)
- **Backups** now include inbox/mail state (`mail-state.db`), the engine.db subject-graph store, and web-push subscriptions. (#821)
- Customer-facing engine routes are scoped to the user tier; infra-only secrets, vault-key reveal, and the auth token stay admin-gated on managed instances. (#828)
- Data-lifecycle operations (export / erasure / migration) route through the control plane on managed instances. (#815)
- Voice TTS/STT routes enforce the managed credit gate. (#816)
- Credential headers are stripped — and request bodies dropped — on cross-origin redirects, so an open redirect cannot replay an Authorization header or a secret-bearing request body off-origin. (#819, #829)
- The workspace file-list route is confined to the workspace with the same realpath check as read / download / delete. (#829)
- **Web UI:** screen-reader semantics for toasts, the command palette, and inputs (#817); the interrupted-run banner now clears when starting a new chat (#814).

### Internal
- Tidy the two-tier-auth + managed-deny doc comments (#827); document the engine.db subject-graph, the network policy, and the backup scope (#829).

## 1.21.0 — 2026-06-29

Connect a mailbox from chat. A new agent flow resolves a known provider's servers and hands off to an in-chat consent step where you enter the app password — the password goes straight from the browser to the vault and never enters the agent context, run history, the SSE stream, or the prompt store; the agent only learns whether the connection succeeded. Plus chat-render robustness and agent-surface secret hardening. **No control-plane database migration**; the engine adds one additive per-tenant history-DB migration (v43, pending-prompts) applied on boot — rollback to 1.20.0 is a clean single-image swap.

### Added
- **Connect a mailbox from chat via a secure consent step.** A new `mail_connect` agent tool resolves a known provider's IMAP/SMTP servers (Gmail, iCloud, Fastmail, Yahoo, Outlook) and opens an in-chat `connect_mail` consent prompt where you enter the app password. The password posts straight from the browser to the vault — it never enters the agent context, run history, the SSE stream, or the prompt store; the agent only learns whether the connection succeeded. Custom or uncommon hosts stay in Settings → Mail. (#808)

### Fixed
- Inline chat artifact **fullscreen** now covers the full viewport instead of a narrow strip. (#811)
- A stored plan with a malformed `phases` shape no longer crashes the thread on open; it degrades to an empty phase list. (#812)

### Security
- Keep **infrastructure/engine-internal secrets off the agent surface** — excluded from the session briefing and left unresolved in tool input. (#806)
- **Reject mail account ids that collide** on the derived credential-vault key, so one account cannot resolve another's stored credential. (#807)
- Render the connect-mail consent help link only for `https://` URLs — defense-in-depth on the new consent UI. (#813)

## 1.20.0 — 2026-06-29

Documents become readable. A PDF or Word file dropped into chat is now text-extracted server-side and read by the agent instead of being rejected, and the extracted text persists into the knowledge layer so the document is auto-recalled in later turns and threads. The Wissen header gains a glanceable memories / entities / relations summary, scrollable tab rows fade at the edge to signal more content, and editing an artifact now re-renders its card in chat. **No engine or control-plane database migration** — uploaded documents ride the existing per-tenant knowledge layer; rollback to 1.19.0 is a clean single-image swap.

### Added

- **Read PDF and Word uploads** — a `.pdf` or `.docx` dropped into chat is text-extracted server-side and read by the agent instead of being rejected. Corrupt, encrypted, or scanned image-only files return a clear error; unsupported binaries (`.xlsx` / `.pptx` / legacy `.doc`) keep an updated "paste the text" message. (#801)
- **Uploaded documents are remembered** — an uploaded document's text persists into the knowledge layer and is auto-recalled in later turns and threads, the same way the agent's own memories are. (#803)
- **Wissen header summary** — the knowledge view shows a glanceable memories / entities / relations count. (#798)
- **Scroll affordance + larger mobile touch targets** — scrollable tab rows fade at the edge to signal more content, and small mobile chrome meets the 44px minimum touch-target size. (#800)

### Fixed

- Editing an artifact re-renders its updated card in chat instead of showing only the update text. (#802)
- **Engine hardening (upload + watch surface)** — uploaded PDF/Word extraction is bounded against decompression bombs (peak memory capped) and wrapped in a timeout so a malformed file can't hang a request; and exotic line-separator characters (NEL / U+2028 / U+2029 / C1) are stripped from untrusted inputs framed to the model — the uploaded filename, the extracted document body, and a watch's fetched page text — extending the chat-input hardening already in place. (#796, #804)

### Internal

- Shared `keepSettingsItem` tier-gate predicate extracted; pipeline-running derivation guarded against malformed shapes. (#797, #799)

## 1.19.0 — 2026-06-26

The product's navigation becomes the agent loop. Agent-triggers get an editable home, the workflow run-list joins a single "Aktivität & Kosten" surface, and low-frequency configuration (API profiles, third-party keys, tool permissions) moves into Settings — so each surface maps to a primitive instead of a feature. Watch change-detection gets dramatically cheaper, and a wave of UX fixes lands across chat, artifacts, the inbox, and the navigation rail. **No engine or control-plane database migration** — the run-now endpoint uses the existing per-tenant `triggers` table (shipped in 1.18.0); rollback to 1.18.0 is a clean single-image swap.

### Added

- **Triggers get an editable home** — an Automation "Triggers" tab lists agent-triggers (cron / watch / pipeline / reminder) with pause, delete, and **run-now**; creating or editing one is done by talking to the agent. A new `POST /api/triggers/:id/run` runs a trigger on demand (it routes through the same dispatch as the scheduler, so the capability-contract consent gate still applies). (#787)
- **Aktivität & Kosten** — the full workflow run-list (per-run cost, status, and the "Fixen" failed-run flow) moves into the Activity surface alongside spend and history. (#788, #789)
- **"Open in chat" actions** on tasks, contacts, and API profiles — create or edit them by chatting with the agent instead of through a bespoke form. (#786)

### Changed

- **Information-architecture reorg — the nav maps to the agent loop.** Automation is now Workflows (the saved-workflow library) / Triggers / Tasks; the workflow *run-list* lives under Aktivität & Kosten. API profiles and third-party API keys move into Settings. Tool permissions unify from two tier-split pages into one all-tier Settings entry. Every legacy URL 301-redirects, so existing bookmarks keep working: `?section=apis|keys` → Settings; `/settings/{workspace,privacy,integrations}/tools` → `/settings/policy-tools`; `?section=library` → the Workflows tab; `?section=reminders` → Triggers. (#788, #789, #790, #791, #792)
- **Cheaper watch change-detection** — a watch now hashes the page's cleaned visible content (not the raw HTML, which churned on every nonce / CSP-token / build-id change), runs its change-summary on the fast model tier, and passes the already-fetched content inline instead of re-fetching. A watch created before this update re-baselines once on its first run (no migration). (#781)

### Fixed

- Chat lands at the bottom of the thread on open and holds position during streaming. (#782)
- A fullscreen inline artifact shows the whole document instead of a clipped strip. (#783)
- The inbox reading pane is no longer crushed at tablet widths. (#784)
- The hover-expand navigation rail is an overlay flyover (no content reflow) and gains a keyboard-focus path. (#785)
- The "open in chat" buttons use a monochrome chat icon, consistent with the rest of the UI. (#793)
- Inbox "reply in chat" sanitizes the externally-authored mail subject before it seeds the chat framing, matching the other "open in chat" surfaces (which all collapse whitespace and control characters in untrusted fields). (#794)

## 1.18.0 — 2026-06-25

The inbox becomes chat-first and contacts get a first-class identity. Replying to or composing a mail now opens a chat with the message loaded as context — the bespoke draft composer is gone, and the agent answers through its tools. Saved correspondents become real contacts keyed on email, and the task model splits into user-TODOs and agent-triggers. Two per-tenant engine migrations run on boot (mail-state v16 retires the draft table; run-history v42 splits `tasks` into `tasks` + `triggers`); both drop columns, so they are **forward-only** — roll the engine image forward, not back, past this release. No control-plane database migration.

### Added

- **Reply and compose mail in chat** — an inbox mail opens a chat with the message as context; the agent replies through `mail_reply`. The standalone reply/compose composer is removed. (#774, #775)
- **Bulk-escalate** several selected inbox mails into a single chat thread. (#777)
- **Contacts** — `contacts_save` and `contacts_search` agent tools over a CRM keyed on email identity (case-insensitive; saving the same email updates the contact instead of duplicating it). (#778)
- **Agent-triggers as a distinct primitive** — the `tasks` table splits into user-TODOs (`tasks`) and agent-triggers (`triggers`, fired by the worker loop); a new `GET /api/triggers` lists them. (#773)
- **Self-signed TLS opt-in** — `LYNOX_MAIL_INSECURE_TLS=1` lets an operator connect IMAP/SMTP servers that present self-signed certificates (default off; certificate validation stays on otherwise). (#777)

### Changed

- A mail you answer in chat is reconciled back to the inbox as `replied`, with a thread-key fallback when the message carries no Message-ID. (#774, #777)
- CRM contact identity is keyed on email (lower-cased); a pre-existing name-keyed contact store keeps working and logs a one-time boot warning instead of silently changing dedup behaviour. (#778)
- The inbox `draft_ready` zone is relabelled and the stale draft-era copy retired. (#777)

### Removed

- The autonomous inbox draft backend and its endpoints (`/api/inbox/.../draft`, `/draft/generate`, `/drafts/:id/send`, `/compose-send`) — replying moved into chat. (#776)

## 1.17.0 — 2026-06-24

Saved workflows become a product surface: schedule one on a cron, get pulled into an unread chat thread when a run needs you, and edit or fix a workflow by chatting with the agent — on top of a hardened headless-run foundation (explicit autonomy, run-context threading, full observability, and the fail-closed capability-contract machinery). No control-plane database migration; the engine adds three additive per-tenant migrations (v39 cron params + kill-switch, v40 thread unread-state, v41 run→workflow link), run on boot.

### Added

- **Schedule a saved workflow on a cron** from the product — bound parameter values are stored with the schedule (a cron run can't prompt), gated behind a capability-contract consent step, with a per-schedule kill-switch. (#766)
- **Agent→User escalation** — a failed run or a watcher finding now opens (or bumps) an unread chat thread carrying the full context, instead of failing silently; a push just points at it. (#767)
- **Edit a saved workflow's steps via chat** — a "Bearbeiten" action opens a chat with the workflow loaded; the agent rewrites and re-saves steps through `update_workflow_steps`. No bespoke step-editor. (#768)
- **Diagnose and fix a failed run via chat** — a "Fixen" action opens a chat with the run loaded; `diagnose_workflow_run` explains the per-step failure, you fix and re-run by talking to the agent. (#769)
- **Deterministic replay** of a captured tool call with re-targeted `{{params.x}}` values. (#762)

### Changed

- Headless workflow runs now carry explicit autonomy + a complete run-context, record per-step execution with audit / error / cost surfacing and a tenant-isolation invariant, and enforce fail-closed capability contracts (host/path/method pins, per-param constraints, DoS wall-clock/iteration bounds, kill-switch) — the safe foundation under the features above. Without a contract a headless run does no outbound writes (the conservative safe-deny default). (#763, #764, #765, #771)

### Fixed

- An exploratory-capture quality eval (rubric + offline gate + online smoke) guards that capturing a workflow from a free-form session keeps producing a re-executable, correctly-parameterised workflow. (#770)

## 1.16.0 — 2026-06-22

Engine context-cost tooling and a comprehensive thread debug-export, a memory-recall stability fix, and the managed credit-pack and usage-display fixes. No control-plane database migration; engine adds additive per-tenant history-DB migrations (run on boot).

### Added

- Comprehensive thread debug-export — `GET /api/threads/:id/debug-export` bundles the thread, messages, and per-run cost / tokens / cache / context-composition plus compaction events (secrets scrubbed); an "Export thread JSON" control in the web UI. (#757, #758)
- Cost-aware compaction: long threads auto-summarize against an absolute token budget (`compaction_token_budget`, default 150K) to bound large-context cache-read cost; recall LRU cap raised 64→128. (#754)
- Context-cost composition probe with opt-in per-turn logging (`context_cost_log`, also settable by managed users) and a baseline harness. (#750, #753)
- Managed: grant `$0`-coupon (100%-off) credit packs and surface purchased packs in the budget display. (pro #304, #305)

### Fixed

- Embedding: cap the embed input length so a large task can no longer push the transformer's O(seq_len²) attention into a memory blowup that hangs the engine on memory-constrained instances. (#759)
- Bump nodemailer 8.0.11 → 9.0.1 (GHSA-p6gq-j5cr-w38f). (#755)
- Usage dashboard budget now sized against included + top-up credits. (#747)
- Managed: resolve the control-plane base URL by environment across the checkout/account pages. (pro #306)

## 1.15.0 — 2026-06-17

Provider-agnostic model routing: each tier (fast/balanced/deep) can run on its own provider and model — in a Standard mode (one provider for all tiers) or an opt-in Hybrid mode (per-tier, freely cross-provider, e.g. a Mistral `fast` tier alongside an Anthropic `deep` tier). Built on a new provider registry; no engine or control-plane database migration.

### Added

- **Provider-agnostic routing with a Standard/Hybrid mode.** Tier resolution and LLM-client dispatch now flow through a provider registry, so each tier resolves to its own provider + model. Standard mode keeps one provider for every tier (byte-identical to before); Hybrid mode assigns each tier its own provider+model, freely mixing providers. (#730, #743, #739)
- **Per-tier Tier-Set editor in LLM settings** with a Standard ↔ Hybrid toggle and a model picker per tier. No capability gating — every allowed-provider model is selectable on every tier; the included budget controls spend, not a tier band (D8). Managed tenants stay on the curated Anthropic + Mistral allowlist with control-plane-supplied keys. (#739)
- **Manual session rename in the chat header**, plus automatic fast-tier thread titles. (#729)

### Fixed

- **Hybrid routing applies on the main chat path.** A chat tier assigned to a cross-provider slot (e.g. Mistral) now reaches that provider instead of dispatching to the base provider — previously only the fast-tier background utilities switched providers. (#745)
- **Billing settings** gate the upgrade CTA correctly and add a budget top-up path. (#740)

### Changed

- **Managed model ceiling lifted to deep.** Under no-capability-gating (D8) the included budget caps spend rather than a tier band, so managed (and managed-pro) tenants can reach the deep tier. (pro #301)
- **Canonical tier environment names + fail-closed env-preview redaction** on the control plane, pinned to the engine via the env-ABI contract. (pro #296, #297)
- **Honest, mechanism-first product copy** across the README, docs, and website — leads with what the agent does, not a feature checklist. (#744, pro #302)

### Docs & Internal

- Credit-pack currency → CHF with VAT-ID collection. (pro #300)
- Cleared OSV advisories blocking CI (vite, protobufjs, and transitive bumps); removed a vestigial config-generator preview page; corrected stale post-D8 config comments. (#741, #746, pro #298)

## 1.14.0 — 2026-06-16

An environment-ABI and provider refactor: Mistral becomes a first-class provider (EU-sovereign mode retired), engine env vars move to canonical names with permanent legacy aliases, and Managed-Pro's model ceiling is lifted to Opus for deep work. No engine database migration; one destructive control-plane migration (0034).

### Changed

- **EU-sovereign mode retired — Mistral is a first-class provider.** The engine no longer reads an `llm_mode` toggle; it promotes the Mistral API key into the active provider when the selected provider is a Mistral endpoint (provider + endpoint, not a mode flag). Anthropic and Mistral are freely switchable in LLM settings. (core #722, pro #288)
- **Engine environment variables renamed to canonical names; legacy names accepted forever.** A running instance's existing `.env` keeps working (dual-read): `ANTHROPIC_BASE_URL`→`LYNOX_API_BASE_URL`, `LYNOX_MAX_TIER`→`LYNOX_MAX_MODEL_TIER`, `LYNOX_DEFAULT_TIER`→`LYNOX_DEFAULT_MODEL_TIER`, `LYNOX_MANAGED_MODE`→`LYNOX_BILLING_TIER`, `LYNOX_DIR`→`LYNOX_DATA_DIR`. (core #725, #726)
- **Managed-Pro can reach Opus for deep work.** The control plane lifts the Managed-Pro model ceiling to Opus; deep tasks (spawns, deep step-hints, pipeline steps) resolve to Opus while everyday chat stays on the cost-sane balanced tier. (pro #284)

### Fixed

- **Model-tier resolution flows through one gate→clamp→provider chokepoint.** Closes two gaps: a Pro tenant under a lower cost ceiling could reach the deep/Opus model past its cap, and a demo instance under a Managed-Pro customer inherited `account_tier=pro`. Resolution is now consistent across the session, spawn, and pipeline paths. (core #721, #720)

### Control plane

- **Managed-hosting schema cleanup** removes a now-unused provider-mode column the engine no longer reads (migration `0034`). (pro #288)
- **CP-to-engine env-ABI contract manifest + tests** pin the names the control plane emits to the names the engine reads, so a tier/env var can't silently drift between the two repos; tier policy is emitted from one table with canonical wire values. (pro #285, #286)

### Docs & Internal

- Dependency/audit bumps: esbuild, qs, vite 7.3.5, brace-expansion (ReDoS), nodemailer/js-yaml/otel-core. (core #723, pro #287, #291, #293, #294)
- Docs site → Astro 6 + Starlight 0.40; landing site → Astro 6. (core #728, pro #292)

## 1.13.0 — 2026-06-12

Managed-Pro accounts now run on Opus and managed background work routes to Mistral — the headline of an env-ABI fix wave — alongside a forensic-driven batch of cost, context, and UX hardening across the engine and control plane.

### Added

- **Free-text answers on tabbed questions** — a tabbed `ask_user` prompt now also accepts a typed free-form answer per question, so you never break the flow when no option fits. (#714)

### Changed

- **Managed-Pro runs Opus; managed background tasks run Mistral** — the control plane now emits the account tier and worker/model profiles under the names the engine actually reads, so a Managed-Pro instance gets Opus for deep work and routes background/bulk tasks to the cheaper Mistral profile instead of silently staying on Sonnet/Anthropic. (#280, #710)
- **Binary document uploads are rejected, not garbled** — a `.docx` / `.pdf` / `.doc` upload now returns a clear 415 instead of inlining unreadable bytes as text. (#716)
- **Monthly spend cap is a calendar month** — the monthly cost cap resets on the 1st of the month rather than on a rolling 31-day window. (#712)
- **Large HTTP JSON responses are auto-capped** — the `http` tool shapes and caps oversized JSON API responses (up to a 2 MB read ceiling) and strips noise headers, instead of blowing the context window or truncating mid-JSON. (#713)

### Fixed

- **Three engine crash / data-integrity bugs**, plus the per-tenant `agent-memory.db` migration applier is now transactional — a crash between version-stamp and DDL can no longer brick the database. (#711)
- **Cache-write pricing aligned to the 1-hour cache TTL** the agent actually sends, correcting managed cost reporting. (#709)
- **Artifact preview and list refresh** after an artifact is edited (no more stale preview). (#715)
- **Stronger "thinking" animation** on the agent presence icon, plus a universal artifact-activity label. (#718)
- **Grounding discipline** — the agent states a metric or a tailored recommendation only from data it actually fetched, never an estimate or a generic playbook presented as case-specific data. (#717)
- **No empty-submit filler turns** after a text-less tool call (Anthropic path). (#719)

### Control plane

- **Credit accounting invariants hardened** — credit-pack purchases are now transactional with a unique payment-intent index (no double-credit on a retried webhook); migration `0033_credit_pack_unique_pi`. (#279)
- **Provisioning saga hardened** against orphaned VMs, dangling DNS records, and cap races. (#282)
- **Secret hygiene** — the admin env-preview redacts the pooled LLM key (including inside the model-profiles JSON), emits the account tier, and drops a phantom env var. (#280)

## 1.12.0 — 2026-06-09

Provenance lifecycle lands as a first-class data property, alongside a wave of correctness, billing-integrity, and security fixes across the engine and the managed control plane.

### Added

- **Provenance lifecycle** — every recalled fact now carries an un-spoofable structural `<fact kind="…">` marker for its origin (user-asserted / tool-verified / agent-inferred / external-unverified), captured at the source and threaded through recall, sub-agent grounding, and compaction. Engine `agent-memory.db` migrates v3→v4→v5 per tenant on boot. (#700)

### Changed

- Removed the dead behavioural pattern-engine — its output never reached the agent (confidence below the consumer threshold); KPI metrics are unchanged. (#699)

### Fixed

- **Managed billing — saved & scheduled workflows now count against the budget.** Saved-workflow and scheduled-pipeline runs bypassed the daily/monthly cap, the managed credit gate, and cost reporting, so on managed tiers they could run uncapped and unbilled. They now flow through the same budget + credit lifecycle as an interactive turn: the cost decrements the tenant's balance and an exhausted-budget tenant is blocked. (#706)
- **Auto-memory + search reranker now work on Mistral / OpenAI-compatible tenants** — secondary LLM call sites (memory extraction, reranker, dag-planner) were keyed to the wrong provider slot and silently failed with a 401 on non-Anthropic tenants. (#703)
- Old or deleted threads return `200` with an empty transcript instead of a `404` that surfaced as a browser console error. (#705)
- BYOK custom-endpoint key validation rejects a private / internal / cloud-metadata base URL before probing it (SSRF defense-in-depth). (#707)
- Managed control plane: the admin env-preview no longer returns the CP-pool LLM keys / migration token in plaintext (masked); Hono bumped for a cookie-handling advisory. (#274)
- Managed control plane: the per-tenant host SSH key is decrypted before use, so deploys to encrypted hosts no longer fail. (#273)
- Managed control plane: a same-tag (`staging`→`staging`) rollout reaches an instance pinned to that moving tag instead of silently skipping it. (#272)


## 1.11.1 — 2026-06-08

Patch: production sanctions name-screening (now populated, with non-Latin coverage), native context window for BYOK/self-host models, and trial-email polish.

### Features
- **Native context window** — resolve the real context window for custom / BYOK / self-host models instead of a fixed fallback. (#696)

### Fixes
- **BYOK model id** — render the model-id field for the generic OpenAI-compatible endpoint so the config can be saved (it was rejected with HTTP 400). (#697)

### Control Plane (managed hosting)
- **Sanctions name list** — bake the OpenSanctions list into the image so production screening is populated on the read-only container. (#266)
- **Sanctions non-Latin coverage** — index Cyrillic / CJK / Arabic names; closes a ~34% list blind spot. (#267)
- **Trial email** — warmer trial-ending copy that names the exact charge amount. (#252)

## 1.11.0 — 2026-06-08

Compliance-and-trust release: EU AI Act Art. 50 transparency disclosure, hardened BYOK custom-endpoint handling, and a content-free security-event aggregate for abuse monitoring.

### Features
- **EU AI Act Art. 50 disclosure** — a persistent composer notice that responses are AI-generated and may contain errors (DE + EN). (#695)
- **BYOK custom-endpoint disclosure** — server-persists the "own endpoint" acknowledgement and surfaces curated provider guidance; the disclosure gate survives reload. (#693)
- **Content-free security-event aggregate** — a new admin endpoint exposing event-type/tool/decision counts with no message content, for abuse monitoring. (#692)

### Fixes
- **BYOK endpoint allowlist** — drop the overbroad `*.amazonaws.com` entry and clean up the retired Bedrock sub-processor path. (#691)

### Docs & Internal
- Correct the managed Mistral sub-processor model list. (#694)
- Add a chat-run lifecycle resilience smoke guard. (#678)

## 1.10.0 — 2026-06-06

Resilience-and-cost release: chat runs survive reloads and disconnects, long threads stop silently losing messages, the prompt cache works again (large cost drop on long conversations), and a batch of mobile/artifact UX fixes.

### Features
- **Run resilience** — a chat run is no longer tied to its browser connection. Reload or disconnect and the run keeps going headless; the nav shows a live-run indicator, runs are resumable via a replayable event stream (`/api/runs/:id/stream?since=`), a run registry sweeps orphaned runs on boot, and a concurrency-capped executor lets the client re-attach to an in-flight run. (#679–#684)
- **Drag-and-drop file upload** onto the chat. (#687)
- **Artifact export + mobile fullscreen** — print/export an artifact, a fixed mobile fullscreen view (safe-area + sticky close), and gallery fit-to-width on mobile. (#688)
- **ask_user multi-select** now survives a reconnect. (#679)

### Fixes
- **Prompt-cache cost** — a per-turn knowledge block and hour-precision date in the cached prefix were re-breaking the cache every turn, re-billing the whole history (quadratic cost). The prefix is stable again → large cost reduction on long threads.
- **Post-compaction data loss** — assistant messages no longer disappear from long/compacted threads on reload, mobile, or export; persistence now uses an identity high-water-mark instead of a disk-count floor.
- **Dangling tool_use (ENGINE-10)** — tool-pairs are sanitized before every API send, so a partial turn can't brick a thread; previously bricked threads self-heal on the next successful turn. (#683)
- **Compaction blob carry-forward** — tool-result blobs survive compaction via an LRU cap instead of being cleared. (#685)
- **Google Drive binary uploads** + steering deliverables to artifacts. (#689)
- **Managed copy sweep** — cleaner managed-facing settings copy (tool blurbs, reranker, privacy back-button, api-setup-v2). (#686)
- **Mobile nav** — a new chat shows in history immediately, and the first tap no longer collapses or opens the chat-history list (synthetic touch hover ignored). Desktop footer decluttered; message cost/token stats render reliably.

### Internal
- Migrations v33 (`pending_prompts.multi_select`) and v34 (`active_runs` table) — both additive and forward-only.
- Client-side PDF export was reverted (it can't faithfully render JS-navigated decks); a server-side PDF export is a planned follow-up.

## 1.9.0 — 2026-06-04

Trust-and-recovery release: chat turns and artifacts never silently vanish, cost tracking shows one consistent number everywhere, artifacts gain a real version history, and `ask_user` can offer multiple answers.

### Features
- **Artifact version history** — every save snapshots the version it replaces (up to 10), with new `artifact_history` / `artifact_restore` tools so an accidental overwrite is recoverable. Gallery cards now show the updated time + a version badge. (#677)
- **ask_user multi-select** — opt-in `multiSelect` lets you toggle several answer pills and Send, instead of one-click-and-done. Single-select is unchanged. (#676)

### Fixes
- **Durable chat turns** — a user message is now persisted at run start, so an abort / reload / queued send mid-stream can't lose it (continued-session prompts no longer disappear). Queued messages survive a reload; the scroll stays pinned on send. (#673)
- **Cost tracking, one source of truth** — the footer, the dashboard "today" tile, and the 14-day chart now agree (local-timezone day buckets); the histogram ends on today instead of stale dates; per-thread cost reflects the full thread; headline run counts are your chat turns (voice + sub-runs counted separately). (#674)

## 1.8.3 — 2026-06-04

Feature release: artifacts become first-class editable files, a calmer and more trustworthy context-compaction flow, and a round of agent-tool security hardening.

### Added

- **Artifacts are real, editable source files.** The agent can now treat an artifact as a file it reads and edits in place (`edit_file`) with grounding discipline, instead of regenerating the whole thing — edits update the existing artifact, no orphans or duplicates.
- **Inline artifacts render as a collapsed pill.** Artifacts in the chat stream show as a compact pill that lazy-expands on click (and is keyboard-operable), instead of dumping a large inline blob.
- **A visible "context compacted" marker.** When a conversation is summarized, a calm marker now persists in the thread so it's clear what happened — artifacts, decisions and the through-line are kept.
- **Prepare-and-compact flow.** Compaction is now offered later and more calmly (a quiet, user-triggered bar near the threshold) rather than an alarming early banner.

### Fixed

- **Compaction summaries are reliable.** The summary now runs with tools disabled and authoritative framing, so it can't wander into tool calls or disown its own summary — the open task survives the compaction.
- **100vh deck artifacts render at 16:9** instead of collapsing to a ~200px sliver.
- **Changeset review is tidier.** Friendly artifact labels + viewer-meta spacing, and the diff `+++`/`---` headers no longer surface the internal artifact path.
- **The artifact pill is keyboard-operable** (focusable, Enter/Space toggles).
- **`ask_user` accepts a questions-only batch** (the hard "must include a question" requirement is dropped).
- **Docker build flake killed** — the Whisper base model is mirrored and the tiny model dropped, ending the intermittent Hugging-Face build failure.

### Security

- **Watch + migration-export fetches go through the pinned network guard.** Outbound requests from the watch loop and the migration/export path now resolve-once + pin the socket + refuse redirects, closing an SSRF surface (no hand-rolled denylist, no localhost carve-out).
- **Watch tasks are cost-bounded.** The watch interval is floored at 5 minutes and the analysis session carries a hard budget cap.
- **Malicious-write guard wired into `write_file`/`edit_file`** — write content is scanned and rejected if it matches known malicious patterns.

### Internal

- Public-repo leak-guard + removal of internal staging/ops tooling from the public repo; drift-guard + positioning-guard added as required CI checks.
- Staging image builds amd64-only; gitleaks + pattern-scan moved from pre-push to pre-commit.

## 1.8.2 — 2026-06-03

Bug-fix patch: a chat-resume regression on legacy model tiers, a spurious managed run-block, and an inbox decode + context-pane redesign.

### Fixed

- **Chat is visible immediately on thread resume again.** Managed threads carrying a legacy `model_tier` (`sonnet`/`opus`/`haiku`, pre-rename) returned a 500 on resume, so the conversation only appeared after a manual page refresh. The legacy tier is now normalized (`normalizeTier`) on the resume path.
- **No more spurious "Managed control plane unreachable" run-blocks.** A managed tenant could fail-closed and block a run even when the control plane was up; a proactive credit heartbeat keeps the status fresh and the message was softened.
- **Mail bodies decode correctly in the reader.** Body parts are now decoded by their Content-Transfer-Encoding (base64 / quoted-printable) and the declared charset is honored, so encoded or non-UTF-8 mail no longer leaks raw `=20`/base64 text into the inbox (also fixes the single-part snippet path).
- **Inbox reader can't collapse to one-character-per-line.** The reading pane now has a floored minimum width.

### Changed

- **Inbox context moved below the mail body.** The mail-context (recent threads, follow-ups, outbound, reminders) is now a stacked single-column section that scrolls beneath the message instead of a right-hand sidebar — a cleaner read on both desktop and mobile.

### Internal

- Published the 2026-05-30 fairness-fixed Set-Bench run. (#652)

## 1.8.1 — 2026-06-03

Stabilization patch from the first `/release-harden` run (3-tier canary-verified). 7 commits, all fixes.

### Fixed

- **Env-pinned managed instances no longer persist a stray provider/endpoint change.** A `PUT /api/config` of `provider`/`api_base_url`/`openai_model_id` was stored (masked at runtime by the env-pin) and surfaced the *wrong* provider + data-residency in LLM Settings and `/api/export` — e.g. an EU-Mistral tenant showing "Anthropic / US". Those env-controlled fields are now stripped from the persisted update when `LYNOX_LLM_PROVIDER` is set. (#650, H-001)
- **OpenAI-compatible provider save now surfaces the server's validation error** (e.g. "provider:'openai' requires openai_model_id") instead of failing silently and looking like a no-op. (#650, H-007)
- **Workspace access-token reveal fixed** — it called a non-existent route (`/api/access-token` → 404); now uses `GET /api/auth/token?reveal=true` (mirrors the vault-key reveal). (#650, H-012)
- **Tier-rename copy cleanup**: dropped the stale "magistral" tier-claim from provider help-copy + first-run pickers, made the keyless empty-state key-hint provider-agnostic, and canonicalized the `/api/config` `managed` field (`starter`→`hosted`). (#648)

## 1.8.0 — 2026-06-03

Provider-agnostic tier model + canonical billing-tier consolidation. 16 commits since v1.7.9.

### Breaking

- **Provider-agnostic model-tier names** (#639). `opus`/`sonnet`/`haiku` → `deep`/`balanced`/`fast` across the `ModelTier` type and config. Legacy Anthropic-brand names are still accepted and normalized via `normalizeTier`, so existing `config.json` and `LYNOX_DEFAULT_TIER`/`LYNOX_MAX_TIER` env vars keep working unchanged.
- **Billing-tier rename `starter` → `hosted` + `eu` tier retired** (#647). A canonical billing-tier module is now the single source of truth across web-ui, engine, and the control plane; `starter`/`eu` are accepted as legacy aliases. Managed deployments apply migration `0029_rename_tier_hosted` (renames existing rows; `eu` rows preserved).

### Added

- **Opt-in chat diagnostics panel** (#643) — per-message metrics surfaced in the chat view.
- **JSON export** option in the thread kebab menu (#636).
- **`/api/config` surfaces the effective active provider** when a provider is env-pinned (#646).

### Changed

- **Mistral tier refresh** (#644): `deep` = `mistral-large-2512`, `balanced` = `ministral-14b-2512`; `magistral` dropped from the tier set (retires 2026-07-31). Set-Bench got a fairness pass (judge-panel + open-ended axes).
- **Provider tiles are read-only with a tailored banner when the provider is env-pinned** (#645).
- **Provider-switch hardening** (#641, #642): footer reactivity, API-error keeps the turn, env-copy, display/API history split, silent-turn render, demo cost-gate.
- **Tightened `read_file`/`http` context caps** + `api_setup` source-domain filter (#637).
- **Grounding prompt** now splits knowledge by verification source (#638).

### Removed

- Retired the `pipelineStatusV2` knob (#635).

## 1.7.9 — 2026-05-27

### Added

- Propagate provider/credential switch to long-lived Sessions; `engine.configVersion` increments on credential/provider swap (#42).
- Mistral SSRF whitelist + ENV-override banner + Hosted-BYOK back-button (F9/F7).

### Fixed

- Reconcile chat thread from server on ChatView re-mount (F13).
- Self-host `/login` form 403 via `ORIGIN` env.

### Changed

- Overnight i18n + copy hygiene batch — mail modal, Google grammar, push card (#634); HN-doc-sweep (#633).

## 1.7.8 — 2026-05-27

### Fixed

- Billing-page subtitle + Upgrade-CTA for the Hosted-BYOK tier (G4).

## 1.7.7 — 2026-05-27

### Added

- Link the Privacy & Data page from the Settings hub.

### Fixed

- Engine boot crash on BYOK tenants with `provider=openai` and no key.
- Restore Mistral / Custom-OpenAI provider config in the SetupBanner (G5).

## 1.7.6 — 2026-05-27 night

Patch — three managed-tier UX gaps caught during the v1.7.5 staging walk on a Hosted-BYOK (`starter`) tenant. All three traced to managed-mode code paths assuming `LYNOX_MANAGED_MODE=*` always means the CP supplies the LLM key — wrong for Hosted-BYOK where the customer brings it. G2 additionally affected self-host with non-Anthropic providers.

### Fixed

- **LLM Settings now shows the API-key input on Hosted-BYOK** (#632 G1). New `cpSuppliesLLMKey()` helper returns true only for `managed`/`managed_pro`/`eu`; previously `isManaged()` returned true for `starter` BYOK too, hiding the key-input field and stranding the customer.
- **ChatView inline empty-state is provider-aware** (#632 G2). Was hardcoded `sk-ant-...` placeholder + `console.anthropic.com` link regardless of selected provider — Mistral-via-Custom or Hosted-BYOK-with-Mistral users got the Anthropic prompt anyway. Affects self-host too. Now derives `variant` (anthropic / mistral / openai-custom) from `/api/config.api_base_url` and shows matching label/placeholder/console URL + saves to the correct vault slot.
- **Status bar truthful on managed-BYOK** (#632 G3). PR #630's not-configured check bypassed every managed tier including BYOK; customer saw green "API OK" while SetupBanner demanded the key. Now gates on `cpSuppliesKey` (managed/managed_pro/eu) only.

## 1.7.5 — 2026-05-26 night

Pre-HN-launch eve self-host hardening + UX polish. 10 PRs since v1.7.4.

### Breaking

- **Tavily web-search backend retired.** The `TAVILY_API_KEY` env var, `search_provider: 'tavily'` config value, and the `TavilyProvider` class are gone. The UI hadn't surfaced Tavily for months; keeping a dead env-var path was misleading. SearXNG (sidecar via `docker compose up`, or any `SEARXNG_URL` you host) is the supported full-quality backend.
- Legacy `search_provider: 'tavily'` values in `config.json` are silently coerced to `undefined` on load — existing configs still validate without manual cleanup. Vault entries named `TAVILY_API_KEY` or `SEARCH_API_KEY` are left in place (untouched) but no longer resolved as a search credential.

### Added

- **SetupBanner pre-flight API-key validation** (#629). Typo'd keys are now rejected with the engine's actual reason before the vault write, instead of silently landing and 401-ing on the user's first chat. Reuses the same 3-state validators the CLI installer uses (`anthropic | mistral | openai-compat`).
- **Status bar `Setup needed` indicator** (#630). The bar used to show "API OK" on fresh self-host because it only checked `status.anthropic.com` endpoint health, not whether the user had wired a key. New `not-configured` state colours amber and labels "Setup needed".
- **Honesty-fallback when `web_research` is not configured.** Previously the agent silently fabricated search results (made-up arXiv IDs, prices, "recent X") when no search backend was wired up. Now the agent gets explicit "no search available — DO NOT fabricate" instructions in its system prompt.
- **Embedded DuckDuckGo HTML-scrape fallback** for `web_research` when SearXNG isn't configured. Best-effort, with a "fallback quality" prompt suffix so the agent caveats findings.

### Fixed

- **Gmail-OAuth From-name** dropped — recipients saw the local-part only as sender (#623). Parity with IMAP/SMTP via the existing `formatAddr` helper.
- **Entrypoint `${VAR:0:8}` bash-only on BusyBox sh** (#625). Fresh users never saw the 8-char token preview; retrieval command hardcoded `docker exec lynox` (wrong container name under docker-compose). POSIX `printf | head -c 8` + host-side `cat ~/.lynox/.access-token`.
- **PasskeyPrompt no longer renders on self-host** (#626). Click used to dead-end at `/auth/passkey/register` (WebAuthn lives on the managed CP, not the engine). Bail on `supported === false`.
- **SetupBanner Mistral/Custom-OpenAI-compat first-save 500** (#627). `PUT /api/config` validated eagerly and 500-ed if vault was empty. Reorder: secret-PUT then config-PUT.
- **ONNX embedding cache write** (#628 + the installer compose-file parity in #631). `read_only: true` blocked the subdir mkdir; tmpfs at `/home/lynox/.cache` + entrypoint pre-creates expected subdirs.
- **ChatView polish** (#622): inline KI-badge, thread-actions hamburger menu, scroll-during-generation race fix.
- **Mistral fallback no longer overrides healthy Anthropic primary** in the status bar (#616).
- **Login logo `l` letter top cropped at h-20** (#631). SVG viewBox extended.
- **Login "Lost it?" hint** (#631) replaced hardcoded `docker logs lynox` with host-side `cat ~/.lynox/.access-token`.

### Internal

- **Installer Compose-version display** (#624). Was printing `Compose ersion` because the regex matched the `v` in literal "version". Anchored regex + Vertex env-vars removed from `--help`.
- **Installer compose-file generator** picks up #628's huggingface tmpfs + pids_limit + json-file logging rotation (#631). Every `npx @lynox-ai/core` user used to re-trip the ONNX-cache ENOENT.
- **`.dockerignore` patterns are recursive** (`**/node_modules` etc.) (#631). Host-side `node_modules` was leaking into the docker context on Apple Silicon contributor builds and dangling the symlinks pnpm install produced. CI on Ubuntu happened to not hit it; pinning explicitly removes the platform-dependence.
- **Stale-name sweep** across 32 files (#631). Dead Telegram / Slack / MCP / Tavily references removed from JSDoc comments + retired-integration test fixtures. `ContextSource` narrowed from `'cli' | 'slack' | 'mcp' | 'pwa'` to `'cli' | 'pwa'` (actual call sites).
- **LLM-provider claim cleanup** (#631). Docs, `.env.example`, `--help`, installer hints, SetupBanner i18n (DE+EN), `llm/catalog.ts` all mark Anthropic + Mistral as tested-on-every-release and every other openai-compat target as experimental.
- **`POST /api/secrets/validate-key` engine endpoint** (#629) backs the SetupBanner pre-flight; same shape as the CLI's validators (`KeyValidation` 3-state).
- **Pre-flight security + honesty + UWG sweep** (#617).
- **Docs drift cleanup + ROADMAP v2 publish** (#621).
- **Public-repo stale-ref + PII-fixture cleanup** (#620).
- **Deps bump 16 minor/patch** (#619).

## 1.7.4 — 2026-05-25

Patch — pre-HN-launch cleanup. Two Bugsink-noise fixes against `v1.7.1` and a CLI-side legal addition.

### Added

- **`Terms of Service` acceptance gate in the CLI setup wizard.** First `npx @lynox-ai/core` / `lynox init` shows the ELv2 / no-warranty terms with a confirm prompt, persists acceptance in `~/.lynox/.tos-accepted-1`. Bumping `TOS_VERSION` re-prompts (versioned consent). Closes Item 17 of the 2026-05-25 pre-HN legal audit (#613).

### Fixed

- **WorkerLoop benign workflow-not-found races no longer surface to Bugsink.** When a saved workflow is deleted between cron-scheduling and the executor tick, `executePipeline` records the skip via `recordAndNotify` ("no longer exists (skipped)") instead of rethrowing the typed error. Closes Bugsink `ENGINE-8` (#614).
- **Session-run returns a friendly 400 when no LLM key is configured** instead of letting the Anthropic SDK deep-throw from `validateHeaders()`. Adds a pre-flight check on `POST /api/sessions/:id/run` that mirrors the `configured.api_key` logic in `GET /api/secrets/status`. Closes Bugsink `STAGING-ENGINE-6` + `STAGING-ENGINE-7` (#615).

### Internal

- User-facing string casing `LYNOX` → `lynox` in 4 boundary surfaces (http-api startup log, Google-auth HTML pages, content-extractor User-Agent header). Closes pre-HN legal audit trademark item P1-19 (#612).

## 1.7.3 — 2026-05-25

Patch — **HN-launch hardening sprint** (33 PRs, +155 tests). Re-cut after `v1.7.2` stalled in the docker pipeline; the matrix builder unblocks a 6.5× faster multi-arch publish. Focuses on EU-residency leak closure, BYOK disclosure, multi-arch images, and security-audit follow-ups.

### Added

- **BYOK allowlist + disclosure for custom LLM endpoints** — the custom-provider wizard surfaces a vetted allowlist with provider-specific privacy posture before the key prompt; user must accept the data-flow disclosure (#607).
- **AI-generated marker on assistant messages** (chat UI) + **`X-lynox-AI-Generated` SSE header** — Art. 50 transparency (#591, #590).
- **ToolCallTracker wired in shadow mode** for anomaly observability — H-024 (#595).
- **Sensitive-paths list expanded** to cover lynox DBs, shell histories, and macOS Keychain — H-003 (#593).

### Fixed

- **Chat cost-footer no longer accumulates across multi-turn** — was showing 3-6× actual cost on long threads (#608).
- **Inbox classifier honours provider-switch** — H-012 / EU-residency leak (Anthropic was being called after switch to Mistral) (#606).
- **`plan_task` + `run_workflow` plumb fresh provider config** — H-011 (#605).
- **`read_file` + `spawn_agent` returns wrapped in untrusted-data envelope** — H-001 + H-002 (#592).
- **`bash` env no longer inherits `SSH_AUTH_SOCK` / `GIT_ASKPASS` / `GIT_SSH_COMMAND`** — H-004 (#594).
- **`npx` symlink shim resolves realpath in `isMainModule`** — fixes the silent no-op on some PNPM installs (#584).

### Changed

- **Multi-arch docker images (amd64 + arm64) via native arm64 runners + matrix manifest stitch** — fixes BI-003; 14.6 min total build (was QEMU-stalled in `v1.7.2`) (#585, #610).
- **`uuid` override bumped to >=11.1.1** — H-007 / CVE (#603).
- **`protobufjs` override bumped to >=8.2.0** — B-018 / CVE (#589).
- **`mistral-large-2512` pinned** in catalog + docs (B-004 + B-005) (#586).
- **`api-cost-display` flag defaults true** — B-011 (#588).
- **Docs honesty pass**: Tavily references struck from `CLAUDE.md` + api-store (H-014, #602); Telegram infra attribution corrected (H-017, #596); SameSite cookie attr corrected to Lax in security docs (H-013, #598); docker image tag example bumped to 1.7.1 (H-015, #597); Activity Hub link route fixed after IA-V2 (H-016, #599); Automation Hub vs Activity Hub disambiguated (H-018, #600); Verify-Setup step 3 refreshed to match v1.5.1 StatusBar (#601); MCP server claim struck from `CLAUDE.md` + `ROADMAP.md` (B-006, #587).
- **libvips LGPL-3.0 dependency documented** in licenses (H-005, #604).

### Internal

- **v1.7.2 cancelled** — docker-publish pipeline stalled on QEMU during the multi-arch build; re-cut as v1.7.3 with the new matrix manifest-stitch flow.

## 1.7.2 — Cancelled

Tag was cut and released but the docker-publish pipeline stalled on QEMU during the multi-arch build. Re-cut as `v1.7.3` with a matrix manifest-stitch flow (#610). Use `v1.7.3` or later — there is no production `v1.7.2` image.

## 1.7.1 — 2026-05-25

Patch — **Mistral first-class + EU-residency leak closure + Settings polish** (19 PRs, morning sprint).

### Added

- **Mistral Large 3 as Sonnet-tier replacement** + retire stale model names (`small/large/magistral` text refresh post-Ministral-gen3 swap) (#566, #567).
- **Mistral native prompt cache** surfaced in adapter + bench harness (#565).
- **Set-Bench v4 harness** — 8 lynox-real-world axes + cache-aware costs (#559).
- **API-store: curated bootstrap-suggestion catalog** injected into agent context (#558).
- **Honesty-fallback when `web_research` is not configured** — agent gets explicit "DO NOT fabricate" instructions instead of inventing arXiv IDs / prices (#564).
- **Web-UI demo-mode**: auto-session + locale lock + onboarding chips + cost hide (#481).
- **Provider-aware Denkstil UI** + remove duplicate Standard options (#578).

### Fixed

- **EU-residency leaks**: sub-agent inherits Mistral provider config from parent (#568); `llm-helper.callForStructuredJson` honours user provider/model (#570); `process-capture` plumbs provider/model so Mistral users can save workflows (#571); structured EU residency provider-switch propagation test (#574); bench-driven product tweaks (#569).
- **Adapter delta.content** no longer leaks `[object Object]` for non-string content (#572).
- **`/api/secrets/status`** recognises non-Anthropic provider keys (#546).
- **OpenAI path hardened**: `finish_reason`, `tool_choice`, config-validate (#532).
- **Web-UI**: SSE error events surfaced + status bar bound to active provider (#560); KG view toggle wires Graph mode (#561); auto-save LLM provider tile click for curated presets (#557); stop leaking `[ONBOARDING N/3]` markers + ask for explicit `artifact_save` (#556); hover-prefetch no longer silently logs users out (#554).
- **Nav**: chat-history fills sidebar without flicker via `mt-auto` (#582); flex spacer pinning (#580); settings reactivity + compound-noun preservation (#581); markdown `N.` rendering + footer label + nav pin (#579).
- **Server**: rebuild `used_cents` from daily entries (HN P0) (#562); default `ORIGIN` on source/npx boot to fix CSRF login 403 (#563).
- **Orchestrator**: thread parent memory backend to sub-agent inline steps (#553); allow `memory_*` tools in workflow inline steps (#548).
- **Network-guard**: guard against undefined address in `resolveAndValidate` (#551).
- **Auth**: consolidate `isHttpsRequest` helper — restore `Secure` cookie flag on managed deployments (#484).
- **Cron**: surface cron failure as `status='failed'`, auto-recover on next success (#544).
- **B1 memory_recall/update/delete** reverted to flat-file + 3 optimizations (#540).

### Changed

- **Self-host installer hardened** — 6 P1 fixes for HN-launch readiness (#547).
- **CLI trimmed** to launch-essential modes (wizard, http-api, init) (#537).
- **WhatsApp Inbox removed** until staging E2E coverage exists (#538).
- **README / docs**: docs honesty pass — source-available framing + internal OWASP + telegraf dep removal (#552); MCP card dropped from docs Integrations (#543); one-shot mode section removed from README (#542); login logo swapped to brand variants (#549); `mistral-large-2512` pinned in `llm-providers` + Mistral repositioned (#576).
- **Pre-launch prompt-slice optimisation**: capability surface + EU/OSS framing + KPI trigger (#577).
- **`/app/workflows` → `/app/automation` redirect** for the IA-V2 rename (#541).
- **CI**: stub gitleaks/test/docker-scan for docs-only PRs (#550).
- **Spawn**: extract provider-precedence helper + `Agent.toJSON` scrub (#573).
- **Tier-1 HN-launch compliance hardening** umbrella (#555).
- **Search-reranker Mistral-disabled state surfaced in UI** (#575).
- **Launch-readiness sweep**: `CONTRIBUTING`, `ROADMAP`, `SECURITY`, licenses (#483).
- **memory_recall chat visibility locked in** + label fallback tightened (#545).
- **`Lock in memory_recall` chat visibility + tighter label fallback** (#545).

## 1.7.0 — 2026-05-22

Minor — **Workflow-UX unification + chat-streaming polish + agent-efficiency**. The agent's workflow tool surface is consolidated 8 → 6 with one consistent "workflow" vocabulary across tools, HTTP API and UI, plus a new **Saved Workflows** library tab. The chat stream gains an animated presence indicator, a live activity ticker, interleaved thinking, and an inline compaction marker. Agent-efficiency work lands orchestrated sub-agent routing and non-lossy compaction (a tool-result recall blob store). **Breaking:** the tool renames and the `/api/pipelines*` → `/api/workflows*` endpoint move are a hard cut with no alias — external MCP clients / API scripts must update.

### Breaking

- **Agent tool surface 8 → 6 (#510, #512, #514)** — `run_pipeline` → `run_workflow`; `capture_process` + `promote_process` merged into one `save_workflow`; `step_complete` removed.
- **HTTP API `/api/pipelines*` → `/api/workflows*` (#511)** — hard rename, no alias.

### Added

- **Saved Workflows library (#513, #520)** — A library tab listing reusable workflows with run / rename / delete, and expandable per-step details.
- **`save_workflow` tool (#512)** — One call to capture and save a reusable workflow; merges the former `capture_process` + `promote_process`, with redaction hardening.
- **`plan_task` decoupled (#514)** — Planning never executes; it returns a reusable `workflow_id` that `run_workflow` runs.
- **Chat streaming presence (#494, #497–#499)** — Animated lynox-icon presence indicator + live activity ticker coupled to run state.
- **Interleaved thinking (#492)** — Thinking renders interleaved with text and tool calls in chronological order.
- **Compaction marker (#491)** — A persistent inline marker shows where the conversation was compacted.
- **Downloadable artifacts (#493)** — Data-file artifact types are downloadable; HTML artifacts offer a source download.
- **Orchestrated sub-agent routing (#507)** — Eligible multi-step plans dispatch one sub-agent per step.
- **Non-lossy compaction (#508)** — Large tool results are evicted to a recall blob store at compaction and fetchable on demand via `recall_tool_result`.

### Fixed

- **Main agent no longer auto-downgrades (#517)** — The main conversational agent always runs on the configured tier; the per-turn `_isSimpleTask` heuristic that silently dropped to Haiku is removed.
- **Deterministic `save_workflow` steps (#521)** — Step extraction preserves the actual action sequence; the LLM only annotates a fixed step list and can no longer merge or drop steps.
- **Per-message usage footer survives an SSE drop (#518)** — The `done` event echoes the run usage so the footer renders even if the `turn_end` frame is lost.
- **Per-message LLM usage persists across thread resume (#486)**.
- **Saved-workflow persistence (#515, #516)** — `save_workflow` and decoupled `plan_task` persist their pipelines so the library and `workflow_id` survive a restart.
- **Context budget from real API usage (#489)** — Replaces the summed estimate that drifted past 100%.
- **Truncated `max_tokens` turns continue (#490)** — A turn cut off at the token cap resumes instead of returning empty.
- **Voice (#488, #495)** — STT glossary no longer rewrites common words to proper nouns; voice messages can't double-submit.
- **Speak (#503)** — TTS-hostile special characters normalized.
- **Web UI (#485)** — Mobile nav, chat scroll, artifact deep-links.
- **`capture_process` reads session-wide tool calls (#505)**.
- **Operator-channel hallucination (#502)** — The prompt states the real operator channels, stopping Telegram hallucination after the Telegram removal.
- **Nav chat-history fills the sidebar (#519)** — The thread list grows to fill available height; other nav items pin to the bottom.

### Internal

- **Agent-efficiency measurement (#506, #509)** — Phase-0 measurement protocol + a Tier-1 static cost-regression guard.
- **perf(memory) (#487)** — A no-query `memory_recall` is bounded to a ranked, capped subset.
- **Shared `AgentPresenceIcon` (#500)** — Extracted; transcription state animated.
- **Transcription animation + compaction history block (#501)**.
- **Telegram references removed from README + bench fixtures (#504)**.
- **CI: staging-smoke pnpm setup fixed (#496)**.

## 1.6.0 — 2026-05-19

Minor — **Magic-Link OTP + Settings v3 inline-merge + Stripe-portal stopgap**. Adds passwordless email login as a third auth method alongside passkey + password. Settings v3 sprint lands the capability registry, tier audit, show-all-grayed pattern, Account pages, and inline merge of Advanced into the LLM main page. The broken `control.lynox.cloud/checkout/account` CTA in Account+Billing is replaced with a Stripe-hosted Customer Portal link + `support@` fallback (full engine→CP→Stripe SSO deferred — see `PRD-STRIPE-PORTAL-SSO.md` v3). Light-mode theme ships. Plus a session-cookie hardening pass (`SameSite=Lax` + OTP stale-session guards) and a `http_request` hang-fix that previously could lock a session.

### Added

- **Magic-link OTP auth (#472, pro #149)** — Email-driven passwordless login alongside passkey + password. HMAC token mint/verify/consume with nonce-replay protection, 15-min TTL. Staging-E2E proven on `meridian-demo` via Mailpit.
- **Light mode (#476)** — Web-UI theme switcher; persists to user prefs.
- **Settings v3 sprint (#471)** — `ModelCapability` registry as single source of truth for tier/context-window display. Tier-awareness audit across all settings pages. Show-all-grayed pattern for managed-blocked sections. Account pages (Appearance, Security, Limits, Updates) split out from monolithic `SystemSettings`. Advanced merged inline into the LLM main page.
- **Stripe-portal URL forwarding (pro #151)** — `MANAGED_STRIPE_PORTAL_LOGIN_URL` from CP env now flows to every managed instance's `.env` as `LYNOX_STRIPE_PORTAL_LOGIN_URL`. Engine `/api/config` surfaces it under `stripe_portal_login_url` for the Account+Billing CTA. Prefix-guarded to `https://billing.stripe.com/`.

### Fixed

- **Broken `control.lynox.cloud/checkout/account` CTA (#478)** — Account+Billing now opens the Stripe-hosted Customer Portal login URL when configured, falls back to `mailto:support@lynox.ai` otherwise.
- **`/auth/magic` auth-gate hole (#477)** — Magic-link callback route exempted from the session-cookie auth gate (was 401-blocking the pre-login token verification).
- **LLM defaults dropdown (#479)** — `effort_level`, `thinking_mode`, `experience` selects now show a `Default` option matching the model's actual default instead of forcing a choice between "Schnell" / "Deaktiviert".
- **Settings sub-view back-links (#479)** — `← Back to settings` added on Account Appearance, Workspace Security, Workspace Limits, Workspace Updates (were dead-ends).
- **Tool taxonomy (#479)** — `capture_process` + `promote_process` moved from System to Orchestration (the `_process` regex was incorrectly bucketing workflow tools as System).
- **OTP stale-session bypass (#469)** — Guarded OTP actions against requests with stale session cookies; `SameSite=Lax` migration tightens cross-site request scope.
- **`http_request` hang unsticks session (#470)** — Wall-clock cap + takeover + cancel for hung HTTP requests.
- **`managed_blocked` prediction (#466)** — UI predicts managed-blocked state from tier instead of waiting for runtime 403. Fixes context-window display drift on managed.
- **`ask_secret` managed-vs-cancel (#465)** — Distinguish CP-rejected secret writes (managed-blocked) from user-cancel in `ask_secret`.

### Security

- **Managed secret allowlist inverted (#468)** — Default user-writable on managed; narrow deny-list (`LYNOX_*`, `MANAGED_*`, `MAIL_ACCOUNT_*`, `WHATSAPP_*`, `GOOGLE_OAUTH_*`, `SMTP_*`, `IMAP_*`) is admin-only. Realises the core promise: customers connect any API without filing a support ticket.
- **OAuth2 fail-loud** — OAuth flow errors now surface immediately rather than silent-fail.
- **Engine-managed Bearer auth** — Stricter Bearer-token verification across managed surfaces.

### Internal

- **Mailpit on staging-CP (pro #150)** — Outbound mail sink for OTP / magic-link / dunning testing on the staging control plane.
- **Deps bump (#475)** — Minor-and-patch group, 12 updates.

## 1.5.2 — 2026-05-18

Patch — **LLM provider-switching hardening** (rafael QA across the day). After v1.5.1 shipped, switching from Anthropic to Mistral exposed five stacked bugs in the runtime + UI: the engine kept reading `ANTHROPIC_API_KEY` regardless of provider, `/api/llm/test` 400'd on saved-and-empty body keys, the model self-identified as "Claude Haiku" even though Mistral was dispatched, the UI hid the tier-set behind a single misleading "Modell" dropdown, and on managed the API-key input was a disabled red-herring. Six follow-up PRs land the wire-level fixes, the UI cleanup, and the explanatory anchors so a provider switch is robust + observable.

### Fixed

- **Robust live provider switching (#456 follow-up #458)** — Engine `_recreateClient` now resolves the API key from the active provider's vault slot (Mistral → `MISTRAL_API_KEY`, Custom → `CUSTOM_API_KEY`, OpenAI → `OPENAI_API_KEY` secondary) instead of hardcoding `ANTHROPIC_API_KEY`. Session passes the provider-resolved key to the Agent. `/api/secrets/:slot` hot-reloads on every BYOK slot, not just `ANTHROPIC_API_KEY`. New canonical helper `core/llm/provider-keys.ts` mirrors the web-ui's `VAULT_SLOTS` map. (#458)
- **`engine.reloadCredentials()` for vault-only writes (#458 round-1)** — Pre-fix the existing `reloadUserConfig` gated `_recreateClient` on config.json field deltas, so `/api/secrets/:slot` writes left `engine.client` stale (visible to KG init + batch ops). New `reloadCredentials()` forces re-init and is called by the secrets endpoint. (#458)
- **`/api/llm/test` vault-fallback** — When the user previously saved a key and the form posts an empty body key (page reload), the endpoint now resolves from env > vault instead of returning `400 "API key required"`. Pre-fix made "Verbindung testen" unusable after the first save. (#458)
- **UUID-validated test endpoint** — `POST /api/llm/test` validates `provider` against the LLMProvider union before the cast, closing a defensive gap for future `SECONDARY_SLOTS` expansion. (#458)
- **Per-secret audit row** — Every BYOK secret write emits a `secret_update` SecurityAudit row (names-only, no values) matching the `PUT /api/config` audit parity from P3-PR-B. (#458)

### Changed

- **SYSTEM_PROMPT identity anchor (#458, #460)** — A new `modelIdentityContext` helper interpolates the active provider + actual model id into the system prompt and explicitly forbids tier-alias self-identification (`opus` / `sonnet` / `haiku` are routing tiers, not model names). Sanitises the user-controllable `openai_model_id` field (strips backticks/newlines/structural chars, caps 64) to close a prompt-injection vector on managed. Pre-fix Mistral confidently answered "Ich bin Claude Haiku" because nothing pinned its identity.
- **LLM Settings → Mistral preset tier-set view (#459)** — The misleading single "Modell" dropdown (which wrote `openai_model_id` with no runtime effect on tier-aware providers) is gone for Mistral. The tier-set summary block now shows both Main + Small/fast model, with a one-line "lynox routes per turn — simple replies → small, complex → main" hint. Anthropic keeps its dropdown because there it binds to runtime-meaningful `default_tier`. (#459)
- **Mistral default-tier picker parity with Anthropic (#461)** — Unified picker for every tier-aware provider, binding `default_tier`. On Mistral the tier maps via MISTRAL_MODEL_MAP (sonnet → Large, opus → Magistral, haiku → Small). The tier-set summary follows the user's selection (no more silent "Main: Mistral Large" while picker says Magistral).
- **Per-turn model indicator in chat footer (#460)** — The SSE `turn_end.model` was already extracted for cost; now it surfaces next to "X tokens · $0.04 · `mistral-large-2512`" so users can see which model produced each reply (relevant when the auto-downgrade flipped to Small for a simple task).
- **API-key + Test-connection hidden on managed tier (#462)** — On managed the CP supplies the LLM key; a disabled-but-visible input was misleading. Replaced with a short note: "API-Schlüssel werden von deinem Managed-Hosting-Plan bereitgestellt."
- **Tier-set summary tracks `default_tier`** — Picking Magistral in the tier picker now flips "Main: Mistral Large" → "Main: Magistral Medium" in the summary block. (#461)

### Removed

- **`/app/settings/llm/keys` route** — The 3rd-party API-key CRUD (Tavily, DataForSEO, etc.) moves to `/app/hub?section=keys` (Automation Hub gains a 4th tab "API-Schlüssel" next to API Profiles). The old URL 301-redirects so bookmarks survive. The LLMSettings sub-nav loses its "API keys" link — that page now owns only Provider + Key + Model + Advanced/Memory sub-routes. (#463)

### Security

- **`PROVIDER_KEY_SLOTS` allowlist** — Centralises the BYOK secret slots (`ANTHROPIC_API_KEY`, `MISTRAL_API_KEY`, `OPENAI_API_KEY`, `CUSTOM_API_KEY`) so future provider additions extend one set instead of N call-sites. `MISTRAL_API_KEY` + `CUSTOM_API_KEY` are now in `BYOK_USER_WRITABLE_SECRETS` (was Anthropic + OpenAI only). (#458)
- **Prompt-injection guard on `modelIdentityContext`** — Sanitises the user-controllable `openai_model_id` before interpolating into the system prompt's markdown code-span. Strips backticks, newlines, and any non-`[a-zA-Z0-9._:-]` char; caps length at 64. Managed users can write `openai_model_id`; without sanitisation an attacker could inject prompt instructions into the system role. (#458 round-3)

### Migration Notes

- `/app/settings/llm/keys` → `/app/hub?section=keys` (301)
- Existing `/app/settings/keys` redirect chain still works (it 301'd to `/app/settings/llm/keys`, which now 301s to `/app/hub?section=keys`)
- Vault slot semantics unchanged — Mistral keys stay in `MISTRAL_API_KEY`, Custom in `CUSTOM_API_KEY`, etc.
- No env-var changes required. Self-host users with `ANTHROPIC_API_KEY` set continue to work; switching to Mistral now reads `MISTRAL_API_KEY` (vault or env) instead of falling back to the Anthropic env var.

### Acknowledged Behaviour Changes

- **Mistral Magistral as default_tier** — Users can now set Magistral Medium as their orchestration tier (it was previously unreachable via UI on Mistral). Cost is ~$2 in / $5 out per 1M tokens — similar to Mistral Large but routes through the reasoning-heavy variant.
- **Auto-downgrade still applies on Mistral** — Simple turns continue to route to `mistral-small-2603` regardless of selected default_tier; the footer indicator now makes this observable. Disabling auto-downgrade is in the deferred Settings v3 sprint.

## 1.5.1 — 2026-05-18

Patch — **IA Consolidation V2** + **chat-reliability hardening**. Three-phase shell refactor shipped as one patch: Phase 1 collapses the dual-home `ConfigView` SSoT drift (1100+ LOC deleted, 12 settings now have single canonical pages, schema switches to `.strict()`); Phase 2 moves Activity into its own `/app/activity` root and repoints the footer cost/runs pills; Phase 3 finalizes Settings into 5 tier-conditional sections, splits Channels into 6 sub-routes, formalizes LLM sub-pages (Advanced/Memory), wires CommandPalette across all sub-routes, and deletes the deprecated Cost-Limits page. Mobile gets a net-new bottom-tab (Chat · Inbox · Activity · Intelligence · More). One canonical `formatCost` replaces three drifted implementations. Alongside the IA work, this release closes a chat-history-loss bug surfaced on rafael prod (#456): the agent loop now persists at every turn boundary instead of only end-of-run, the SvelteKit chat store's 404 recovery path now passes `threadId` so server-side eviction can't lose the conversation, and the SYSTEM_PROMPT carries a fabrication guardrail when memory_recall returns partial data. All legacy URLs 301-redirect — bookmarks survive.

### Changed

- **NEW top-level `/app/activity` route** — canonical home for Cost / Runs / History. Footer cost-pill and runs-pill now land here. Replaces the old `/app/hub?section=activity` sub-tab (auto-redirected for one release). (#422, #424)
- **`/app/hub` shrinks to 3 tabs** (Workflows / Tasks / APIs) — Activity tab stripped; legacy `?section=activity*` query-strings redirect to `/app/activity?tab=*`. (#425)
- **Settings 5 tier-conditional sections** — Main / Data / Workspace (Self-Host) / Access / Account. Workspace section hidden on Managed; tier-gating via `selfHostOnly` / `managedOnly` predicates with default-null managed-probe pattern. (#434, #435, #446)
- **Channel sub-routes** — `/app/settings/integrations/*` split into `/app/settings/channels/{mail,mail/rules,whatsapp,google,notifications,search}` + a hub index. Per-channel state stored in dedicated stores (`stores/integrations/*`). Mail-Rules gets its own route per Inbox-PRD pin. (#436, #448)
- **LLM sub-pages** — `/app/settings/llm/{advanced,memory}` carved out of LLMSettings. Data-driven sub-route nav array (designed for OpenAI-native Phase 4 reuse). (#447)
- **Tool-Toggles tier-conditional** — mounted at both `/app/settings/workspace/tools` (Self-Host) AND `/app/settings/privacy/tools` (Managed). Both routes always 200 OK; `SettingsIndex.keepItem()` hides the wrong one per tier — no async-redirect race. (#446)
- **Mobile bottom-tab** — new on smaller viewports: Chat · Inbox · Activity · Intelligence · More-Drawer. `AppShell.svelte` previously only carried the desktop nav-rail. (#426)
- **CommandPalette extended** — entries for all Phase 3 sub-routes (Workspace, Channels, LLM Advanced/Memory, Privacy, Account); tier-gating mirrors SettingsIndex. (#426, #449)
- **Footer Status-Panel** — pulls from `/usage/summary?period=today` (Voice STT/TTS included) instead of `/history/cost/daily`. One-time "now includes Voice" hint dismissed via localStorage. (#424)
- **Google OAuth post-callback** — self-host meta-refresh lands on `/app/settings/channels/google` directly (was `/app/settings/integrations`). One fewer redirect hop. (#448)

### Fixed

- **Chat history-loss on backgrounded sessions** — the agent loop now persists messages to `ThreadStore` at every stable turn boundary (after each assistant message and after every tool-result batch), not just at end-of-run. A container restart, OOM kill, or session eviction mid-loop no longer loses the in-flight conversation. Verified on staging via `message_count` growth per-turn (eager-persist hook in `agent.ts` + new `eager-persist.ts` helper with 8 unit-test contracts). Surfaced by rafael prod incident 2026-05-18. (#456)
- **404 session-recovery preserves thread continuity** — when the SvelteKit chat store hits a 404 on `/api/sessions/<id>/run` (engine restart, session TTL expired), the recovery path now passes the active `threadId` to `POST /api/sessions` instead of minting an empty thread, so the model rejoins the existing conversation with `resumed: true` in the response. (#456)
- **Anti-fabrication guardrail on partial memory recall** — when `memory_recall`, `read_file`, `data_store_query`, or KG entity lookup returns only part of what the user asked for, the SYSTEM_PROMPT now instructs the agent to surface what is known and ask for the rest, instead of padding the answer with plausible-sounding details. (#456)
- **`formatCost` collapsed to a single canonical implementation** — three drifted copies (sub-cent rounding, cents-style, locale-aware) reconciled into one helper. (#420)
- **Stale `update_check` setting** accepted via `passthrough` is now explicit in the config schema. (#421)
- **`BackupsView` no longer leaks response-only fields** (`capabilities`/`locks`/`managed`) back into `~/.lynox/config.json` on save. (#421)

### Removed

- **`ConfigView.svelte` deleted** (1100+ LOC). 12 dual-homed settings now have a single SSoT in their extracted pages (LLMSettings Advanced/Memory, SecretsView, SystemSettings, CostLimits). (#421)
- **`/app/settings/{keys,apis,data}` stub routes** — replaced with SSR-301 redirects to canonical homes (`/settings/llm/keys`, Automation → APIs, Intelligence → Data). (#418)
- **`AutomationHub.svelte` Activity tab** — Activity has its own root now. (#425)
- **`CostLimits.svelte` deleted** (-227 LOC) plus `/app/hub/cost-limits` route — replaced by `/app/settings/workspace/limits` (Self-Host) + `/app/settings/llm/advanced` (context-window). Legacy URL 301-redirects. CostLimits-only i18n keys pruned; shared `cost_limits.saved/save/loading/...` keys retained for use by Workspace and LLM views. (#450)
- **`IntegrationsView.svelte` deleted** (-661 LOC) — superseded by 6 per-channel components (`MailSettings`, `WhatsAppSettings`, `GoogleSettings`, `NotificationsSettings`, `SearchSettings`, `ChannelHub`). Library barrel keeps `IntegrationsView` as an alias to `ChannelHub` for downstream compatibility. (#448)

### Security

- **`LynoxUserConfigSchema` switched from `.passthrough()` to `.strict()`** — unknown PUT-fields are now rejected (HTTP 400) instead of silently persisted. Closes the ghost-write vector documented in V2 Round-1 Security review. (#421)
- **`max_context_window_tokens` upper-bound** — `z.number().int().positive().max(1_000_000)` on the user-config schema. Blocks an attacker on a Managed instance from setting an unbounded value (the field is allowlisted in `MANAGED_USER_WRITABLE_CONFIG`); the schema is the load-bearing gate. Matches the largest UI radio option + Sonnet 4.6 frontier window. PRD-IA-V2 Security S3. (#447)
- **New invariant test:** `disabled_tools` cannot enable a tool that `excludeTools` blocked (regression-pin for V2 Round-1 S7 finding). (#419)
- **`PUT /api/config` audit-log** — every write emits a `config_update` SecurityAudit event with `fields_changed: [keys]` (keys-only, never values, so the trail cannot leak secrets or spend caps). PRD-IA-V2 Security S4. (#435)
- **All settings-route 301-redirects use hardcoded path/tab allowlists** — no user-input pathname passthrough (Round-1 S2 mandate). Applies across `/app/settings/*` stubs, `/app/hub?section=activity*` → `/app/activity` redirects, AND the new `/app/settings/integrations/*` → `/channels/*` redirect chain via `assertChannelTarget` helper + 30 contract tests covering URL-encoded, whitespace, case-sensitivity, and trailing-slash payload classes. (#418, #425, #448)
- **`POST /api/sessions` threadId is UUID-validated and case-normalised** — module-scope lowercase-only regex + `rawThreadId.toLowerCase()` before the gate. Closes a silent thread-fork via uppercased UUID (SQLite TEXT PRIMARY KEY uses BINARY collation, so `DA65E649-…` would have minted a parallel thread next to `da65e649-…`). Caught by /pr-review round-3 Security on #456. (#456)

### Migration Notes

- `/app/settings/config` → `/app/settings/llm` (+ tab-aware sub-targets, 301)
- `/app/settings/keys` → `/app/settings/llm/keys` (301)
- `/app/settings/apis` → `/app/automation?tab=apis` (301)
- `/app/settings/data` → `/app/intelligence?tab=data` (301)
- `/app/hub?section=activity*` → `/app/activity?tab=*` (301)
- `/app/hub/cost-limits` → `/app/settings/workspace/limits` (301; max_context_window_tokens moves to `/app/settings/llm/advanced`)
- `/app/settings/backups` → `/app/settings/workspace/backups` (301)
- `/app/settings/system?part=security` → `/app/settings/workspace/security` (301)
- `/app/settings/integrations/tools` → `/app/settings/workspace/tools` (301 — Self-Host nav surfaces this; Managed surfaces `/app/settings/privacy/tools` instead, both routes always render)
- `/app/settings/mobile` → `/app/settings/account/mobile` (301)
- `/app/settings/integrations` → `/app/settings/channels` (301)
- `/app/settings/integrations/{mail,mail/rules,whatsapp,google,notifications,search}` → `/app/settings/channels/<name>` (301)
- Footer cost/runs pills now land on `/app/activity` (were `/app/hub?section=activity`)
- Bookmarks survive — every old route 301-redirects.

### Acknowledged Behaviour Changes

- `ColdStartBanner` migration-estimate now renders in en-US format (`$0.42`) instead of de-CH (`0,42 $`). Consistency win across all cost displays via the unified `formatCost`; matches PRD-IA-V2 Non-Goal "no locale-aware currency rendering".
- Empty Activity-Overview state shows a zero-state CTA ("Noch keine Runs heute — starte einen Chat") instead of $0.00 placeholders.

## 1.5.0 — 2026-05-16

Minor — **HN-launch readiness release**. Settings & Usage IA Refactor (23 PRs landed 2026-05-15) consolidates the post-onboarding surface around six top-level tabs. **Telegram integration removed** as a customer-facing feature (data sovereignty + attack-surface reduction; companion still available in self-hosted core). API Setup v2 graduates with Smart Bootstrap from `docs_url`. LLM Settings page + model catalog endpoint replace the BYOK-by-env-only flow. Tool-Toggles + server-side enforcement land as a first-class security primitive. README + first-run + provider matrix polished for HN.

### Added — Settings & Usage IA Refactor (Phases 0-5 + T1-T7)

- **Six top-level tabs** with route migrations: Chat / Hub / Intelligence / Automation / Voice / System. Replaces the legacy `/app/settings/*` grab-bag. (#387, #389, #391, #393)
- **Activity Hub elevated to `/app/hub`** (route migration with redirects). Cost & Limits surface at `/app/hub/cost-limits`. (#387, #389)
- **System settings top-level page** consolidates security, residency, sessions, build version. (#393)
- **Voice + Privacy & Data top-level settings pages** — split out of the legacy compound surface. (#391)
- **LLM Settings page** with `/api/llm/test` connection probe + per-provider key entry; replaces the env-only BYOK flow. (#390)
- **Custom-Endpoint Confirm-Banner** on LLMSettings reduces foot-shotgun risk when wiring LiteLLM bookmarks. (#399)
- **Multi-Custom-Endpoint Registry** (LiteLLM-style bookmarks) — users save multiple OpenAI-compatible endpoints with per-bookmark display name + key. (#402)
- **Tool-Toggles + server-side enforcement** — per-tool enable/disable that the engine respects on dispatch, not just the UI. Security gaps from /pr-review closed in #405. (#401, #405)
- **Bugsink toggle** in web-ui (schema + engine wiring + UI) — self-hosted users can flip error reporting from settings instead of env. (#400)
- **API profile delete** UX (#375). API Profiles moved to Automation tab (#382). DataStore moved to Intelligence tab (#376).
- **Reserve `/app/settings/integrations/api-store/` sub-route** for the upcoming managed API-Profile store. (#392)

### Added — API Setup v2 + Smart Bootstrap

- **API Setup v2 default-on** — agent-driven setup graduates from feature-flag to default. (#395)
- **Smart Bootstrap from `docs_url`** (Phase B) — agents bootstrap a profile by reading the API's docs page directly when no OpenAPI spec exists. (#367)
- **Linked-section fan-out** in `docs_url` bootstrap — 1-2 follow-up reads when the landing page references nested endpoints. (#369)
- **`tool_progress` events during `docs_url` bootstrap** — the StreamingActivityBar surfaces what the bootstrap is currently reading. (#368)
- **API Profile v2 schema + loader migration** — new shape: `auth_scheme`, `limits`, `parallel_ok`, `output_volume`, `dos`, `donts`, `sub_agent_strategy`. (#365)
- **Per-call cost emission + render** from profiled APIs (Phase E). (#373)
- **`/api/llm/catalog` endpoint** — canonical LLM model catalog (replaces hard-coded UI lists). (#386)
- **`/api/usage/current` SSoT endpoint** — single source of truth for current usage; powers Cost & Limits and Status surfaces. (#388)
- **`/api/config` shape extended** with `capability` + `locks` — UI can render lock-icons for managed-policy-pinned settings. (#385)

### Added — HN-launch surface

- **README polish for HN** — multi-provider matrix, ELv2 framing, "NOT good at" honest-limits table, founder section. (#370)
- **First-run provider choices** aligned with HN-launch positioning (Anthropic + Mistral + Custom). (#371)
- **Provider matrix restructured** (Vertex dropped; Anthropic / Mistral / Custom-OpenAI-compatible primary). (#372)
- **AppShell sidebar redesign + Migration Wizard docs page**. (#362)
- **Walkthrough docs aligned** with the current provider set. (#374)
- **Chat rendering polish** — 4 findings bundled (#383).

### Added — Tests & CI

- **Staging-Smoke Playwright workflow + spec in `tests/smoke/`** — runs against `engine.lynox.cloud` after every release. (#398, #403)
- **F14 — vitest coverage for the Settings-Refactor sprint surface** (+41 new tests). (#408)

### Removed (breaking — customer-facing Telegram)

- **End-user Telegram integration killed** — `src/integrations/telegram/` channel-side surface removed (8 integration files + 553-line `telegram-bot.ts` deleted). `telegram_bot_token` + `telegram_allowed_chat_ids` removed from config schema + types. Managed plane stops provisioning bot tokens. Driven by: data-sovereignty posture for HN-launch, attack-surface reduction (Wave-4 callout), and the unified-inbox repositioning. **Migration:** existing managed customers with active Telegram are auto-migrated to email-only inbox; bot tokens revoked. **Rollback note:** v1.4.2 still references the removed config fields — downgrade after env-var removal will require operator to restore tokens manually. (#397)
- **`MANAGED_TELEGRAM_BOT_TOKEN` for ops alerting (Alerter/Gatus) is unaffected** — it lives in `pro/packages/managed` and is separate from the customer-facing channel. Ops alerts continue to flow through Telegram.

### Fixed

- **`api-setup`: steer agents to `docs_url` when OpenAPI spec is too large** — closes the bootstrap-budget false-positive that surfaced as HN-launch blocker. (#415, #379)
- **`api-setup`: support `auth.type="none"`** for public APIs (open-data + free LLM endpoints). (#414)
- **`api-setup`: wire ApiStore into ToolContext on fresh installs** (closes the "profile saved but never visible" path). (#413)
- **SetupBanner: show provider picker on BYOK starter**, not just self-host. (#412)
- **`llm-helper`: default to Sonnet engine-wide**, Haiku as override (was inverted). (#411)
- **Engine: mirror resolved Anthropic key into `process.env`** so downstream libraries that read from env see the key vault resolved. (#410)
- **`http-api`: allow managed users to set their own preference fields** (was 403 on managed-pool BYOK). (#409, #406, #396)
- **Security: close 3 Tool-Toggle enforcement gaps** surfaced by `/pr-review` on #401. (#405)
- **Auth: align engine session-cookie TTL with web-ui + roll on use** — closes the 7d/30d drift that caused random "Verbindung verloren" toasts on iOS Safari PWA. (#381)
- **Apply Sprint-Review follow-ups** (5 blockers + 9 nits in one bundle). (#407)
- **Entrypoint: warn when `~/.lynox/` has files owned by a different uid** — catches the docker-compose user-id mismatch upfront. (#380)
- **Hide CRM-overlap DataStore collections + drop stale empties at startup**. (#378)
- **Fix stale `labelKey` in Intelligence Data tab**. (#377)

### Refactored

- **Apply 4 nits from `/pr-review` on #402** (Multi-Custom-Endpoint Registry polish). (#404)
- **Consolidate hard-limit constants into `core/limits.ts`** — single source of truth for all $/req/day caps. (#384)

### Pro / Managed Hosting

- **Customer-facing Telegram killed** in managed plane — mirror of core #397. Existing customers auto-migrated. (pro #142)
- **`api_setup` helper pinned to Haiku** in public-demo container — bounds cost of demo bootstrap runs. (pro #143)
- **Tier-1 public-demo scaffold** — landing page + sandbox compose + safety ADR for `demo.lynox.cloud`. (pro #135)
- **CF Worker daily-cost kill-switch** for demo (cap #5 — auto-stop demo when daily cost exceeds threshold). (pro #136)
- **`/trust` landing page** for HN-launch posture (data-residency, ELv2, no-train commitments). (pro #134)
- **`/compare/vs-saas-stack`: honest-limits table** (where SaaS stacks are still better). (pro #139)
- **Pricing page BYOK list aligned** with launch lineup. (pro #138)
- **HN launch post drafts** — three angle variants. (pro #137)
- **`bootstrap migration-tracking` on first deploy** — fixes the bootstrap-path bug that broke v1.4.2 release-CP. (pro #131)
- **`devalue` + `postcss` bumped** — clears HIGH CVE audit findings. (pro #133)

### Docs & Internal

- **PRD: Settings & Usage IA Refactor (HN-launch)** — drove the 23 PRs. (pro #141)
- **B3 architecture blog: "Anatomy of a lynox agent run"** (EN draft). (pro #140)
- **PRD: ad-hoc sub-agent teams for business-case fan-out**. (pro #132)
- **Docs: Unified Inbox page**; archive WhatsApp Inbox doc. (#361)
- **Docs drift fix**: Bedrock → Vertex provider, version + cost-limit drift across getting-started. (#360)
- **Docs boundary**: relocate tier-routing strategy from public docs to internal PRDs; generalize WA-beta references. (#359)

### Dependencies

- **`svelte` 5.55.7 + `@sveltejs/kit` 2.60.1** (devalue 5.8.1). (#366)

## 1.4.2 — 2026-05-14

Patch — UI clarity for long-running agent turns + the root-cause fix for the "Verbindung zum Server verloren" toast that surfaced on a canary tenant + Wave 3/4 security and refactor convergence.

### Added

- **StreamingActivityBar**: sticky surface above the chat input — replaces the pulsing-dot indicator that scrolled out of view during minute-long tool calls. Shows current tool label, elapsed seconds (1s tick), and a soft "Verbindung scheint langsam" hint when the server heartbeat goes silent for >25s. Visible during any streaming activity except pending prompts. (#363)
- **24 new tool-activity labels** (DE + EN) — `web_crawl`, `web_research`, `crawl_batch`, `write_artifact`, `spawn_agent`, `knowledge_*`, `contacts_*`, `deals_*`, `datastore_*`, `api_setup`, `read_file`, `write_file`, `ask_secret`, and more. Closes the generic "Arbeitet..." fallback users saw during research-heavy turns. (#363)
- **Responsive chat width**: `max-w-3xl` (768px) on mobile/tablet → `lg:max-w-4xl` (896px) → `xl:max-w-5xl` (1024px). Reclaims the empty real estate where the right-rail context sidebar used to live. (#364)
- Server SSE protocol: `event: heartbeat` every 10s carrying `{sentAt}` replaces the silent `: keepalive` comment. Client uses it to bump `lastEventAt` and detect stalled streams without a hard disconnect. (#363)
- Staging Greenmail end-to-end smoke scaffolding (#341, #342, pro #123)

### Fixed

- **Orphan stream timer and body-size reject paths** — the root cause for the "Verbindung zum Server verloren" toast that surfaced on a canary tenant. The 30-min SSE timer was not cleared on normal stream end, killing random later sessions. (#334)
- Telegram pending input resolved when the stale-prompt timer aborts the run (#336)
- Plan finalization gates on `completedAt`, not map presence — fixes the rare case of a plan finalising at step 2 of N (#335)
- Inbox: consolidation pass + textarea autogrow + session-expired banner (#337)
- Inbox: wrap + refresh-button + accurate counter restored (#332)
- ToolContext threading — `api_setup` OpenAPI fetch (#355) and `web_research` content extractor (#357) now receive the request-scoped context that earlier Wave 4 work introduced
- Google OAuth state bound to a signed HttpOnly cookie (#351)
- **Multi-tenant security (Wave 3)**: inbox `getItem` + 6 mutations scoped to `tenant_id` (#339); admin-gating + destructive-tool gaps closed (#338); tactical bundle of 4 audit findings (#340); 3 review nits across Wave 2/3 (#344); tenant-id threading from api.ts handlers through subsequent mutations (#343)

### Refactored (Wave 4 — Session-centric + declarative-by-default convergence)

- Engine `init()` split into 7 phases (#356, addresses the god-method finding)
- Config singletons → `ToolContext` (Wave 4.1 step 1, #350)
- Session counters → `Session` (Wave 4.1 step 2, #352)
- Outbound approvals + prompt dedup → `Session` (Wave 4.1 step 3, #353)
- Orchestrator types extracted to `src/types/orchestration` (#354)
- `sessionCostUSD` → `SessionCounters.costUSD` (#358)
- Declarative destructive flag on `ToolEntry` (#347)
- Declarative scope at route registration (#346)
- Single channel-wrap helper for untrusted external data (#345)

### Pro / Managed Hosting

- **Traefik websecure `idleTimeout` pinned to 300s** — defense-in-depth for long-running SSE turns (pro #129)
- **Stripe webhook dedup persisted across CP restarts** — prevents replay-on-restart duplicate billing actions (pro #119)
- **Billing lifecycle math + customer messaging** corrections (pro #120)
- **Provisioning optimistic-lock state-machine** transitions — Hetzner double-create gate (pro #121)
- **Per-file migration tracking** via `managed_drizzle_migrations` table — re-running the apply loop is idempotent now (pro #122)
- Gatus: `GATUS_OPS_ENABLED='false'` actually disables (zod-coerce trap fix, pro #125); env-guard for the ops config writer on staging (pro #124)
- Greenmail in staging CP compose for inbox e2e smoke (pro #123)

### Security / Dependencies

- `hono` override bumped to 4.12.18 + `ip-address >=10.1.1` (closes audit findings, #349 + pro #126)
- Channel-wrap helper for untrusted-data boundaries unified into a single implementation (#345)

### Docs & Internal

- PRD: **Unified API Profile v2 + sub-agent fetching** drafted (sprint-ready for v1.5.0). Smart bootstrap via docs-URL reading, constrained `fetch_url` tool for sub-agents with spawn-time URL allowlist, advisory routing layer, per-call cost display (Phase E, v1.6.0). (pro #130)
- Positioning: managed-plan provider-routing section (pro #128)
- CHANGELOG categorisation script per conventional-commit prefix (closes `project_cut_release_categorise`, #348)

## 1.4.1 — 2026-05-14

Patch — version-sync only. v1.4.0 `release-cut` bumped `core/package.json` and `pro/packages/managed/package.json` to 1.4.0 but missed `core/packages/web-ui/package.json`. StatusBar's stale-bundle check fires when the bundle's build-time `BUILT_VERSION` (baked from web-ui/package.json) does not match the engine's runtime `/api/health.version` (= core/package.json), so users on v1.4.0 saw a permanent "Neue lynox-Version verfügbar" toast that did not clear on reload (rebuilt bundle still had BUILT_VERSION=1.3.12 baked in). v1.4.1 aligns the three packages and patches the `/release-cut` skill so future releases bump all three together.

### Fixed

- **Web UI permanent stale-bundle toast on v1.4.0** — see above. (#331)

## 1.4.0 — 2026-05-14

Major feature release: Unified Inbox (Phase 1–4) ships as the new default mail surface, plus the Wave 1 security audit fixes.

### Added

- **Unified Inbox** — single inbox for mail + WhatsApp, classifier-driven triage with confidence-aware zone rail, snooze-with-mail-anchor, schedule-send, push notifications, three-pane reading-first layout with mail-context sidebar. Built across Phase 1a/1b/2/3/4. (#266, #268, #270, #271, #272, #274, #275, #283, #285, #286, #287, #288, #290, #291, #292, #293, #309, #314, #316, #318, #319, #320, #321, #322, #323)
- **Mail-anchored reminders** — `setSnooze(item, until, unsnoozeOnReply)` re-surfaces inbox items either at a wall-clock time or when the contact replies; standalone reminders without mail anchor work the same way via the new `inbox-reminder-poller`. Erinner-mich button in Reading-Pane + Triage rail, Kopilot top-card surfacing the next reminder, slash-command from chat. (#314, #316, #318, #319)
- **Push notifications for inbox** — classifier outcome → web-push to registered devices (per-account toggle + quiet hours + throttle), opt-in from the Integrations page. (#323)
- **Send Later** — schedule-send dropdown on the draft pane, persistent SQLite-backed poller fires the actual send. (#320, #321)
- **Operator-driven cold-start** — empty-inbox state shows a "fetch existing mail" button that triggers backfill against the connected mail account; the same path auto-fires on first account connect. (#275, #287, #288)
- **Sidebar redesign** — icon-rail hub with Chat / Automation / Intelligence / Artefakte sections, sticky-prompt anchor + persistent pipeline-status bar. Checkbox + Icon design-system primitives, brand-tinted scrollbar. (#265, #310, #311)
- **`mint-staging-cookie.sh` helper + phase-4 visual smoke spec** — Playwright runs against `engine.lynox.cloud` with a pre-minted 30-day staging cookie. (#326)
- **Sidebar improvements** — kebab menu rendered at root with fixed positioning (escapes the `<li overflow-hidden>` clip), Intelligence sub-nav + chat-thread kebab + search + icon polish. (#305, #306)
- **LLM cost observability for /draft/generate** — per-tenant audit row + rate-limit visibility. (#313)
- **Playwright smoke job in CI** — every PR runs the full smoke suite against a freshly built docker-compose stack. (#298, #300, #301)
- **Greenmail integration tests in CI** — IMAPS / SMTPS round-trip against the live test container as part of every push. (#300)

### Changed

- **Sidebar flattened** — Chat / Automation / Intelligence / Artefakte at the top level; sub-nav promoted to icon rail. (#265, #310)
- **Sidebar inbox entry** swapped to `/app/inbox` (was the legacy WhatsAppInboxView). (#274)
- **Mobile UX overhaul** for the Phase 3 layout — reading-pane header, thread expand affordance, draft footer alignment, sidebar safe-area handling. (#302, #303, #304, #307, #308)
- **`bash` air-gapped isolation now actually fires in production.** The previous module-level `_isolationEnvOverride` + `setIsolationEnv()` setter pair was registered but never invoked by any production code; `spawn_agent({ isolation: { level: 'air-gapped' } })` therefore inherited the full parent env (provider keys, vault key, Telegram token). The handler now reads `agent.isolation` directly, collapses env to `PATH`/`HOME`/`TMPDIR` for air-gapped, merges `isolation.envVars` for scoped/sandboxed. **BREAKING**: `setIsolationEnv` and `clearIsolationEnv` exports removed from `tools/builtin/index.ts` — no production caller existed; if your custom wiring used them, migrate to setting `agent.isolation` directly. (#329)
- **`MigrationImporter` constructor signature** — `httpSecret` parameter removed (was unused after the handshake-token refactor); `startHandshake` now takes the per-session migration token as an explicit argument. **BREAKING** for any external consumer constructing `MigrationImporter` directly. (#328)
- **Removed bedrock references** — managed-tier docs + provider strings now consistently reference Mistral (eu-sovereign) and Vertex; the historical `managed_bedrock` path stays in the provider enum for back-compat but is deprecated. (#267)

### Fixed

- **Migration handshake signature verification** — the X25519 ECDH handshake used by the zero-knowledge migration flow signed the server's ephemeral public key with an instance-local HMAC, but the source side never called `verifyHandshake`. A network attacker between source and destination could substitute their own keypair in the handshake response and decrypt the full DB + vault stream. Source side now `verifyHandshake`s before deriving the transfer key; signing key derives from the per-session migration token (shared bootstrap secret) instead of each side's `LYNOX_HTTP_SECRET`. (#328)
- **`api_setup` bootstrap SSRF + DoS** — the tool fetched its OpenAPI URL via raw `fetch()` with no protocol filter, no private-IP check, no redirect revalidation, no body cap, no timeout. An LLM-controllable URL could reach AWS/GCP metadata or the internal Docker bridge. Now routed through `fetchWithValidatedRedirects` + `readBodyLimited` with a 5 MB cap and 15 s AbortController. (#329)
- **Integration SSRF cluster** — three call sites were fetching/connecting to caller-influenced targets without checking they were on the public internet: (1) Google service-account JWT mint trusted `token_uri` from the operator-supplied JSON (could be redirected to GCP metadata), (2) WhatsApp `fetchMedia` trusted the URL returned by the Meta API (compromised/MITM'd response could redirect internal), (3) custom mail accounts opened TCP/TLS to any user-supplied IMAP/SMTP host (authenticated user could probe the internal Docker network). New shared `core/network-guard.ts` module with `isPrivateIP` (IPv4 + IPv6 + IPv4-mapped IPv6 hex form incl. `::ffff:7f00:1`), `assertPublicHost`, `assertPublicUrl`, `fetchWithPublicRedirects`. (#330)
- **Inbox: `cc`/`bcc` forwarded to send-reply handler.** Replies sent from the draft pane were dropping CCs and BCCs because the handler signature stopped at `{to, subject, body}`. (#284)
- **Inbox: snoozed items hidden from list + counters** until the snooze expires. (#285)
- **Inbox: sensitive-content masker re-runs on refresh path** when `sensitive_mode = 'mask'` — previously the masker only fired at classification time, so a body refresh re-exposed the raw text. (#312)
- **Inbox: collapsible context sidebar** + click-outside dismisses the menu + monochrome icon scheme aligned with the rest of the rail. (#327)
- **Web UI: permission card stays visible** after click until the tool actually starts, instead of vanishing on the same render tick. (#260)
- **Web UI: 409 fast-fail when client already holds a pending prompt** — prevents a double-submission when the previous turn's `ask_user` is still open. (#261)
- **Web UI: chat input gated on pending prompt**, duplicate anchor hidden. (#259)
- **Smoke runner: session cookie propagated** to Playwright's `APIRequestContext` so API-only calls inside browser tests authenticate correctly. (#298)
- **Tool-call row state** — running / done / error visual state propagated through grouped rows. (#262)

### Security (Wave 1)

This release closes 13 Critical/High findings from the codebase-wide audit run on 2026-05-13. All five Wave 1 PRs (#328, #329, #330 in core; #117, #118 in pro) ship together. See the Changed/Fixed sections above for #328/#329/#330; pro's #117 splits the managed admin token so an admin-token leak no longer forges customer sessions or Google OAuth state, and #118 envelope-encrypts four operator-sensitive Postgres columns with AES-256-GCM keyed off the new **required** `MANAGED_SECRETS_MASTER_KEY` env var.

Production deploy of the pro changes requires:
1. Generating the prod `MANAGED_SECRETS_MASTER_KEY` (`openssl rand -hex 32`) and backing it up to the secret store BEFORE deploying — losing this key makes all tenant backups un-decryptable.
2. Optionally generating `MANAGED_CUSTOMER_SESSION_SECRET` and `MANAGED_GOOGLE_OAUTH_STATE_SECRET` (HMAC fallback works without, but dedicated secrets are recommended for production).
3. A maintenance window that tolerates a 1h forced customer re-auth (#117 invalidates currently-active customer sessions; OTP re-login resolves it).


## 1.3.12 — 2026-05-06

### Added

<!-- new features -->

### Changed

<!-- existing features touched -->

### Fixed

<!-- bug fixes -->

<!-- Reference — raw commits since v1.3.11 (delete this block before saving):

Core:
- fix(web-ui): warm silent.wav + retry iOS TTS first play() (#257)
- fix(web-ui): use <video playsinline> for TTS on iOS Safari (#256)

Pro:

-->
## 1.3.11 — 2026-05-05

### Fixed

- **iOS PWA serving stale HTML indefinitely** — root cause of the symptoms Rafael caught canarying v1.3.10: tapping the "Update verfügbar" toast didn't actually load the new bundle, voice messages reloaded the page in a flicker without sending, and the iOS-audio fix from v1.3.10 never took effect on his iPhone PWA because he was still running pre-v1.3.10 code. The HTML response was missing `Cache-Control` entirely, so iOS WKWebView picked a heuristic max-age and kept serving the same cached `index.html` — `location.reload()` and `location.replace(?_v=…)` both got satisfied from cache. Hooks now set `Cache-Control: no-store, must-revalidate` on `text/html` responses (hashed `_app/immutable/*` assets are unaffected — they remain long-cacheable since the filename changes per build). The StatusBar stale-bundle toast also switched its handler from bare `location.reload()` to `location.replace(?_v=<sha>)` matching the cold-start guard, so users with currently-cached HTML can still recover via the toast. After this lands, one final close+reopen of the iPhone PWA picks up the no-store header; from then on, all future updates apply smoothly with no manual gesture. (#255)

## 1.3.10 — 2026-05-05

### Fixed

- **iOS TTS audio playback** — the speak button (per-message + auto-speak) returned audio chunks from the server but stayed silent on iOS PWA / Safari. Root cause: `AudioContext` was constructed AFTER `await fetch('/api/speak')`, so the user-gesture flag was already consumed by the time iOS WebKit decided whether to allow audio. Now the context is created + resumed synchronously at the top of `playSpeech`, before any await, and reused across the session (instead of close-and-recreate per call). Active source nodes are tracked in a Set so `stopSpeech` can cancel without closing the context. A per-run token guards the final-source `ended` listener so a stop()-induced ended dispatch can't reset the next utterance's state mid-play, and a post-fetch state check surfaces `blocked` if iOS auto-suspended the context between plays. Caught on canary verification of v1.3.9 by Rafael — affects every iOS user. (#254)

## 1.3.9 — 2026-05-05

### Added

- **Pipeline status v2** — sticky prompt anchor + persistent pipeline-status bar in the chat composer. Two-layer design: PromptAnchor handles ask_user / ask_secret prompts surfacing above the input, PipelineProgress shows DAG step state. Default-on; library consumers can opt out via `configure({ pipelineStatusV2: false })`. (#236, #240, #245)
- **`ask_user` from pipeline sub-agents** — pipeline steps can now invoke `ask_user` and `ask_secret`; the prompt routes back through the parent session's SSE stream tagged with the originating step. Autonomous runs continue to strip these tools at the validator. (#244)
- **`task_update` schedule fields** — `run_at` and `schedule` fields are now mutable, enabling rescheduling without delete-and-recreate ("verschiebe das auf in 10 minuten"). (#243)
- **`build_sha` in `/api/health`** — runtime-visible commit hash for deploy verification, image-tag rollouts, and stale-bundle detection. (#238)

### Changed

- **STT default lands transcripts in the input box** — voice transcription now defaults to review-then-send instead of auto-send. Users can flip the toggle in the status bar; setting persists. (#237)
- **Right sidebar (ContextPanel) hidden by default** while it's being reworked. Library consumers can opt in via `configure({ contextPanelEnabled: true })`. (#249)
- **Mic button always visible** regardless of input state or auto-send toggle. Voice is a primary capability and shouldn't disappear behind state. (#249)

### Fixed

- **Per-turn time injected into every user message** — agent now sees wallclock-accurate `[Now: <iso>; user local <local> <tz>]` instead of relying on the hour-truncated cached value, fixing the 2026-05-05 incident where "in 5 min" tasks landed in the past. Cache-safe (lives in user message, not system prefix). (#242, #246, #248)
- **Scheduled times present in user's local timezone** — agent reply renders "14:00 Uhr" (CEST) instead of "12:00 Uhr" (UTC) when user is in Europe/Zurich. Tool inputs (`run_at`, `schedule`) stay UTC-encoded; the disambiguation is now spelled out in the system prompt with a worked example. (#246, #248)
- **Stale-bundle recovery for warm tabs and PWA cold-start** — StatusBar toast fires when the bundle's baked SHA differs from `/api/health.build_sha` (catches same-version different-build deploys). Inline `<script>` in `app.html` runs before any chunk loads to recover iOS PWA cold-starts whose cached chunks 404 against the new server. (#251, #252)
- **Per-turn time marker no longer leaks into rendered chat bubbles** — the `[Now: ...]` context for the LLM was visible verbatim in the user's message bubble after thread replay. Stripped at render time; voice messages also regain their mic-icon visualisation. (#250)
- **STT mic stayed hidden when text was in the input + auto-send off** — the symmetric case to PR #241 (which fixed auto-send-on with text). Drop the per-mode gate entirely. (#249)
- **Vite envPrefix widened to `PUBLIC_*`** — `import.meta.env.PUBLIC_*` was silently undefined, breaking the canary flag. (#239)
- **Generic placeholders for IMAP account id + display name** — the form previously hardcoded "rafael-gmail" / "Rafael — Gmail" for every tenant. Now reads "my-gmail" / "My Gmail". (#247)
- **Haiku no longer requested with extended thinking** — model rejects both manual and adaptive thinking modes; force-disabled regardless of caller config. (#231)
- **Image upload capped at Anthropic's 5 MB vision limit** — the base64 payload itself, not the decoded bytes. Returns a typed 413 with a friendly message instead of the raw provider 400. (#230)
- **Orchestrator phase computation guard** — protects against malformed persisted manifests that would otherwise hang in `computePhases`. (#229)
- **Agent message preserved on abort** — user message no longer lost from history when an agent run is aborted mid-stream. (PR carry-over from #228)

### Pro / Managed

- **Fleet rollout hardening** — sequential rollouts (`BATCH_SIZE=1`) by default, warmup gate refuses fleet rollouts within 60 s of CP restart, rollout health check verifies version match (not just HTTP 200), and non-semver `:staging` rollouts compare against `build_sha` instead of mismatching the version-string check. (#90, #91, #92, #94)

<!-- Reference — raw commits since v1.3.8 (delete this block before saving):

Core (in PR order):
- feat(web-ui): persistent pipeline status + sticky prompt anchor (#236)
- feat(web-ui): land STT transcript in input box, not auto-send (#237)
- feat(engine): expose build_sha in /api/health for rollout verification (#238)
- fix(web-ui): widen Vite envPrefix to include PUBLIC_* (#239)
- refactor(web-ui): drop PipelineStatusBar — two-layer design (#240)
- fix(web-ui): keep STT mic available with text in input when auto-send is on (#241)
- fix(core): inject precise current time per turn (cache-safe) (#242)
- feat(tools): task_update can reschedule via run_at + schedule (#243)
- feat(orchestrator): ask_user inside pipeline steps (#244)
- feat(web-ui): default pipeline-status-v2 on, retire canary plumbing (#245)
- fix(core): present scheduled times in user's local timezone, not UTC (#246)
- fix(web-ui): use generic placeholders for mail account id + display name (#247)
- fix(core): clarify storage=UTC vs display=local in time-aware prompts (#248)
- fix(web-ui): hide right sidebar by default + keep mic always visible (#249)
- fix(web-ui): strip per-turn [Now:…] marker from rendered chat bubbles (#250)
- fix(web-ui): toast on stale-bundle SHA mismatch, not just version (#251)
- fix(web-ui): cold-start stale-bundle guard for mobile PWA (#252)

Pro:
- fix(managed): rollout health check verifies version match, not just 200 (#90)
- fix(managed): default rollouts to sequential (BATCH_SIZE=1) (#91)
- fix(managed): refuse fleet rollouts when CP has been up <60s (warmup gate) (#92)
- fix(managed): verify build_sha for non-semver rollouts (#94)
-->

## 1.3.8 — 2026-05-01

### Added

<!-- new features -->

### Changed

<!-- existing features touched -->

### Fixed

<!-- bug fixes -->

<!-- Reference — raw commits since v1.3.7 (delete this block before saving):

Core:
- chore(deps): bump docker/build-push-action from 6 to 7 (#217)
- chore(deps): bump dependabot/fetch-metadata from 2 to 3 (#216)
- chore(deps): bump actions/github-script from 7 to 9 (#218)
- chore(deps): bump nodemailer and @types/nodemailer (#221)
- chore(deps): bump @huggingface/transformers from 3.8.1 to 4.2.0 (#220)
- chore(deps): bump email-reply-parser from 1.9.4 to 2.3.5 (#225)
- chore(deps): bump the minor-and-patch group with 6 updates (#219)
- chore(deps): bump @rolldown/binding-darwin-arm64 (#224)
- test(mail/triage): add real-world body-clean fixtures (#227)
- feat(bench): model + config benchmark suite + xhigh effort tier (#226)
- feat(web-ui): Usage Dashboard as Activity tab + status-bar link (#112)
- chore(deps): bump aquasecurity/trivy-action (#215)
- chore(deps): auto-merge non-major dependabot PRs (#214)
- chore(deps): bump marked from 17.0.5 to 18.0.2 (#33)
- chore(deps): bump docker/build-push-action from 6 to 7 (#31)
- chore(deps): bump pnpm/action-setup from 4 to 6 (#30)
- chore(deps): bump the minor-and-patch group across 1 directory with 21 updates (#161)
- chore(deps): bump aquasecurity/trivy-action from 0.35.0 to 0.36.0 (#194)
- feat(web-ui): manual compact button in context banner (#145)
- fix(web-ui): queued messages visible on mobile + per-item remove (#208)
- feat(web-ui): smart auto-scroll in ChatView (#207)
- fix(web-ui): harden markdown rendering against overflow + sloppy fences (#209)
- fix(web-ui): dynamic fence length for inline artifact chip wrap (#144)
- test: include packages/web-ui tests in root vitest run (#210)
- fix(tools/http): share one outbound-consent prompt across parallel calls (#146)
- fix(google-docs): drop redundant in-tool confirmation that hangs create (#206)
- fix(agent): preserve user message on abort to fix history loss (#205)
- fix(http-api): take over stale runs parked on pending prompts (#213)
- fix(web-ui): truncate long option labels in active prompt tab (#212)
- fix(web-ui): show question text in active prompt tab (#211)

Pro:
- chore(release): v1.3.7 (#88)
-->
## 1.3.7 — 2026-04-28

### Added

- **Spawn input validation** — `spawn_agent` now hard-caps caller-supplied values: max 10 agents per call, `max_turns` 1–50 (integer), `max_budget_usd` 0–50, `name` 1–64 chars (no control characters), `task` 1–16 K. JSON-schema mirrors the runtime checks; `additionalProperties: false` on the top level. Defensive floor in `estimateSpawnCost` so a malformed `max_turns` cannot return a negative estimate that would credit the session-budget counter (#198, #201).
- **Canary build CI** — Pushes to `feat/**`, `fix/**`, or `canary/**` publish two docker tags (`branch-<slug>` and `sha-<short>`) without ever touching a running instance. Pairs with managed-side canary pinning (lynox-pro #87) so a single instance can be held on a pre-release branch image while the fleet stays on `:latest` (#203).
- **GreenMail adversarial mailbox fixtures** — broadens mail integration coverage for malformed/edge-case messages (#192).

### Changed

- **Realistic spawn cost estimate** — `estimateSpawnCost` now models output as `OUTPUT_FILL_RATIO (0.3) × model.maxOutput` per turn (was naive worst-case ×1.0), and the default per-spawn iteration cap drops from 20 to 10. A typical 3-Sonnet-researcher fan-out estimates ≈ $2.52 instead of $15+, so legitimate patterns no longer trip the session ceiling (#197).
- **Mail tool hardening** — per-tool rate limits + per-recipient dedup in send paths (#188); persisted default mailbox is preserved when its provider fails to load (#187); Gmail OAuth watcher tightens cursor + provider lifecycle (#185); body decoder accepts more charsets (#189); address-list parser hardened with documented flag semantics (#191).
- **Google Workspace auth** — service-account token cache (#184) + coalesced concurrent refreshes (#182) — fewer round-trips on bursty access patterns.
- **Engine HTTP secret always set** — startup now ensures `LYNOX_HTTP_SECRET` is materialised before any handler comes up, eliminating the rare "secret missing" failure mode (#190).
- **Recoverable tool errors stay inline** — a tool error that the agent can retry no longer fires the global toast; it lives where it happened, in the chat thread (#195).
- **Spawn estimator + iteration cap as named constants** — `SPAWN_OUTPUT_FILL_RATIO`, `DEFAULT_SPAWN_MAX_TURNS`, single source of truth so the upfront estimator and runtime cap can never drift (#197, #202).

### Fixed

- **KG entity misclassification** — single-source-of-truth stopwords + a v2 post-filter at extraction time reject generic nouns and price expressions that the v1 regex+free-text pipeline was persisting; eval on 300 cases at 97.7 % precision / 94.6 % recall (#193).
- **Gmail envelope batching** — fewer Gmail API calls on first-page render via metadata batch fetch (#186).
- **GitHub Deployments tracking restored** — `release.yml` records a Deployment object after the pro-dispatch succeeds; the Deployments page froze at v1.3.3 after #142 dropped the production environment gate, this puts the visual record back without re-introducing a blocking reviewer step (#196).

### Internal

- Spawn JSDocs trimmed (no incident anecdotes); 3-researcher estimate test tightened to a narrow band around the documented expectation; `OUTPUT_FILL_RATIO` renamed `SPAWN_OUTPUT_FILL_RATIO` for prefix consistency (#201, #202).
- `.gitignore`: bench-models results excluded (#183).

### Managed (separate repo)

- **Per-instance canary pinning** — `pinned_tag` column on managed instances; fleet rollout (`startRollout`) skips pinned instances and records the skipped set on the rollout row for audit; new `PATCH /admin/instances/:id/pinned-tag` endpoint to set or clear the pin; `updateOne` refuses to deploy when the new tag would diverge from an existing pin, forcing the operator to update the pin first. End-to-end-validated on staging control plane.
- `pnpm/action-setup` bumped 4 → 6 to fix transient CI.

## 1.3.6 — 2026-04-27

### Added

<!-- new features -->

### Changed

<!-- existing features touched -->

### Fixed

<!-- bug fixes -->

<!-- Reference — raw commits since v1.3.4 (delete this block before saving):

Core:
- chore(mail): remove google_gmail tool + security hardening (PR4/4 reopen) (#180)
- fix(mail): persist default mailbox + UI toggle (PR3/4 reopen) (#179)
- feat(mail): OAuth-Gmail as first-class provider + boot migration (PR2/4 reopen) (#178)
- feat(mail): add auth_type foundation for multi-provider mailboxes (#174)
- docs(google-workspace): clarify project permission + Internal vs External (#172)
- fix(google-oauth): callback works under engine API CSP, idempotent on reload (#173)
- feat(mistral): startup health check surfaces 401/402/429 to stderr + Bugsink (#171)
- fix(ui): replace disabled-Modell-dropdown with info card on Managed EU (#170)
- fix(voice): diagnostic TTS error toasts (replace generic "Vorlesen fehlgeschlagen") (#169)
- fix(voice): mark non-Paul voices experimental + add non-EN hint (#168)
- fix(prompts,config): stop answered-prompt stack + spurious 403 on save (#167)
- fix(prompts): permission timeout overflow + KEY_NAME placeholder (#166)
- fix(markdown): heading edge-cases + visible mermaid render errors (#165)
- fix(ui): v1.3.5 moderate polish bundle (#164)
- fix(ui): v1.3.5 trivial polish bundle (#162)

Pro:
- chore: update google_gmail references to unified mail tools (#84)
- chore(release): v1.3.4 (#83)
-->
## 1.3.4 — 2026-04-24

### Added

<!-- new features -->

### Changed

<!-- existing features touched -->

### Fixed

<!-- bug fixes -->

<!-- Reference — raw commits since v1.3.3 (delete this block before saving):

Core:
- feat(web-search): explicit query formulation guidance for the agent (#159)
- feat(observability): engine-level attribution for web search (#158)
- feat(kg): default to v2 extractor + admin cleanup endpoint (#150)
- feat(tasks): flexible schedule + run_at, kill title duplication (#149)
- fix(web-ui): expose voice controls on mobile/touch (#148)
- fix(web-ui): clamp wide markdown content + iOS safe-area in StatusBar (#147)
- fix(web-search): stop mapping topic "it" to SearXNG categories=it (#152)
- feat(agent): strict JSON Schema validation at tool dispatch (#153)
- feat(web-search): Haiku-based post-provider reranker (opt-in) (#157)
- fix(task): guard against escaped JSON params inside description (#151)
- fix(searxng): widen general engine pool for query reliability (#154)
- chore(ci): collapse stale approval-gate comment block on dispatch-pro-release (#143)
- chore(ci): drop production environment gate on dispatch-pro-release (#142)

Pro:

-->
## 1.3.3 — 2026-04-23

### Added

- **API Store: declarative response shaping + OpenAPI bootstrap** (#140). Profiles can now carry a `response_shape` that deterministically projects, reduces, and caps verbose JSON responses before they enter the LLM history — path-based whitelisting, reducers (`avg`/`peak`/`avg+peak`/`count`/`first_n`/`last_n`), and array/string/body caps. `api_setup` gains `bootstrap` (OpenAPI 3.x URL → draft profile) and `refine` (additive patch for guidelines/avoid/notes/endpoints/shape/rate_limit). Fully opt-in: hostnames without a profile or without `response_shape` behave identically to prior releases.
- **Markdown artifact download + print-to-PDF** (#138). `.md` artifacts now carry a download button and a browser-side print-to-PDF action.
- **Mobile/PWA polish** (#96). Settings page gets a version + legal footer, mobile-only items are hidden when the app is running as a PWA or on narrow viewports, and the stale-bundle toast gets a one-click "reload now" action.

### Fixed

- **Empty user bubbles on thread resume** (#129). Agent-synthesized user turns (e.g. tool_result carriers for `ask_user`) no longer render as blank grey bubbles when a thread is reloaded.
- **409 queue instead of failed bubble** (#130). When iOS Safari backgrounds the PWA, SSE drops, and the next send hits the server's in-progress run, the bubble now shows as queued ("Agent arbeitet noch am vorherigen Schritt — deine Nachricht wartet…") and polls `/run` every 3s for up to 6 min before giving up. Stop and thread-switch cleanly cancel the poll loop via a shared `AbortController`.
- **Orphan tool_use / tool_result sanitization on history load** (#135). Unpaired tool blocks are dropped so the model doesn't stall on malformed history.
- **Abbreviation splitting in markdown** (#136). Strings like "z.B." no longer trigger a paragraph break.
- **Session-expired copy on 401** (#137). 401 on `/run` now shows "session expired, please log in again" and bounces to `/login`, instead of the misleading "API key invalid".
- **Entity detail panel closes on Escape** (#139). KG side panel now follows the same dismiss pattern as other overlays.

## 1.3.2 — 2026-04-22

### Added

<!-- new features -->

### Changed

<!-- existing features touched -->

### Fixed

<!-- bug fixes -->

<!-- Reference — raw commits since v1.3.1 (delete this block before saving):

Core:
- fix: chat resume preserves user turns; artifact chip static; md export (#127)

Pro:
- feat(managed): per-instance update endpoint for canary rollouts (#79)
- chore(release): v1.3.1 (#78)
-->
## 1.3.1 — 2026-04-22

### Added

<!-- new features -->

### Changed

<!-- existing features touched -->

### Fixed

<!-- bug fixes -->

<!-- Reference — raw commits since v1.3.0 (delete this block before saving):

Core:
- feat(agent): annotate non-retryable tool errors so the model stops grinding (#125)
- feat: markdown artifact template + researcher-role Sonnet default (#124)
- feat(web-ui): show live sub-agent delegation in Context sidebar (#123)
- fix: voice TTS reads CHF, numbers-with-x, times, and #refs as noise (#122)
- fix(spawn): advertise only the roles that actually exist (#121)
- fix(voice): expand "N/mo" price patterns to natural phrasing (#120)
- fix(voice): don't mangle English arrows with German "dann" (#119)
- feat(spawn): stream sub-agent progress to the parent UI (#118)
- fix(voice): handle slashes, <N, arrow prosody, and DE Die pronunciation (#117)
- fix: voice TTS reads tables and arrow symbols as noise (#116)
- fix: voice TTS playback accelerates and garbles on longer replies (#115)
- fix: prevent agent context-drift on short followups (#114)
- feat(kg): add v2 entity extractor behind LYNOX_KG_EXTRACTOR flag (#113)

Pro:
- fix(managed): refuse sync-env when secret preserve would leak sentinel (#77)
- chore(ci): add one-shot admin-credit-grant workflow (#76)
- feat(managed): add POST /admin/customers/:id/credit endpoint (#75)
- feat(managed): add POST /admin/instances/:id/sync-env endpoint (#74)
- feat(managed): enable KG extractor v2 by default on managed instances (#73)
- chore(release): v1.3.0 (#72)
-->
## 1.3.0 — 2026-04-21

Two themes ship together: a user-facing **Usage Dashboard** that
answers "how much of my budget is left, and what burned it?" and
a **Compliance & Privacy settings overhaul** that consolidates
data-processing controls (LLM mode, voice providers, error
reporting, data residency) into one tab and swaps tier-based
visibility for capability-based visibility.

### Added

- **Usage Dashboard** in Settings → Budget & Usage. Tier badge,
  period selector (this month / last month / 7 d / 30 d),
  progress bar with 80 % amber / 95 % red thresholds, per-model
  cost breakdown, and a daily-trend sparkline rendered as pure
  inline SVG (no chart library).
- **`GET /api/usage/summary?period=current|prev|7d|30d`** aggregates
  RunHistory into a Dashboard-friendly shape: `used_cents`,
  `by_model`, `by_kind`, `daily` (zero-filled). Instance-scoped
  30 s TTL cache. Integer cents over the wire so JSON transport
  has no float-rounding surprises.
- **Managed-tier control-plane proxy**: `GET /api/usage/summary`
  on managed tiers now calls the control plane's new
  `/internal/usage/:instanceId/summary` endpoint and returns the
  included-credit meter (e.g. "$X of $30 included") with the
  Stripe billing period. Self-host + Hosted paths unchanged.
- **Compliance & Privacy settings tab** consolidates LLM mode,
  voice pickers, data residency read-out, and error reporting
  in one place. Visible on every tier; individual sub-sections
  gate on capability rather than tier.
- **`capabilities.mistral_available`** on `GET /api/config`
  reflects whether a Mistral key is present in env or vault.
  The LLM-mode toggle (Standard / EU Sovereign) gates on this
  instead of the managed-tier flag, so Self-Host and Hosted
  users with a Mistral key can finally access EU Sovereign
  from the UI.
- **Voice provider pickers** for STT + TTS in Settings →
  Compliance. Provider list + live voice catalog fetched from
  Mistral's `/v1/audio/voices` endpoint (paginated, 30+ voices
  today). `tts_voice` added to `LynoxUserConfig` so the picker
  choice persists across restarts. Env-var overrides
  (`LYNOX_TRANSCRIBE_PROVIDER` / `LYNOX_TTS_PROVIDER`) render
  the selector disabled with a hint.
- **`RunRecord.kind`** column splits `llm` / `voice_stt` /
  `voice_tts` so the Dashboard can attribute voice cost
  separately from chat cost. `units` column holds characters
  for TTS, seconds for STT, tokens for LLM. Schema v28, nullable
  / default-0 so pre-v28 rows read as `llm` without a backfill.
- **`/api/speak`** + **`/api/transcribe`** now write RunRecord
  rows with the right `kind`. STT uses `ffprobe` on the uploaded
  clip to fill `units` with actual seconds of audio; runs in
  parallel with transcription so it doesn't block user-facing
  latency.
- **Budget threshold toasts** fire in the Web UI at 80 % (info)
  and 95 % (error) of the monthly budget. Deduped per Stripe
  period via `localStorage`, rate-limited to one check per 30 s,
  silent-skip when no budget is configured. Hooks off the chat
  store's `done` event via dynamic import to keep alert code
  out of the initial bundle.

### Changed

- **Bugsink toggle moves from Settings → System to Settings →
  Compliance → Error Reporting.** On Managed it's info-only
  ("always active per DPIA"); on Self-Host it stays the opt-in
  toggle.
- **Settings tab "Budget" renamed to "Budget & Nutzung" /
  "Budget & Usage"** and is now visible on every tier. Limit
  inputs inside the tab remain gated on `!managed`.
- **Vault → env sync for `MISTRAL_API_KEY`** at engine init.
  BYOK users who stored the key via the Settings UI were
  previously silently broken — the secret was in vault but the
  voice facades and `llm_mode=eu-sovereign` override read from
  `process.env` directly. Now synced on init, env still wins
  if set.
- **Mistral voice-catalog parser** matches the live API response
  shape: `items` container, `slug` as the voice selector (the
  `id` field is a UUID unusable for synthesis), `languages[]`
  array, `name` as the human label. Replaces the earlier
  OpenAI-style assumption that returned the 5-voice fallback
  every call.
- **Mistral voice-catalog pagination**: Mistral caps `page_size`
  at 10 regardless of query param. The parser now loops pages
  1..N so the full 30-voice catalog reaches the UI.
- **Managed-hosting compose file** bind-mounts SSH keys from a
  fixed host path instead of a named Docker volume. A named volume
  could come up empty after `up --build`, sending the control plane
  into a crash loop (2026-04-21 incident).

### Migration notes

- **Schema v28** (RunHistory): `ALTER TABLE runs ADD COLUMN kind
  TEXT; ALTER TABLE runs ADD COLUMN units INTEGER NOT NULL
  DEFAULT 0`. Idempotent, back-compat — pre-v28 rows read as
  `kind=null` which aggregates as `llm`.
- **Managed control-plane compose**: the first rebuild after
  this version bumps the SSH-keys mount to a bind-mount. Operators
  must confirm the managed host's ssh-keys directory has
  `id_ed25519` (0600, uid 1000) + `id_ed25519.pub` (0644, uid
  1000) before the first `docker compose up -d --build managed`.
  The old named SSH-keys volume becomes orphaned
  and can be removed with `docker volume rm` at leisure.
- **Capability probe**: callers of `GET /api/config` will see a
  new `capabilities` object in the response. Existing consumers
  that iterate fields are unaffected; only new fields added.

## 1.2.2 — 2026-04-20

### Fixed

- `ask_user` no longer hangs or crashes when asking multiple questions in one
  call. The old protocol looped N sequential `prompt` events over SSE and
  relied on the client replying with fixed timing, which raced on slow mobile
  connections and silently dropped answers. Replies now use a single
  `prompt_tabs` SSE event + one-shot `/reply-tabs` POST.
- `POST /api/sessions/:id/reply` is now idempotent — retrying after a network
  blip returns 200 with `idempotent: true` instead of 404.
- Passkey setup prompt on the Web UI no longer renders with a transparent
  background (Tailwind class `bg-bg-raised` didn't exist in the theme) and no
  longer overlaps the chat input on mobile.
- Timeout/abort on a pending prompt now surfaces a `prompt_error` SSE event to
  the client instead of silently defaulting the answer to `'n'`.

### Added

- `POST /api/sessions/:id/reply-tabs` for one-shot multi-question replies.
- `POST /api/sessions/:id/tab-progress` for optional mid-batch partial-answer
  persistence, so a reconnect mid-batch restores answered questions.
- `GET /api/sessions/:id/pending-prompt` now returns `kind`, `questions`, and
  `partialAnswers` when the pending prompt is a tabs prompt.
- Engine `Agent.promptTabs` is now wired over the HTTP API when the client
  advertises `protocol: 2` on `/run`. MCP and older clients fall back to the
  previous sequential path.
- Schema migration v27: `questions_json`, `partial_answers_json`, and a
  UNIQUE index enforcing one pending prompt per session.

### Changed

- `PromptStore.waitForAnswer` is now event-driven (Node `EventEmitter`)
  instead of polling every 2s. Sub-millisecond resolution after an answer
  arrives, same SQLite durability.
- `ask_user` tool caps the `questions` array at 20 entries.

## 1.2.1 — 2026-04-17

### Added

<!-- new features -->

### Changed

<!-- existing features touched -->

### Fixed

<!-- bug fixes -->

<!-- Reference — raw commits since v1.2.0 (delete this block before saving):

Core:
- feat(speak,web-ui): per-block auto-speak + monochrome voice prefix + tool icon refactor (#88)
- fix: ask_secret on managed + Migration race in Settings (#87)
- feat(web-ui): toast on stale client bundle after deploy (#86)
- docs: voice hotkey, model breakdown, WhatsApp beta note for v1.2.0 (#85)

Pro:
- feat(web): add Voice entry to Communication integrations (#62)
-->
## 1.2.0 — 2026-04-17

### Added

<!-- new features -->

### Changed

<!-- existing features touched -->

### Fixed

<!-- bug fixes -->

<!-- Reference — raw commits since v1.1.0 (delete this block before saving):

Core:
- fix(whatsapp): bypass auth for webhook + status endpoints (#82)
- feat(whatsapp): inbox integration Phase 0 behind feature flag (#80)
- feat(speak): MSE progressive playback + auto-speak toggle + voice hotkey (#79)
- feat(web-ui): model breakdown panel in history dashboard (#78)
- feat(web-ui): multi-provider API status in footer (#77)
- fix(ask_user): guard malformed options + surface tool errors to UI (#81)
- fix(scripts): handle multiline CHANGELOG draft + merge commit title (#51)
- fix(pricing): correct Opus 4.6 and Haiku 4.5 rates, add Opus 4.7 (#75)
- fix(speak): Phase 1.1 production-hardening (#76)
- fix(web-ui): allow blob: media for TTS audio playback (#74)
- feat(web-ui): speak button on assistant replies + voice-output docs (#71)
- feat(speak): HTTP API — POST /api/speak + GET /api/voice/info (#70)
- feat(speak): Voxtral TTS facade + text-prep sanitizer (#69)
- chore(scripts): add Phase 0 Voxtral TTS spike (#68)
- feat(web-ui): extend voice privacy hint with quota note
- feat(web-ui): render voice privacy hint under the recording UI
- chore(scripts): add Phase 0 Voxtral spike + recorder (dev tooling)
- feat(transcribe): thread session context into HTTP API + Telegram
- feat(transcribe): Voxtral provider + two-layer glossary
- docs: add mail integration page + update onboarding references

Pro:
- fix(ci): update staging engine instance ID after 2026-04-16 reprovision (#58)
- docs(prd): voice TTS Phase 0 results + auto-speak toggle (#57)
- feat(managed): document + pin MISTRAL_API_KEY flow for Voxtral voice
- fix(scripts): use rollout endpoint instead of per-instance redeploy
- feat: add mail integration to website + welcome email
-->
## 1.0.5 — Release Workflow & CI Hardening (2026-04-16)

### Added

- **Local smoke test** — `smoke-local.sh` runs Docker Compose + Playwright before every release cut, catching runtime regressions that unit tests miss.
- **One-command release cut** — `cut-release.sh` automates lockstep version bumps, cross-repo PRs, merge polling, and tag creation across core + pro.
- **Production gate** — Release pipeline pauses for manual approval before deploying to production; email notification on gate readiness.
- **Docs auto-deploy** — Documentation site deploys automatically on release via Cloudflare Pages.
- **Cross-repo dispatch** — Core release triggers pro release workflows (website + control plane) automatically after gate approval.

### Changed

- **CI scanner** — Replaced `pnpm audit` / `audit-ci` with `osv-scanner` for more reliable vulnerability detection.
- **NPM publish** — Added `NPM_TOKEN` pre-release gate to catch auth issues before they break the publish step.

### Fixed

- **Migration crypto test** — Deterministic tamper in signature test eliminates rare false failures on CI.

---

## 1.0.4 — Multi-Provider Support (2026-04-15)

### Added

- **Native OpenAI-compatible provider adapter** — Use Mistral, Gemini, and any OpenAI-compatible API directly via a dedicated adapter, no proxy layer required.
- **Google Vertex AI (Claude)** — Connect Claude models via Google Vertex AI using OAuth, enabling regional deployment (EU, US) without BYOK API keys.
- **`llm_mode` toggle** — New configuration switch for EU-sovereign operation: when set to `eu-sovereign`, the engine runs Mistral-only without contacting Anthropic endpoints.
- **Postinstall hint** — `npm i -g @lynox-ai/core` now prints a one-liner steering users toward the recommended `npx @lynox-ai/core` or Docker Compose workflow for zero-config startup.

### Changed

- **Provider stack clarified** — Core now ships with Anthropic direct, Mistral direct (via OpenAI-compat adapter), Vertex AI (for Claude), and AWS Bedrock as BYOK. Managed hosting uses Anthropic + Mistral as native; Bedrock is BYOK-only.
- **CI coverage threshold** — Aligned global threshold with `vitest.config.ts` (65% lines, was 70%).
- **npm publish** — Removed OIDC provenance from the release workflow (operational fix for auth reliability).

### Fixed

- Bedrock 400 error when provider-incompatible `beta` flags were passed through (already in 1.0.3, noted here for completeness).

---

## 1.0.1 – 1.0.3

Incremental patches released without changelog entries. See `git log v1.0.0..v1.0.3` for the full history. Highlights:

- **1.0.3** — Prompt cache TTL fix (`ephemeral_1h` for Anthropic, `ephemeral` for Bedrock)
- **1.0.2** — Prompt caching uses correct extended TTL syntax
- **1.0.1** — npm publish auth fix (NPM_TOKEN with provenance, later removed in 1.0.4)

## 1.0.0 — Initial Release

One system that learns your business — connects any API, orchestrates your workflows, researches the web, monitors for changes. Self-hosted, open, yours.

### Core

- **Agentic loop** — Streaming tool dispatch with adaptive thinking, automatic retry with exponential backoff, parallel tool execution via `Promise.allSettled`
- **Roles** — 4 built-in roles (Researcher, Creator, Operator, Collector) with tool scoping and isolated budgets
- **Engine/Session** — Engine (shared singleton) + Session (per-conversation) architecture enabling REPL + Telegram + MCP in one process
- **Persistent AI Worker** — WorkerLoop for background task execution with cron scheduling, watch-URL polling, and multi-turn conversations
- **Cost tracking** — Per-model pricing with cache token accounting (write 1.25x, read 0.1x) and budget enforcement via CostGuard

### Knowledge

- **Unified Agent Memory** — SQLite-based (crash-safe, WAL mode) with 9 tables: semantic memories, entity graph, episodic log, pattern detection, KPI metrics. Confidence evolution, memory consolidation, retrieval feedback loop
- **Knowledge Graph Retrieval** — HyDE query expansion, multi-signal search (vector 55% + graph 15% + episodic 10%), confidence multiplier with unconfirmed decay, MMR re-ranking, pattern + episode context injection
- **Persistent business knowledge** — Context-scoped flat-file storage with auto-extraction and selective extraction prompts
- **Knowledge levels** — Three tiers: organization, project, personal — with configurable relevance weights
- **Embeddings** — Local ONNX (multilingual-e5-small, 384d, 100 languages), fully offline
- **Auto role selection** — Simple tasks auto-downgrade to Haiku for cost optimization

### Tools (13 built-in)

- `bash` — Shell execution with dangerous command detection and environment sanitization
- `read_file` / `write_file` — File operations with path traversal protection and symlink validation
- `memory` — Store, recall, delete, update, list, promote across knowledge levels
- `spawn_agent` — Parallel sub-agents with per-agent budget limits and role-based scoping
- `ask_user` — Interactive user input with select, confirm, and freeform modes
- `batch_files` — Multi-file rename, move, and transform operations
- `http` — External API calls with SSRF protection, redirect handling, and network policy enforcement
- `run_pipeline` — Multi-step workflow execution with dependency graphs and parallel steps
- `task` — Task management with priority, due dates, scheduling, and watch-URL monitoring
- `plan_task` — Structured planning with automatic workflow conversion
- `data_store` — Structured SQLite storage with typed columns, filters, and aggregation
- `capture_process` / `promote_process` — Turn ad-hoc work into reusable workflows

### Automation

- **Workflow engine** — Declarative manifests with dependency graphs, parallel execution, conditions, and template syntax
- **Process capture** — Record what you did, save it as a reusable workflow with parameters
- **File trigger** — File system watcher with glob matching and debounce (CLI `--watch`)
- **Advisor** — Analyzes run history for patterns, suggests optimizations

### Integration

- **Telegram bot** — Primary mobile/async interface with rich status messages, inline keyboards, and follow-up suggestions
- **MCP server** — stdio + HTTP SSE transport with sync and async lifecycle, Bearer token auth, and per-IP rate limiting
- **Plugin system** — Validated plugin loading from `~/.lynox/plugins/`

### Security

- **Secret vault** — AES-256-GCM encrypted SQLite storage with PBKDF2 (600K iterations, SHA-512)
- **Multi-source secrets** — Environment variables, vault, and config with `secret:KEY` reference pattern
- **Pre-approval system** — Glob-based auto-approval with critical tool blocking, TTL, max-uses, and audit trail
- **Permission guard** — Critical/dangerous command detection with business-friendly block messages
- **Input guard** — Content policy scanning before LLM processing
- **Output guard** — Write content validation and injection detection

### Data

- **DataStore** — SQLite-based structured storage with agent-defined collections, typed columns, filter-to-SQL translation, aggregation, and upsert
- **DataStore ↔ Knowledge Graph bridge** — Automatic entity linking between structured data and the knowledge graph
- **Run history** — SQLite with WAL mode, 19 migrations, tracking runs, tool calls, spawns, workflows, and security events

### Infrastructure

- **Docker** — Single-stage `node:22-slim` image, non-root user, read-only root filesystem, tmpfs, no-new-privileges
- **Config system** — 3-tier merge (env > project > user) with project-safe allowlist
- **Setup wizard** — First-run guided configuration with API key validation and accuracy level selection
- **CLI** — 40+ slash commands for conversation, model control, project management, tools, knowledge, automation, tasks, history, and identity
