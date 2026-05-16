import type { BenchScenario } from './types.js';
import { SWISS_TOP3_POPULATION_TOTAL } from './mock-tools.js';

const CRM_EMAIL = `Von: anna.weber@acme-retail.ch
An: mich
Betreff: Re: Onboarding Kick-off

Hoi,

danke für den Call gestern. Kurz zum Status — wir haben jetzt drei Personen
die in den Prozess involviert sind:

- Anna Weber (das bin ich), COO bei Acme Retail — ich bin Haupt-Ansprechpartner
  für die ganze Integration.
- Martin Huber, unser CTO — der muss das technische Setup absegnen. Ich schick
  euch seine E-Mail separat.
- Sarah Imhof von der Privatsphäre-Consultant-Agentur "Privisio" — sie prüft
  das Data-Processing-Agreement. Ihre Nummer: +41 44 123 45 67.

Aktionen von eurer Seite:
1. DPA-Entwurf bis Freitag an Sarah schicken.
2. Tech-Setup-Call mit Martin nächste Woche Dienstag 14:00 organisieren.
3. Test-Instanz für uns aufsetzen — ihr kriegt die Credentials separat.

Gruss
Anna`;

const CODE_REVIEW_DIFF = `diff --git a/src/api/users.ts b/src/api/users.ts
index abc..def 100644
--- a/src/api/users.ts
+++ b/src/api/users.ts
@@ -10,8 +10,15 @@ export async function getUser(req: Request) {
   const id = req.query.id;
   if (!id) return { error: 'missing id' };

-  const user = await db.query('SELECT * FROM users WHERE id = ?', [id]);
-  return user;
+  // Allow lookup by email as fallback
+  const email = req.query.email;
+  let user;
+  if (email) {
+    user = await db.query(\`SELECT * FROM users WHERE email = '\${email}'\`);
+  } else {
+    user = await db.query('SELECT * FROM users WHERE id = ?', [id]);
+  }
+  return user;
 }

 export async function listUsers(req: Request) {
@@ -22,7 +29,7 @@ export async function listUsers(req: Request) {
   const users = await db.query('SELECT * FROM users LIMIT ?', [limit]);
   const result = [];
-  for (let i = 0; i <= users.length; i++) {
+  for (let i = 0; i <= users.length; i++) {
     result.push({ id: users[i].id, name: users[i].name });
   }
   return result;
 }`;

const DEBUG_LOG = `2026-04-14T08:12:03.112Z [control-plane] Deploy started for instance=war.lynox.cloud version=1.0.5
2026-04-14T08:12:07.882Z [control-plane] SSH ok, docker version 24.0.7
2026-04-14T08:12:11.341Z [control-plane] Pulling image ghcr.io/lynox-ai/lynox:1.0.5 ...
2026-04-14T08:12:48.220Z [control-plane] Image pulled (128MB)
2026-04-14T08:12:49.014Z [control-plane] docker compose up -d --force-recreate lynox-core
2026-04-14T08:12:53.992Z [lynox-core] starting engine
2026-04-14T08:12:54.551Z [lynox-core] connecting to postgres...
2026-04-14T08:12:54.801Z [lynox-core] ok
2026-04-14T08:12:54.920Z [lynox-core] loading schema version... current=20
2026-04-14T08:12:54.944Z [lynox-core] ERROR: query failed: error: column "mail_provider" does not exist
2026-04-14T08:12:54.944Z [lynox-core] Position: 142
2026-04-14T08:12:54.944Z [lynox-core]    at Parser.parseErrorMessage (/app/node_modules/pg-protocol/...)
2026-04-14T08:12:54.945Z [lynox-core] engine failed to boot, exiting 1
2026-04-14T08:12:55.002Z [control-plane] container exited code=1
2026-04-14T08:12:55.003Z [control-plane] Deploy FAILED for war.lynox.cloud

Migration file applied just before build:
0021_add_mail_provider.sql:
ALTER TABLE instance_settings ADD COLUMN mail_provider TEXT NOT NULL DEFAULT 'smtp';`;

const SUMMARY_DOC = `Product Brief: Managed Hosting Tier "Managed Pro"

Context: lynox offers three customer tiers today — Hosted (CHF 39/mo, BYOK),
Managed (CHF 79/mo, EU LLM keys included, isolated container), and Enterprise
(dedicated VPS, custom pricing, manual onboarding). Between Managed and
Enterprise there is a gap: customers who outgrow shared-host limits but are
not yet ready for dedicated-VPS pricing.

Proposal: Introduce "Managed Pro" at CHF 149/mo. Differentiators vs. Managed:

1. Higher rate limits: 500 req/hour HTTP tool (Managed: 200), 2000 agent
   iterations per session (Managed: 500).
2. Extended context window opt-in: user can enable 1M-token context per
   thread for complex multi-document work. Managed stays at 500k default cap.
3. Priority provisioning: new Managed Pro instances deploy in under 10 min
   (currently Managed provisioning is batched every 30 min).
4. Daily encrypted backups to customer-controlled S3 or Google Drive (Managed
   gets weekly control-plane backups only, customer has no direct access).
5. Dedicated Bugsink project for error tracing with 30-day retention.

Out of scope: No dedicated compute, no dedicated IP, no SLA beyond best-effort.
These stay exclusive to Enterprise.

Timeline: Beta testing with 3 existing Managed customers in May; GA in June
alongside v1.2.0 release. No migration path from existing Managed tier in
Phase 1 — new signups only; existing customers can upgrade manually via admin
API after GA.

Success metrics: 10 Managed Pro signups in first quarter; less than 5%
churn-down from Managed to Hosted (signal that Pro cannibalizes Managed);
at least 2 Enterprise inquiries re-routed to Pro (signal that Pro closes
the gap).`;

export const SCENARIOS: readonly BenchScenario[] = [
  {
    id: 'trivial-question',
    category: 'baseline',
    description: 'Overkill-Detektor — generisches Faktenwissen, Haiku sollte reichen.',
    prompt: 'Erkläre den Unterschied zwischen TCP und UDP. Nenne je ein typisches Einsatzgebiet.',
    judgeRubric: [
      'Nennt TCP als verbindungsorientiert / zuverlässig / geordnet',
      'Nennt UDP als verbindungslos / unzuverlässig / geringerer Overhead',
      'Nennt je ein sinnvolles Einsatzgebiet (z.B. TCP: HTTP/SSH/E-Mail, UDP: DNS/Video-Streaming/VoIP/Gaming)',
      'Keine sachlichen Fehler',
    ],
    referenceAnswer: 'TCP ist verbindungsorientiert und garantiert geordnete, zuverlässige Übertragung (z.B. HTTP, SSH). UDP ist verbindungslos und schneller, liefert aber keine Garantien — geeignet für Echtzeit-Anwendungen wie DNS, Video-Streaming oder Gaming.',
    maxIterations: 1,
    timeoutMs: 30_000,
  },
  {
    id: 'crm-extraction',
    category: 'extraction',
    description: 'Extrahiere Kontakte und Tasks aus E-Mail in strukturiertes JSON.',
    prompt: `Extrahiere aus folgender E-Mail (a) alle Personen mit Rolle/Firma/Kontakt, (b) alle Aktionen mit Owner und Due-Date (falls genannt). Antworte als JSON mit den Schlüsseln "contacts" und "tasks".\n\n--- E-Mail ---\n${CRM_EMAIL}`,
    judgeRubric: [
      'Alle 3 Personen erfasst: Anna Weber (COO Acme Retail), Martin Huber (CTO), Sarah Imhof (Privisio)',
      'Kontaktdaten korrekt: Sarahs Nummer +41 44 123 45 67 erfasst',
      'Alle 3 Aktionen erfasst mit Owner: DPA an Sarah, Tech-Call mit Martin, Test-Instanz aufsetzen',
      'Ausgabe ist valides JSON mit Schlüsseln "contacts" und "tasks"',
      'Keine halluzinierten Personen/Aktionen',
    ],
    referenceAnswer: JSON.stringify({
      contacts: [
        { name: 'Anna Weber', role: 'COO', company: 'Acme Retail', email: 'anna.weber@acme-retail.ch' },
        { name: 'Martin Huber', role: 'CTO', company: 'Acme Retail' },
        { name: 'Sarah Imhof', role: 'Privacy Consultant', company: 'Privisio', phone: '+41 44 123 45 67' },
      ],
      tasks: [
        { action: 'DPA-Entwurf schicken', owner: 'uns', to: 'Sarah', due: 'Freitag' },
        { action: 'Tech-Setup-Call organisieren', owner: 'uns', with: 'Martin', due: 'Dienstag 14:00 nächste Woche' },
        { action: 'Test-Instanz aufsetzen', owner: 'uns', for: 'Acme Retail' },
      ],
    }, null, 2),
    maxIterations: 2,
    timeoutMs: 60_000,
  },
  {
    id: 'code-review',
    category: 'analysis',
    description: 'Finde SQL-Injection + Off-by-one im Diff.',
    prompt: `Review das folgende Diff. Finde alle Bugs, Security-Issues und Logik-Fehler. Sei spezifisch (Zeilennummer, was ist das Problem, wie fixen).\n\n${CODE_REVIEW_DIFF}`,
    judgeRubric: [
      'Erkennt SQL-Injection in email-Query (String-Interpolation statt parametrisiert)',
      'Erkennt Off-by-one Bug in Loop: `i <= users.length` statt `i < users.length`',
      'Schlägt konkrete Fixes vor (parameterisiert, oder ORM)',
      'Keine False Positives (nicht jede Zeile als Bug markieren)',
    ],
    referenceAnswer: '1) SQL-Injection in email-Query: benutzt String-Interpolation. Fix: `db.query(\'SELECT * FROM users WHERE email = ?\', [email])`. 2) Off-by-one in for-Loop: `i <= users.length` führt zu undefined access am letzten Index. Fix: `i < users.length`.',
    maxIterations: 2,
    timeoutMs: 60_000,
  },
  {
    id: 'debugging',
    category: 'reasoning',
    description: 'Log-Excerpt + Migration-SQL → Root-Cause identifizieren.',
    prompt: `Unser Deploy ist fehlgeschlagen. Anbei das Log und die zuletzt angewendete Migration. Was ist der Root-Cause und wie fixen?\n\n${DEBUG_LOG}`,
    judgeRubric: [
      'Identifiziert Root-Cause: Migration wurde NACH Container-Start erwartet, aber Query läuft beim Boot auf alter Schema-Version',
      'Oder alternativ korrekt: Migration ist lokal definiert, aber noch nicht auf der DB angewendet (Spalte existiert nicht)',
      'Schlägt Fix vor: Migration vor `docker compose up` ausführen, oder ins Entrypoint einbauen',
      'Kein Aufschlag von unverwandten Fehlerquellen (z.B. Netzwerk, Pull)',
    ],
    referenceAnswer: 'Root-Cause: Die Migration `0021_add_mail_provider.sql` wurde lokal geschrieben, aber nicht auf der Produktions-DB angewendet — der frische Container erwartet die Spalte `mail_provider`, findet sie aber nicht (errorMissingColumn). Fix: Migration VOR dem `docker compose up --build` gegen die DB laufen lassen (`psql -U managed -d lynox_managed < 0021_add_mail_provider.sql`). Grundsätzlich: Migrationen immer vor Container-Rebuild anwenden, sonst crasht der fresh-build Container beim Boot.',
    maxIterations: 2,
    timeoutMs: 60_000,
  },
  {
    id: 'summarization',
    category: 'summarization',
    description: 'Verdichte Product-Brief zu Bullet-Summary.',
    prompt: `Fasse folgendes Product Brief zusammen als 5-7 Bullets. Kernpunkte: Differentiators, Timeline, Success-Metriken.\n\n${SUMMARY_DOC}`,
    judgeRubric: [
      'Hauptproduktvorschlag erwähnt: Managed Pro bei CHF 149/mo',
      'Nennt mindestens 3 der 5 Differentiators (Rate Limits, 1M Context, Provisioning, Backups, Bugsink)',
      'Erwähnt Timeline: Beta im Mai, GA im Juni mit v1.2.0',
      'Erwähnt Success-Metriken: 10 Signups/Quartal, <5% Churn-down',
      '5-7 Bullets — nicht zu kurz, nicht zu lang',
      'Keine halluzinierten Features',
    ],
    referenceAnswer: '- Neues Tier "Managed Pro" bei CHF 149/mo — füllt Lücke zwischen Managed (CHF 79) und Enterprise\n- Differentiators: 2.5× Rate Limits, 1M-Token-Context-Opt-in, Priority Provisioning (<10min), tägliche Backups zu Customer-S3/GDrive, dediziertes Bugsink-Projekt\n- Out-of-Scope: Kein dediziertes Compute, keine IP, keine SLA (bleibt Enterprise exklusiv)\n- Timeline: Beta Mai mit 3 Bestandskunden, GA Juni mit v1.2.0\n- Kein automatischer Migrationspfad für Bestandskunden in Phase 1 — nur Neukunden\n- Success: 10 Signups im Q1, <5% Cannibalisierung von Managed, 2+ Enterprise-Inquiries auf Pro umgelenkt',
    maxIterations: 2,
    timeoutMs: 60_000,
  },
];

// =============================================================================
// Phase 2: scenarios Phase 1 didn't cover — long context, creative generation,
// dense multi-constraint reasoning. Goal: surface workloads where Opus 4.7
// could justify reactivation on Managed.
// =============================================================================

/** Build a synthetic support-ticket corpus (~15k tokens) for long-context testing. */
function buildSupportCorpus(): string {
  const tickets = [
    ['Login broken after password reset', 'I reset my password via the email link but now I cannot log in. Error says "invalid credentials". Tried three times. Cleared cookies. Still same error. Customer is premium tier, urgent.'],
    ['Billing shows CHF 79 instead of CHF 39', 'I signed up for Starter (CHF 39) but my card was charged CHF 79. I never upgraded. Can you refund the difference?'],
    ['Integration with Gmail stopped working', 'Three days ago my Gmail integration stopped syncing. Tried disconnecting and reconnecting — OAuth says "app not verified by Google". Was working fine before.'],
    ['Slow response times in last week', 'Agent responses used to take 2-3 seconds, now 15-30 seconds. Same prompts, same context. Started Tuesday. I have 5 long-running threads open.'],
    ['Cannot delete old threads', 'Trying to delete threads from 6 months ago. Button clicks but nothing happens. Browser console shows 500 error on DELETE /api/threads/{id}.'],
    ['Data export fails silently', 'Requested full data export via Settings > Export. Email never arrived. Ran it twice yesterday and once today. No error shown in UI.'],
    ['Upgrade from Starter to Managed silently failed', 'Clicked upgrade in dashboard, Stripe checkout succeeded, card charged. Instance still shows Starter tier. Would expect auto-provisioning of Managed.'],
    ['Email notifications never arrive', 'Enabled email notifications for task completion. Tested with a 5-minute task. Nothing arrived at my Gmail or my Spam folder. Sender address configured correctly.'],
    ['KG browser crashes on large dataset', 'Opened Knowledge Graph view — 3000+ nodes. Browser hangs for 60 seconds then crashes (Chrome tab killed). Was working at 1500 nodes last month.'],
    ['Password reset email goes to spam in Outlook', 'Corporate users on Outlook report the password reset email lands in spam. Gmail users are fine. SPF/DKIM setup?'],
    ['Webhook retries not working', 'Custom webhook fails intermittently but lynox does not retry. Docs say 3 retries with backoff. Logs show single attempt, no retry.'],
    ['CRM contact merge loses data', 'Merged two duplicate contacts. The notes from the older contact disappeared after merge. Expected: combined notes preserved.'],
    ['Mobile UI: ask_user dialog not dismissable', 'On iPhone Safari, when agent asks a question the dialog blocks the screen. No way to dismiss it. Have to kill the app.'],
    ['Telegram bot stops responding after 24h', 'Set up Telegram bot per docs. Works for ~24h then silently stops. Restart via /start fixes it until next day.'],
    ['API rate limit unclear', 'Got 429 responses but dashboard does not show current rate limit state. Docs say 200/hour. Was I actually over? When does window reset?'],
    ['Cannot change primary email', 'My work email changed. Settings > Account only lets me add secondary emails, not change primary. Support said "use admin portal" — I do not have admin access.'],
    ['File attachments disappear in Telegram', 'Sending images from Telegram to lynox — image arrives but gets processed into text summary then deleted. Would prefer it stays in the thread.'],
    ['DataStore query performance cliff', 'Tables with >10k rows: queries that took 200ms now take 30+ seconds. Smaller tables unaffected. Added indexes, no improvement.'],
    ['Docker image keeps pulling on every restart', 'Self-hosted docker compose setup. Every `docker compose restart` pulls the image fresh instead of using local cache. Bandwidth cost.'],
    ['Web UI dark mode broken on one page', 'Dark mode works everywhere except /settings/billing — page uses light theme colors on dark background. Text unreadable.'],
    ['Multi-factor auth bypass via OAuth login', 'SECURITY: I enabled MFA but logging in via Google OAuth skips the MFA step entirely. Expected: OAuth login should also require MFA.'],
    ['Cost tracking numbers do not match Anthropic dashboard', 'lynox dashboard shows $52 used this month. My Anthropic console shows $31. Which is right? Big discrepancy.'],
    ['Context window auto-compact too aggressive', 'Agent compacts at 75% usage. Sometimes drops useful early context. Is there a way to tune this per-thread?'],
    ['Search returns nothing from archived threads', 'Global search only searches active threads. Archived threads with important history are invisible. Can we include archives?'],
    ['Duplicate entity creation in CRM', 'CRM creates duplicate company entities when agent sees "Acme Corp", "Acme", "acme corp" in different messages. Expected: fuzzy-match and merge.'],
    ['Installation script fails on Apple Silicon', 'Ran the npx installer on M3 Mac. Fails with "no matching docker image for linux/arm64/v8". Expected: multi-arch image.'],
    ['Billing invoice PDF missing VAT line', 'CHF 39 invoice for Swiss customer. PDF shows "Total: CHF 39" with no VAT breakdown. Swiss tax law requires separate VAT line even at 0%.'],
    ['Agent keeps asking same question in loop', 'Agent asks "Which customer do you mean?" — I answer — it asks again — I answer — it asks again. Seems to not be storing the answer. Thread ID consistent.'],
    ['Slack integration: attachments not previewed', 'Posting lynox responses to Slack. Images included in response show as raw URLs, not inline previews. Slack unfurl not triggered.'],
    ['Budget alert fires repeatedly', 'Set $100 monthly budget alert. Email alert fires every hour once I hit 80%. Expected: once per threshold crossing, not continuously.'],
  ];
  const blocks = tickets.map((t, i) =>
    `## Ticket #${String(i + 1).padStart(3, '0')}\n**Subject:** ${t[0]}\n**Body:** ${t[1]}\n`,
  );
  return blocks.join('\n');
}

const SUPPORT_CORPUS = buildSupportCorpus();

const COMPLEX_PRD = `Wir planen ein neues Feature "Smart Task Extraction" für den E-Mail-Workflow.
Es soll eingehende E-Mails automatisch nach Aktionen scannen und daraus Tasks im
lynox-System erstellen. Constraints:

1. Nur E-Mails markieren die nicht von Newslettern/Automatisierungen kommen (DKIM Sender-Reputation-Filter).
2. Tasks bekommen Prio basierend auf Sender-Rolle: CEO/CTO/Investor → High, Team-Mitglied → Medium, extern-unbekannt → Low.
3. Due-Dates aus E-Mail-Text extrahieren — wenn keins gefunden, dann + 7 Tage ab Erstellung.
4. Dedupe: wenn im letzten 24h bereits Task mit gleichem Subject existiert, nur Notiz anhängen statt neuen Task erstellen.
5. Opt-in pro Tenant (Feature Flag \`smart_task_extraction\`).
6. Fehler NIE silent — wenn Parsing fehlschlägt, Task mit Status "needs_review" erstellen und Admin-Notification.
7. Keine Task-Erstellung aus eigenen E-Mails (Sender = Current User → skip).
8. Monatlicher Cap: max 200 auto-Tasks/Tenant/Monat. Danach Hinweis im Dashboard statt neue Tasks.

Schlage eine Implementation vor die ALLE 8 Constraints erfüllt. Beschreibe die
3 wichtigsten Risiken und wie wir sie mitigieren. Maximal 300 Wörter.`;

export const PHASE_2_SCENARIOS: readonly BenchScenario[] = [
  {
    id: 'long-context-summary',
    category: 'summarization',
    description: '30-Ticket Support-Corpus → strukturiertes Cluster mit Top-Issues. Testet Recall über ~15k Token.',
    prompt: `Du bekommst einen Auszug aus unserem Support-Ticket-Backlog (30 Tickets). Analysiere und liefere:

1. Top-3 thematische Cluster (jeweils: Titel, betroffene Ticket-Nummern, Root-Cause-Hypothese)
2. Die 2 schwerwiegendsten Security-/Compliance-Bugs (Ticket-Nummer + Schweregrad-Begründung)
3. Ein konkretes Ticket das sofortiges Eingreifen braucht (mit Begründung)

Antworte strukturiert mit Überschriften. Keine Erfindung von Tickets die nicht existieren.

--- TICKETS ---
${SUPPORT_CORPUS}`,
    judgeRubric: [
      'Identifiziert mindestens 3 echte thematische Cluster (z.B. "Auth/Login-Probleme", "Billing-Discrepancies", "Integration-Failures")',
      'Listet korrekte Ticket-Nummern pro Cluster (keine erfundenen Nummern)',
      'Erkennt Ticket #21 (MFA-Bypass via OAuth) als schwerwiegenden Security-Bug',
      'Erkennt mindestens einen weiteren Billing- oder Compliance-Bug (z.B. #2 Billing-Fehler, #27 VAT-Invoice)',
      'Identifiziert ein wirklich kritisches Ticket für Sofort-Eingriff (z.B. #21 MFA-Bypass oder Security-Bug)',
      'Keine halluzinierten Ticket-Nummern oder -Inhalte',
    ],
    referenceAnswer: 'Cluster 1: Auth/Login (#1, #10, #16, #21) — OAuth/Password-Reset-Flow hat mehrere Bugs inkl. MFA-Bypass. Cluster 2: Billing/Compliance (#2, #7, #22, #27, #30) — Pricing-Discrepancy, Upgrade-Flow broken, Swiss VAT fehlt. Cluster 3: Integration/Sync (#3, #8, #11, #14, #17, #19, #29) — Gmail, Email-Notifications, Webhooks, Telegram, Slack, Docker alle betroffen. Security-Bugs: #21 MFA-Bypass (CRITICAL — Auth-Mechanismus umgangen), #29 Duplicate-Content-Handling oder #17 File-Attachments (MEDIUM). Sofortiger Eingriff: #21 (Security-Bypass).',
    maxIterations: 2,
    timeoutMs: 90_000,
  },
  {
    id: 'creative-copy',
    category: 'reasoning',
    description: 'Generiere 5 Tagline-Varianten mit strikten Constraints. Testet Constraint-Adherence bei kreativer Aufgabe.',
    prompt: `Schreib 5 Tagline-Varianten für das lynox "Managed Pro"-Tier (Business-Automatisierung mit KI-Agents, CHF 149/mo, für Power-User die mehr wollen als der Standard-Managed-Tier).

Strikte Constraints:
- Jede Tagline exakt 5 Wörter (nicht 4, nicht 6)
- Auf Deutsch
- Kein "KI", kein "AI", kein "Intelligence" — Tech-Begriffe vermeiden
- Muss Business-Wert oder Ergebnis kommunizieren, nicht das Produkt
- Keine Superlativen ("bester", "größter", "schnellster") — zu generisch
- Je Variante darunter 1 Satz Begründung wie die Zielgruppe reagiert

Format: nummerierte Liste. Erst Tagline, dann Begründung in Klammern darunter.`,
    judgeRubric: [
      'Genau 5 Varianten geliefert — nicht 3, nicht 7',
      'JEDE Tagline hat exakt 5 Wörter (zähl nach — Bindestriche zählen als ein Wort)',
      'Keine Verwendung der verbotenen Begriffe (KI, AI, Intelligence, Automatic, Smart — Tech-Jargon)',
      'Keine Superlativen (best-, größt-, schnellst-, meist-)',
      'Begründungen sind spezifisch, nicht generisch',
      'Varianten sind inhaltlich unterschiedlich (nicht 5× derselbe Gedanke anders formuliert)',
    ],
    referenceAnswer: '1. "Weniger arbeiten, mehr erreichen." (Direkte Wertversprechung, Ergebnis-fokussiert, spricht Überlastete an)\n2. "Prozesse laufen. Sie wachsen." (Personifiziert die Arbeit, Wachstums-Framing für Gründer)\n3. "Tools hören auf. Arbeit fliesst." (Kontrastiert Ist-Zustand mit Vision, spricht SaaS-müde Nutzer an)\n4. "Jeder Task bekommt Ergebnisse." (Garantie-Ton, wirkt sicher und zuverlässig)\n5. "Ihre Routine wird selbstständig." (Benefits ohne Tech-Vokabular, sympathischer Anthropomorphismus)',
    maxIterations: 1,
    timeoutMs: 60_000,
  },
  {
    id: 'complex-constraints',
    category: 'reasoning',
    description: 'Implementation-Vorschlag mit 8 Constraints + Risiko-Analyse. Testet Constraint-Tracking und Konsistenz.',
    prompt: COMPLEX_PRD,
    judgeRubric: [
      'Adressiert EXPLIZIT alle 8 Constraints — nicht nur implizit',
      'Constraint #1 (DKIM-Filter) korrekt erwähnt',
      'Constraint #4 (Dedupe-Logik) konkret beschrieben',
      'Constraint #6 (keine silent failures — "needs_review" + Admin-Notification) adressiert',
      'Constraint #8 (Monthly Cap 200) mit konkretem Mechanismus',
      'Mindestens 3 Risiken genannt mit echten Mitigation-Strategien',
      'Unter 300 Wörtern (Constraint-Adherence)',
      'Keine erfundenen technischen Komponenten die es nicht gibt (keine halluzinierten Libraries)',
    ],
    referenceAnswer: 'Implementation: E-Mail-Ingest-Worker liest IMAP/SMTP, filtert per DKIM-Reputation (Constraint #1), prüft Sender-Rolle aus CRM für Prio (#2), parst Due-Date mit Regex/NER fallback auf +7d (#3), dedupes via 24h-Hash-Lookup (#4), Feature-Flag-Gate pro Tenant (#5), failed-parse → "needs_review" + Admin-Webhook (#6), self-skip via user-id-match (#7), Counter in Redis für Monthly-Cap mit Dashboard-Display (#8). Risiken: (a) DKIM-Filter false-negatives durch Marketing-Automatisierungen die "menschlich" wirken — Mitigation: zusätzliches Header-Pattern-Matching auf List-Unsubscribe. (b) Due-Date-Parser fehlinterpretiert informelle Sprache ("nächste Woche") — Mitigation: Konservativ immer zu Ende-Woche runden. (c) Dedupe-Hash-Collisions bei ähnlichen Subjects — Mitigation: Fuzzy-Match zusätzlich auf Body.',
    maxIterations: 2,
    timeoutMs: 90_000,
  },
];

// =============================================================================
// Phase 3: Tool-use, deeper long-context, orchestration planning. These are the
// last scenarios informing the Managed-Opus-xhigh decision — if Opus wins
// nowhere here, the final verdict is "niche opt-in only". Real web_search is
// enabled automatically when no web_research tool is registered (see agent.ts
// builtinTools).
// =============================================================================

/** Build a ~50k-token support corpus by scaling the Phase 2 set to 100 tickets. */
function buildLongSupportCorpus(): string {
  const baseTickets: [string, string][] = [
    ['Login broken after password reset', 'I reset my password via the email link but now I cannot log in. Error says "invalid credentials". Tried three times. Cleared cookies. Still same error. Customer is premium tier, urgent.'],
    ['Billing shows CHF 79 instead of CHF 39', 'I signed up for Starter (CHF 39) but my card was charged CHF 79. I never upgraded. Can you refund the difference?'],
    ['Integration with Gmail stopped working', 'Three days ago my Gmail integration stopped syncing. Tried disconnecting and reconnecting — OAuth says "app not verified by Google". Was working fine before.'],
    ['Slow response times in last week', 'Agent responses used to take 2-3 seconds, now 15-30 seconds. Same prompts, same context. Started Tuesday. I have 5 long-running threads open.'],
    ['Cannot delete old threads', 'Trying to delete threads from 6 months ago. Button clicks but nothing happens. Browser console shows 500 error on DELETE /api/threads/{id}.'],
    ['Data export fails silently', 'Requested full data export via Settings > Export. Email never arrived. Ran it twice yesterday and once today. No error shown in UI.'],
    ['Upgrade from Starter to Managed silently failed', 'Clicked upgrade in dashboard, Stripe checkout succeeded, card charged. Instance still shows Starter tier. Would expect auto-provisioning of Managed.'],
    ['Email notifications never arrive', 'Enabled email notifications for task completion. Tested with a 5-minute task. Nothing arrived at my Gmail or my Spam folder. Sender address configured correctly.'],
    ['KG browser crashes on large dataset', 'Opened Knowledge Graph view — 3000+ nodes. Browser hangs for 60 seconds then crashes (Chrome tab killed). Was working at 1500 nodes last month.'],
    ['Password reset email goes to spam in Outlook', 'Corporate users on Outlook report the password reset email lands in spam. Gmail users are fine. SPF/DKIM setup?'],
    ['Webhook retries not working', 'Custom webhook fails intermittently but lynox does not retry. Docs say 3 retries with backoff. Logs show single attempt, no retry.'],
    ['CRM contact merge loses data', 'Merged two duplicate contacts. The notes from the older contact disappeared after merge. Expected: combined notes preserved.'],
    ['Mobile UI: ask_user dialog not dismissable', 'On iPhone Safari, when agent asks a question the dialog blocks the screen. No way to dismiss it. Have to kill the app.'],
    ['Telegram bot stops responding after 24h', 'Set up Telegram bot per docs. Works for ~24h then silently stops. Restart via /start fixes it until next day.'],
    ['API rate limit unclear', 'Got 429 responses but dashboard does not show current rate limit state. Docs say 200/hour. Was I actually over? When does window reset?'],
    ['Cannot change primary email', 'My work email changed. Settings > Account only lets me add secondary emails, not change primary. Support said "use admin portal" — I do not have admin access.'],
    ['File attachments disappear in Telegram', 'Sending images from Telegram to lynox — image arrives but gets processed into text summary then deleted. Would prefer it stays in the thread.'],
    ['DataStore query performance cliff', 'Tables with >10k rows: queries that took 200ms now take 30+ seconds. Smaller tables unaffected. Added indexes, no improvement.'],
    ['Docker image keeps pulling on every restart', 'Self-hosted docker compose setup. Every `docker compose restart` pulls the image fresh instead of using local cache. Bandwidth cost.'],
    ['Web UI dark mode broken on one page', 'Dark mode works everywhere except /settings/billing — page uses light theme colors on dark background. Text unreadable.'],
    ['Multi-factor auth bypass via OAuth login', 'SECURITY: I enabled MFA but logging in via Google OAuth skips the MFA step entirely. Expected: OAuth login should also require MFA.'],
    ['Cost tracking numbers do not match Anthropic dashboard', 'lynox dashboard shows $52 used this month. My Anthropic console shows $31. Which is right? Big discrepancy.'],
    ['Context window auto-compact too aggressive', 'Agent compacts at 75% usage. Sometimes drops useful early context. Is there a way to tune this per-thread?'],
    ['Search returns nothing from archived threads', 'Global search only searches active threads. Archived threads with important history are invisible. Can we include archives?'],
    ['Duplicate entity creation in CRM', 'CRM creates duplicate company entities when agent sees "Acme Corp", "Acme", "acme corp" in different messages. Expected: fuzzy-match and merge.'],
    ['Installation script fails on Apple Silicon', 'Ran the npx installer on M3 Mac. Fails with "no matching docker image for linux/arm64/v8". Expected: multi-arch image.'],
    ['Billing invoice PDF missing VAT line', 'CHF 39 invoice for Swiss customer. PDF shows "Total: CHF 39" with no VAT breakdown. Swiss tax law requires separate VAT line even at 0%.'],
    ['Agent keeps asking same question in loop', 'Agent asks "Which customer do you mean?" — I answer — it asks again — I answer — it asks again. Seems to not be storing the answer. Thread ID consistent.'],
    ['Slack integration: attachments not previewed', 'Posting lynox responses to Slack. Images included in response show as raw URLs, not inline previews. Slack unfurl not triggered.'],
    ['Budget alert fires repeatedly', 'Set $100 monthly budget alert. Email alert fires every hour once I hit 80%. Expected: once per threshold crossing, not continuously.'],
    ['CSV export breaks with commas in values', 'Exported CRM contacts. Rows with commas in company name (e.g. "Smith, Jones & Partners") break the CSV — subsequent columns shift right. No quoting.'],
    ['Search relevance has degraded', 'Semantic search results used to surface the right thread in top 3. Now relevant threads are on page 2-3. Nothing changed on my end. Index stale?'],
    ['Session cookie expires mid-conversation', 'Long agent conversations (>30min) get interrupted with "session expired, please log in again". Lose all in-progress state. Can you extend session TTL?'],
    ['New-thread button disabled in some workspaces', 'In three of my workspaces the "New Thread" button is greyed out. Other workspaces work fine. No clear error message.'],
    ['Agent gives wrong timezone in scheduled tasks', 'Created a task "Send report every Monday 9am". Task fires at 17:00 CET. Account configured to Europe/Zurich. Looks like UTC.'],
    ['File upload progress bar frozen at 99%', 'Uploading 50MB PDF. Progress hits 99% and sits there for 5+ minutes. Network console shows no active transfer. Eventually succeeds or times out randomly.'],
    ['Copy-paste of agent response loses formatting', 'When I copy a markdown response (with bullets, code blocks) and paste into Notion/Slack, everything becomes plain text. Would expect markdown preserved.'],
    ['User invitation emails use wrong sender name', 'Invited a collaborator — email sender shows "lynox-noreply@anthropic.com". Our brand is "Acme Hosting". Can we customize sender identity?'],
    ['Billing cycle shifted unexpectedly', 'My billing date was always the 15th. This month I got charged on the 3rd. No notice. Usage logs show the subscription restarted?'],
    ['Knowledge graph loses entities after import', 'Imported CRM data CSV with 500 companies. Only 340 appear in the knowledge graph afterwards. No error, no warning.'],
    ['Agent memory promotion inconsistent', 'Some facts get auto-promoted to long-term memory, others with identical phrasing do not. Feels random.'],
    ['Dashboard stats do not match individual runs', 'Usage Dashboard says 1200 runs this month. Running `SELECT COUNT(*) FROM runs` via MCP gives 1547. 347 runs missing from dashboard.'],
    ['Telegram bot sends messages to wrong chat', 'Set up bot for my personal chat. When the task completes, notification arrives in a different Telegram group (one I accidentally added the bot to weeks ago).'],
    ['Pipeline execution stops at step 3 silently', 'A 5-step pipeline completes steps 1-2, gets stuck on step 3 with no error, no log entry. Can see the "in_progress" status in DB.'],
    ['Google Drive integration re-uploads files', 'Every sync re-uploads files it already uploaded yesterday. Quota exhausted fast. Expected: only changed files.'],
    ['Password requirements unclear', 'New password field says "at least 8 chars, include number and special". Rejected a 10-char password with 2 numbers and # — no hint what was wrong.'],
    ['Receipt PDF has garbled umlauts', 'My German invoice PDF shows "Gr??ung" instead of "Grüßung". UTF-8 encoding issue? Attached sample.'],
    ['Concurrent edits cause data loss', 'Two users editing the same workspace document — later save overwrites the first without warning. No merge, no conflict detection.'],
    ['Rate limit on free tier too aggressive', 'Free tier shows "3 requests/minute" in docs. Hit limit after 2 requests. Then 429 for 60 seconds. Am I miscounting?'],
    ['Admin audit log missing deletions', 'Audit log shows all create/update events but no delete events. Regulatory requirement — we NEED delete audit trail for GDPR.'],
  ];

  // Repeat to reach 100 tickets (duplicate with slight context variation)
  const tickets: [string, string][] = [];
  for (let i = 0; i < 2; i++) {
    for (const [subject, body] of baseTickets) {
      tickets.push([subject, i === 0 ? body : `Reported again by a different customer — same issue: ${body}`]);
    }
  }
  return tickets.slice(0, 100)
    .map((t, i) => `## Ticket #${String(i + 1).padStart(3, '0')}\n**Subject:** ${t[0]}\n**Body:** ${t[1]}\n`)
    .join('\n');
}

const LONG_SUPPORT_CORPUS = buildLongSupportCorpus();

export const PHASE_3_SCENARIOS: readonly BenchScenario[] = [
  {
    id: 'tool-chain-research',
    category: 'reasoning',
    description: 'Real web_search: recherchiere faktisches aktuelles Wissen + synthesiere. Testet Tool-Chaining + Fakten-Recall.',
    prompt: 'Nutze Websuche: Welche neuen Feature-Releases hat Anthropic für Claude-Modelle im Jahr 2025 angekündigt (z.B. Opus, Sonnet, Haiku-Versionen, Tool-Updates)? Liste maximal 5 konkrete Releases mit Monat und kurzer Beschreibung. Keine Spekulation — nur was du über die Suche belegen kannst.',
    judgeRubric: [
      'Mindestens 3 konkrete Releases genannt (z.B. Claude 4, Sonnet 4.5, Haiku 4.5, Opus 4.1/4.5/4.6, Agent Skills)',
      'Jeder Release mit Monat/Quartal versehen (2025)',
      'Keine offensichtlichen Fakten-Halluzinationen (erfundene Modellnamen oder erfundene Features)',
      'Maximal 5 Items — nicht 10, nicht 2',
      'Erwähnt Quellen oder sagt explizit "laut Websuche"',
    ],
    referenceAnswer: 'Beispielhafte 2025-Releases: Claude 4 Familie (Mai 2025, Sonnet 4 + Opus 4), Claude Opus 4.1 (August 2025), Claude Sonnet 4.5 + Haiku 4.5 (September/Oktober 2025), Claude Opus 4.5 (November 2025), diverse SDK-Updates (computer use, memory tool, extended caching). Exakte Daten variieren — Judge wertet Vollständigkeit und Abwesenheit von Halluzinationen.',
    maxIterations: 5,
    timeoutMs: 180_000,
  },
  {
    id: 'long-context-100',
    category: 'summarization',
    description: '100-Ticket Support-Corpus (~50k Tokens) — Cluster + Security-Bug-Triage. Testet Context-Rot-Grenze.',
    prompt: `Du bekommst einen Auszug aus unserem Support-Ticket-Backlog (100 Tickets). Analysiere und liefere:

1. Top-5 thematische Cluster (je: Titel, betroffene Ticket-Nummern, Root-Cause-Hypothese, Prio 1-3)
2. Alle Security-/Compliance-Bugs (Ticket-Nummer + Schweregrad)
3. Die 3 am dringendsten zu behebenden Tickets (mit Begründung)
4. Zählung: wie viele Tickets fallen in Kategorie "Billing/Invoicing"?

Antworte strukturiert. Keine Halluzinationen.

--- TICKETS ---
${LONG_SUPPORT_CORPUS}`,
    judgeRubric: [
      'Identifiziert mindestens 5 realistische Cluster mit korrekten Ticket-Nummern',
      'Security/Compliance-Bugs umfassen #21/#71 (MFA-Bypass — erscheint 2×), #48 (Audit-Log)',
      'Zählt Billing-Tickets korrekt: ~8-12 in 100 (je nach Kategorisierung: #2, #7, #22, #27, #30, #39, plus Duplikate in 51-100)',
      'Priorisierung nennt Security-Bugs (MFA-Bypass) als höchste Prio',
      'Keine halluzinierten Ticket-Nummern (>100)',
      'Keine Auslassung großer Cluster (Auth, Integration, Data, Billing)',
    ],
    referenceAnswer: 'Cluster: (1) Auth/Login (#1/#10/#16/#21/#33/#51/#60/#66/#71), (2) Billing/Compliance (#2/#7/#22/#27/#30/#39/#46/#52/#57/#72), (3) Integration/Sync (#3/#8/#11/#14/#17/#19/#29/#40/#45/#53/#58/#61/#67), (4) Data/Performance (#4/#18/#34/#54/#68), (5) UI/UX (#5/#13/#20/#31/#36/#37/#55/#63/#70/#87). Security-Bugs: #21/#71 MFA-Bypass (CRITICAL), #48/#98 Audit-Log-Lücke (HIGH für GDPR). Priorität: MFA-Bypass > Billing-Discrepancies > Audit-Log. Billing-Kategorie: ~10-12 Tickets (je nach Definition).',
    maxIterations: 2,
    timeoutMs: 180_000,
  },
  {
    id: 'orchestration-planning',
    category: 'reasoning',
    description: 'Multi-Agent-Orchestrations-Plan. Testet ob Modell sinnvolle Spawn-Entscheidungen trifft.',
    prompt: `Als lynox-Agent sollst du folgendes Projekt planen — entscheide wann parallele Subagents sinnvoll sind und wann sequentielle Schritte:

**Projekt:** Launch eines neuen Pricing-Tiers "Managed Team" (CHF 199/mo) für 3-10 User pro Tenant. Alles soll in 4 Wochen live sein.

**Sub-Tasks:**
- Tech: Tenant-Modell um Multi-User erweitern (User-Rollen, Shared-Billing)
- Billing: Stripe-Setup für Volume-Tier + Seat-basierte Upgrades
- Marketing: Landing-Page-Copy + Pricing-Page-Update
- Sales: Outbound-Liste von 50 Prospects + Cold-Email-Sequence
- Legal: AGB-Update für Multi-User-Handling + DPA-Revision
- Support: Docs + FAQ + Onboarding-Flow für Team-Accounts

**Liefer-Format:**
1. Workflow-Diagramm in Text (5-8 Steps), markiere parallele/sequentielle
2. Für jeden Step: welcher spezialisierte Subagent (researcher, creator, operator, reviewer)?
3. Geschätzte Dauer pro Step + kritischer Pfad
4. 3 explizite Abhängigkeiten die sequentiell bleiben MÜSSEN

Sei konkret — keine Generik.`,
    judgeRubric: [
      'Sinnvolle Parallelisierung: unabhängige Streams (Tech vs Marketing vs Legal) laufen parallel',
      'Sequentielle Dependencies korrekt: Tech muss VOR Sales outbound stehen (sonst verkauft man Vaporware)',
      'Jeder Step hat begründete Subagent-Zuweisung (nicht alles "creator")',
      'Kritischer Pfad konkret identifiziert mit Begründung',
      'Mindestens 3 echte (nicht künstliche) Abhängigkeiten identifiziert',
      '5-8 Workflow-Steps — nicht 3 generische, nicht 20 Mikro-Tasks',
      'Keine erfundenen Agent-Typen außerhalb der genannten Rollen',
    ],
    referenceAnswer: 'Parallel: Tech + Legal + Marketing + Sales-Recherche laufen gleichzeitig in Woche 1-2. Sequenzen: Billing benötigt Tech-Definition der User-Rollen (→ Wartezeit bis Woche 2), Landing Page benötigt Pricing finalized von Legal-Review, Sales-Outbound wartet auf Marketing-Copy UND Tech-Ready. Subagents: researcher (Sales-Prospects, Competitive-Analysis), creator (Landing-Copy, Docs, Email-Sequence), operator (Tech + Billing-Integration + DB-Migrations), reviewer (Legal-AGB, QA). Kritischer Pfad: Tech (2 W) → Billing (1 W) → QA + Onboarding (1 W). 3 Mandatory-Sequential: (1) Legal AGB vor Landing Page, (2) Tech User-Rollen vor Billing Seat-Flow, (3) Tech + QA vor Sales-Go-Live.',
    maxIterations: 2,
    timeoutMs: 90_000,
  },
  {
    id: 'creative-copy-v2',
    category: 'reasoning',
    description: 'Entschärfte Creative-Copy-Version: 3 Email-Openings mit loseren Constraints.',
    prompt: `Schreib 3 unterschiedliche Email-Openings (je 2-3 Sätze) für eine Outbound-Kampagne an Operations-Leader in 50-200-Personen-Firmen. Kontext: lynox ersetzt SaaS-Tool-Stacks durch KI-Agents.

Constraints:
- Jedes Opening öffnet MIT einer spezifischen Situation/Pain, nicht mit "Ich schreibe Ihnen weil..."
- Keine Floskeln ("im Zeitalter der Digitalisierung", "moderne Unternehmen", "in der heutigen Zeit")
- Je Opening ein anderer Angle (z.B. #1: Kosten-Angle, #2: Produktivitäts-Angle, #3: Tool-Frust-Angle)
- Deutsch, Sie-Form
- Je Opening 2-3 Sätze — nicht mehr, nicht weniger

Format: nummerierte Liste, jedes Opening als Block, kurz Angle-Label darunter.`,
    judgeRubric: [
      'Genau 3 Varianten geliefert',
      'Jedes Opening 2-3 Sätze (Varianz von ±1 Satz tolerieren)',
      'Keine Floskeln wie "im Zeitalter der Digitalisierung" o.ä.',
      'Jedes Opening hat einen erkennbar anderen Angle',
      'Jedes Opening öffnet spezifisch (mit Situation), nicht generisch',
      'Stilistisch geeignet für B2B-Outbound (nicht zu salesy, nicht zu verspielt)',
    ],
    referenceAnswer: '1. (Kosten-Angle): "Ihre Ops-Abteilung zahlt vermutlich aktuell zwischen 15 und 30 Tools pro Monat — von CRM über Projekt-Management bis Billing. Für die meisten 50-200-Personen-Firmen summiert sich das auf über CHF 100k/Jahr, bevor jemand die Integration zusammenklebt."\n2. (Produktivitäts-Angle): "Wie oft kopieren Ihre Teams Daten manuell zwischen Tabellen, Tickets und Dashboards? Wir haben gemessen dass Ops-Leader ~40% ihrer Zeit in Tool-Navigation statt in Arbeit verbringen."\n3. (Tool-Frust-Angle): "Jede neue SaaS-Integration fühlt sich wie eine Pflicht, keine Lösung. Ihre Teams wechseln zwischen Dashboards, weil keines allein den Job macht."',
    maxIterations: 1,
    timeoutMs: 60_000,
  },
];

/**
 * HN-companion-post scenarios — 4 picks designed so the bench output can
 * answer the FOUR questions every HN reader asks about agent runtimes:
 *  - "is this cheap on simple tasks?"  → trivial-question (baseline)
 *  - "does it reason?"                 → code-review (analysis)
 *  - "does it compress?"               → summarization (mid-context)
 *  - "does it CHAIN tools?"            → tool-chain-population-lookup
 *
 * The fourth is the Pass-Rate killer: open-weights models that fail
 * stand out instantly. The first three reuse Phase-1 scenarios verbatim
 * — same prompts, same rubrics — so the bench output remains directly
 * comparable to the 2026-04-17 baseline.
 */
const TOOL_CHAIN_POPULATION_LOOKUP: BenchScenario = {
  id: 'tool-chain-population-lookup',
  category: 'tool-chain',
  description: 'Tool-chain stress test — agent must call two mock tools 3+ times to combine a multi-step answer.',
  prompt: `You have two tools available: \`lookup_city_by_rank(rank)\` returns the name of the Nth-most-populated Swiss city, and \`lookup_city_population(city)\` returns its population.

Task: Find the COMBINED population of Switzerland's three most populated cities. Use the tools to look up each rank, then each population, then sum them. Report the total as a single integer in your final answer.

Do NOT guess. Use the tools.`,
  judgeRubric: [
    'Macht mindestens 3 lookup_city_by_rank-Calls (rank=1, 2, 3) und 3 lookup_city_population-Calls',
    'Schliesst die Tool-Chain ab — fragt nicht zwischendrin nach Bestätigung',
    'Finale Antwort enthält eine einzelne Integer-Summe in der Nähe von ~800k (Toleranz ±10%)',
    'Halluziniert keine Populationen — Werte stammen ausschliesslich aus Tool-Returns',
    'Korrekte Identifikation der Top-3 Städte (Zürich, Geneva, Basel)',
  ],
  referenceAnswer: `Top-3 Cities: Zürich (421,900), Geneva (203,800), Basel (173,800). Combined total: ${String(SWISS_TOP3_POPULATION_TOTAL)}.`,
  // Cap=20 (was 8) because tool-calling styles differ wildly across providers:
  // Sonnet converges in 3 iter (2 parallel tools per turn); Mistral with
  // parallel_tool_calls=false needs 7 iter (one tool per turn); Llama can
  // exceed both. Cap=8 unfairly penalized verbose-but-correct tool-callers.
  maxIterations: 20,
  timeoutMs: 90_000,
  passCheck: (run) => {
    // Three checks, all must pass:
    //   1. At least 6 tool calls (3 rank + 3 population lookups, minimum).
    //   2. Output contains a number within ±20% of the canonical total.
    //   3. No agent-side error.
    if (run.error) return false;
    if (run.toolCallCount < 6) return false;
    const numbers = (run.output.match(/\d[\d,'_.\s]*\d/g) ?? [])
      .map(s => parseInt(s.replace(/[\s,'_.]/g, ''), 10))
      .filter(n => Number.isFinite(n));
    if (numbers.length === 0) return null; // fall back to judge score
    const tolerance = SWISS_TOP3_POPULATION_TOTAL * 0.2;
    return numbers.some(n => Math.abs(n - SWISS_TOP3_POPULATION_TOTAL) <= tolerance);
  },
};

/**
 * HN_SCENARIOS — reuses 3 chat-only scenarios from Phase 1 (looked up
 * by id; if any are renamed in SCENARIOS this throws at module load
 * which is the correct fail-mode).
 */
function pickScenario(id: string): BenchScenario {
  const found = SCENARIOS.find(s => s.id === id);
  if (!found) throw new Error(`HN_SCENARIOS references missing scenario "${id}". Update scenarios.ts.`);
  return found;
}

export const HN_SCENARIOS: readonly BenchScenario[] = [
  pickScenario('trivial-question'),
  pickScenario('code-review'),
  pickScenario('summarization'),
  TOOL_CHAIN_POPULATION_LOOKUP,
];

/** All scenarios: Phase 1 + Phase 2 + Phase 3 + HN tool-chain. */
export const ALL_SCENARIOS: readonly BenchScenario[] = [
  ...SCENARIOS,
  ...PHASE_2_SCENARIOS,
  ...PHASE_3_SCENARIOS,
  TOOL_CHAIN_POPULATION_LOOKUP,
];

export function getScenario(id: string): BenchScenario | undefined {
  return ALL_SCENARIOS.find(s => s.id === id);
}
