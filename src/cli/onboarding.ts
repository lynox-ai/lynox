/**
 * Business onboarding flow — captures basic business context after setup wizard.
 * Stores a structured business profile in memory (facts namespace, global scope).
 * Runs once after first setup; re-runnable via /profile update.
 */

import { createInterface, type Interface as ReadlineInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { BOLD, DIM, GREEN, RESET } from './ansi.js';

const PROFILE_MARKER = '[business-profile]';
const MEMORY_DIR = join(homedir(), '.nodyn', 'memory', '_global');
const FACTS_FILE = join(MEMORY_DIR, 'facts.txt');

interface OnboardingQuestion {
  prompt: string;
  hint: string;
  field: string;
}

const QUESTIONS: readonly OnboardingQuestion[] = [
  {
    prompt: 'What does your business do?',
    hint: 'e.g., Digital marketing agency, 8 clients, Google Ads + SEO',
    field: 'Business',
  },
  {
    prompt: 'What tools do you use daily?',
    hint: 'e.g., Google Ads, Sheets, Slack, Shopify',
    field: 'Tools',
  },
  {
    prompt: 'How do you typically report to clients?',
    hint: 'e.g., weekly PDF, monthly Google Doc',
    field: 'Reporting',
  },
  {
    prompt: 'What\'s your biggest recurring time sink?',
    hint: 'e.g., Monday morning data pull, manual invoice generation',
    field: 'Pain point',
  },
] as const;

/**
 * Check if a business profile already exists in memory.
 */
export async function hasBusinessProfile(): Promise<boolean> {
  try {
    const content = await readFile(FACTS_FILE, 'utf-8');
    return content.includes(PROFILE_MARKER);
  } catch {
    return false;
  }
}

/**
 * Run the business onboarding flow.
 * Returns true if a profile was saved, false if skipped.
 */
export async function runBusinessOnboarding(rl?: ReadlineInterface): Promise<boolean> {
  const ownRl = !rl;
  if (!rl) {
    rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY === true });
  }

  try {
    stdout.write(`\n${DIM}── Business Profile ──────────────────────────────────────${RESET}\n\n`);
    stdout.write('NODYN works better when it knows your business.\n');
    stdout.write(`${DIM}Answer a few quick questions — or press Enter to skip any.${RESET}\n\n`);

    const answers: Record<string, string> = {};
    let hasAnyAnswer = false;

    for (const q of QUESTIONS) {
      const answer = await rl.question(`${BOLD}${q.prompt}${RESET}\n  ${DIM}${q.hint}${RESET}\n  › `);
      if (answer.trim()) {
        answers[q.field] = answer.trim();
        hasAnyAnswer = true;
      }
      stdout.write('\n');
    }

    if (!hasAnyAnswer) {
      stdout.write(`${DIM}Skipped. You can run /profile update anytime.${RESET}\n\n`);
      return false;
    }

    // Build profile text
    const lines: string[] = [PROFILE_MARKER];
    for (const q of QUESTIONS) {
      const value = answers[q.field];
      if (value) {
        lines.push(`${q.field}: ${value}`);
      }
    }
    const profileText = lines.join('\n');

    // Write to facts memory file
    await saveProfile(profileText);

    stdout.write(`${GREEN}✓${RESET} Business profile saved. NODYN will remember this across sessions.\n\n`);
    return true;
  } finally {
    if (ownRl) {
      rl.close();
    }
  }
}

/**
 * Display the current business profile.
 */
export async function showProfile(): Promise<void> {
  const profile = await loadProfile();
  if (!profile) {
    stdout.write('No business profile set. Run /profile update to create one.\n');
    return;
  }
  stdout.write(`\n${DIM}── Business Profile ──────────────────────────────────────${RESET}\n\n`);
  stdout.write(`${profile}\n\n`);
  stdout.write(`${DIM}Run /profile update to change, /profile clear to remove.${RESET}\n\n`);
}

/**
 * Clear the business profile from memory.
 */
export async function clearProfile(): Promise<boolean> {
  try {
    const content = await readFile(FACTS_FILE, 'utf-8');
    if (!content.includes(PROFILE_MARKER)) return false;

    // Remove profile block (from marker to next empty line or end)
    const lines = content.split('\n');
    const filtered: string[] = [];
    let inProfile = false;

    for (const line of lines) {
      if (line.startsWith(PROFILE_MARKER)) {
        inProfile = true;
        continue;
      }
      if (inProfile && line.trim() === '') {
        inProfile = false;
        continue;
      }
      if (inProfile) continue;
      filtered.push(line);
    }

    const updated = filtered.join('\n').trim();
    if (updated) {
      await writeFile(FACTS_FILE, updated, 'utf-8');
    } else {
      // File would be empty — write empty string
      await writeFile(FACTS_FILE, '', 'utf-8');
    }

    stdout.write(`${GREEN}✓${RESET} Business profile cleared.\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the business profile text from memory.
 */
async function loadProfile(): Promise<string | null> {
  try {
    const content = await readFile(FACTS_FILE, 'utf-8');
    const startIdx = content.indexOf(PROFILE_MARKER);
    if (startIdx === -1) return null;

    // Extract from marker to next empty line or end
    const block = content.slice(startIdx);
    const endIdx = block.indexOf('\n\n');
    const profile = endIdx !== -1 ? block.slice(0, endIdx) : block;

    // Return without the marker line
    return profile
      .split('\n')
      .filter(l => l !== PROFILE_MARKER)
      .join('\n')
      .trim() || null;
  } catch {
    return null;
  }
}

/**
 * Save or replace the business profile in the facts memory file.
 */
async function saveProfile(profileText: string): Promise<void> {
  await mkdir(MEMORY_DIR, { recursive: true });

  let existing = '';
  try {
    existing = await readFile(FACTS_FILE, 'utf-8');
  } catch {
    // File doesn't exist yet
  }

  if (existing.includes(PROFILE_MARKER)) {
    // Replace existing profile block
    const lines = existing.split('\n');
    const filtered: string[] = [];
    let inProfile = false;

    for (const line of lines) {
      if (line.startsWith(PROFILE_MARKER)) {
        inProfile = true;
        continue;
      }
      if (inProfile && line.trim() === '') {
        inProfile = false;
        continue;
      }
      if (inProfile) continue;
      filtered.push(line);
    }

    const base = filtered.join('\n').trim();
    const updated = base ? `${base}\n\n${profileText}` : profileText;
    await writeFile(FACTS_FILE, updated, 'utf-8');
  } else {
    // Append to existing content
    const updated = existing.trim()
      ? `${existing.trim()}\n\n${profileText}`
      : profileText;
    await writeFile(FACTS_FILE, updated, 'utf-8');
  }
}
