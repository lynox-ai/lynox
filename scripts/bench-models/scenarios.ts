import type { BenchScenario } from './types.js';

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
    prompt: 'Erkläre den Unterschied zwischen TCP und UDP in maximal zwei Sätzen. Nenne je ein typisches Einsatzgebiet.',
    judgeRubric: [
      'Nennt TCP als verbindungsorientiert / zuverlässig / geordnet',
      'Nennt UDP als verbindungslos / unzuverlässig / geringerer Overhead',
      'Nennt je ein sinnvolles Einsatzgebiet (z.B. TCP: HTTP/SSH/E-Mail, UDP: DNS/Video-Streaming/VoIP/Gaming)',
      'Maximal ~50 Wörter — kurz und präzise',
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

export function getScenario(id: string): BenchScenario | undefined {
  return SCENARIOS.find(s => s.id === id);
}
