/**
 * The lazy-tool reachability matrix as data, outside the `.test.ts` file so an offline
 * test can import it without registering the online suite (tests/online-guards.test.ts).
 */
export interface ReachabilityCase {
  /** The LAZY_DEFERRED_TOOLS member this case targets. */
  readonly tool: string;
  /**
   * Conversation turns, in order. Only the LAST turn is asserted (search +
   * invoke must happen in response to it); earlier turns exist purely to
   * establish realistic context a user would actually have (an artifact just
   * saved, a message UID from a prior search/triage).
   */
  readonly turns: readonly string[];
  /**
   * Tool names that count as a correct catch for this case. Usually just
   * `tool` itself; a couple of cases tolerate one closely-related sibling in
   * the same family so the assertion tests the MECHANISM (search → discover
   * → invoke a plausible tool) rather than flaking on legitimate model
   * variance in which exact family member it reaches for first.
   */
  readonly acceptableToolNames: readonly string[];
}

export const CASES: readonly ReachabilityCase[] = [
  {
    tool: 'google_calendar',
    turns: ["What's on my calendar tomorrow?"],
    acceptableToolNames: ['google_calendar'],
  },
  {
    tool: 'google_docs',
    turns: ["Open my 'Q3 Planning' Google Doc and tell me what it says."],
    acceptableToolNames: ['google_docs'],
  },
  {
    tool: 'google_drive',
    turns: ["Search my Google Drive for a file called 'Contract Draft'."],
    acceptableToolNames: ['google_drive'],
  },
  {
    tool: 'google_sheets',
    turns: ["Read the data in my 'Budget 2026' Google Sheet."],
    acceptableToolNames: ['google_sheets'],
  },
  {
    tool: 'mail_connect',
    turns: ['Connect my Gmail account so you can read my inbox.'],
    acceptableToolNames: ['mail_connect'],
  },
  {
    tool: 'mail_read',
    // Turn 1 gives the model a real UID to act on (mail_triage), turn 2 needs
    // mail_read specifically — the two tools are distinct deferred members.
    turns: [
      "What's new in my inbox today?",
      'Open the Acme invoice email and show me the full text.',
    ],
    acceptableToolNames: ['mail_read'],
  },
  {
    tool: 'mail_reply',
    turns: [
      'Search my inbox for the message from Acme about the contract.',
      'Reply to that message and say we accept the terms.',
    ],
    acceptableToolNames: ['mail_reply'],
  },
  {
    tool: 'mail_search',
    turns: ['Search my inbox for the invoice from Acme.'],
    acceptableToolNames: ['mail_search'],
  },
  {
    tool: 'mail_send',
    turns: ['Send an email to sarah@example.com letting her know the report is ready.'],
    acceptableToolNames: ['mail_send'],
  },
  {
    tool: 'mail_triage',
    turns: ["What's new in my inbox today? Anything important?"],
    acceptableToolNames: ['mail_triage'],
  },
  {
    tool: 'api_setup',
    turns: ['Connect the Stripe API so you can use it going forward.'],
    acceptableToolNames: ['api_setup'],
  },
  {
    tool: 'media_process',
    turns: ["I have a video file called 'clip.mov' in my files — convert it to mp4 for me."],
    acceptableToolNames: ['media_process'],
  },
  {
    tool: 'subjects_merge',
    turns: ["'Ada' and 'Dr. Ada Lovelace' in my notes are the same person — merge them into one."],
    acceptableToolNames: ['subjects_merge'],
  },
  {
    tool: 'artifact_delete',
    turns: [
      "Save these launch notes as an artifact titled 'Launch Checklist': verify staging, confirm rollback plan, notify support.",
      'Delete the Launch Checklist artifact you just saved.',
    ],
    acceptableToolNames: ['artifact_delete'],
  },
  {
    tool: 'artifact_history',
    turns: [
      "Save these launch notes as an artifact titled 'Launch Checklist': verify staging, confirm rollback plan, notify support.",
      'Show me the version history of the Launch Checklist artifact.',
    ],
    acceptableToolNames: ['artifact_history'],
  },
  {
    tool: 'artifact_restore',
    turns: [
      "Save these launch notes as an artifact titled 'Launch Checklist': verify staging, confirm rollback plan, notify support.",
      'Actually, revert the Launch Checklist artifact to an earlier version.',
    ],
    acceptableToolNames: ['artifact_restore'],
  },
  {
    tool: 'artifact_list',
    turns: ["What documents or artifacts have I saved so far?"],
    acceptableToolNames: ['artifact_list'],
  },
];
