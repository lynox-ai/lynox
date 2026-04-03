import type { AutonomyLevel } from '../types/index.js';
import { channels } from './observability.js';

export interface InputGuardResult {
  action: 'allow' | 'flag' | 'block';
  reason?: string | undefined;
  category?: 'malware' | 'exploit' | 'phishing' | 'weaponization' | 'social_engineering' | 'illegal' | undefined;
}

interface PatternEntry {
  pattern: RegExp;
  label: string;
  category: NonNullable<InputGuardResult['category']>;
}

/**
 * Tier 1 — Hard block: always blocked regardless of autonomy level.
 * Patterns match INTENT COMBINATIONS (verb + target), not isolated keywords.
 * Discussing "ransomware" is fine; requesting "create ransomware" is not.
 */
const BLOCKED_PATTERNS: PatternEntry[] = [
  // Malware creation
  { pattern: /\b(write|create|build|generate|code|develop|make)\b.{0,80}\b(ransomware|keylogger|rootkit|backdoor|trojan|worm|botnet|spyware|rat)\b/i, label: 'malware creation request', category: 'malware' },
  { pattern: /\b(ransomware|keylogger|rootkit|backdoor|trojan|worm|botnet|spyware)\b.{0,80}\b(write|create|build|generate|code|develop|make)\b/i, label: 'malware creation request', category: 'malware' },

  // Exploit frameworks — usage in creation context
  { pattern: /\b(write|create|build|generate|set\s*up|configure|deploy)\b.{0,80}\b(metasploit|cobalt[\s-]?strike|mimikatz|empire|bloodhound|beef[\s-]?xss|sliver)\b/i, label: 'exploit framework setup', category: 'exploit' },
  { pattern: /\b(metasploit|cobalt[\s-]?strike|mimikatz|empire|bloodhound|beef[\s-]?xss|sliver)\b.{0,80}\b(payload|listener|implant|beacon|stager)\b/i, label: 'exploit payload creation', category: 'exploit' },

  // Phishing
  { pattern: /\b(create|build|generate|write|design)\b.{0,80}\b(phishing|credential[\s-]?harvest(?:er|ing)?|fake[\s-]?login|clone[\s-]?site)\b/i, label: 'phishing creation request', category: 'phishing' },
  { pattern: /\b(phishing|credential[\s-]?harvest(?:er|ing)?|fake[\s-]?login)\b.{0,80}\b(create|build|generate|write|design)\b/i, label: 'phishing creation request', category: 'phishing' },

  // Weaponization — generic exploit/malware creation
  // Requires CREATION verb directly followed by the target (not separated by "prevention", "detection", etc.)
  { pattern: /\b(write|create|build|develop|generate)\b\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(exploit|malware|virus|zero[\s-]?day|shellcode)\b/i, label: 'weaponization request', category: 'weaponization' },
  { pattern: /\b(bypass|evade|disable)\b.{0,80}\b(antivirus|av|edr|endpoint[\s-]?detection|firewall|ids|ips|siem|waf)\b/i, label: 'security evasion request', category: 'weaponization' },
];

/**
 * Tier 2 — Soft flag: flagged in supervised/guided, blocked in autonomous.
 * These have legitimate uses but warrant scrutiny.
 */
const FLAGGED_PATTERNS: PatternEntry[] = [
  // Social engineering
  { pattern: /\b(write|create|craft)\b.{0,80}\b(social[\s-]?engineering|pretexting|vishing)\b/i, label: 'social engineering script', category: 'social_engineering' },

  // Brute force / credential attacks — require attack verb or target context
  { pattern: /\b(brute[\s-]?force|credential[\s-]?stuff(?:ing)?|password[\s-]?spray)\b.{0,80}\b(the|this|that|target|on|against)\b/i, label: 'credential attack', category: 'exploit' },
  { pattern: /\b(run|launch|perform|execute|start)\b.{0,80}\b(brute[\s-]?force|credential[\s-]?stuff|password[\s-]?spray|dictionary[\s-]?attack)\b/i, label: 'credential attack', category: 'exploit' },

  // DDoS — require attack context, not just the term alone
  { pattern: /\b(launch|start|run|set\s*up|perform|execute)\b.{0,80}\b(ddos|dos[\s-]?attack|traffic[\s-]?flood|syn[\s-]?flood)\b/i, label: 'denial of service', category: 'exploit' },
  { pattern: /\b(ddos|dos)\s+(attack|tool|script|bot)\b/i, label: 'denial of service', category: 'exploit' },
  { pattern: /\b(traffic[\s-]?flood|syn[\s-]?flood|amplification[\s-]?attack)\b/i, label: 'denial of service', category: 'exploit' },

  // Privacy violations
  { pattern: /\b(doxx|doxing|track\b.*without\b.*consent|stalk|surveillance\b.*without\b.*consent)\b/i, label: 'privacy violation', category: 'illegal' },
];

/**
 * Check user input for malicious intent.
 * Runs BEFORE sending to the LLM — acts as a secondary defense
 * behind the LLM's own refusal mechanisms.
 */
export function checkInput(message: string, autonomy?: AutonomyLevel): InputGuardResult {
  // Tier 1 — always blocked
  for (const { pattern, label, category } of BLOCKED_PATTERNS) {
    if (pattern.test(message)) {
      if (channels.securityBlocked.hasSubscribers) {
        channels.securityBlocked.publish({
          event_type: 'content_blocked',
          input_preview: message.slice(0, 500),
          decision: 'blocked',
          detail: label,
          autonomy_level: autonomy,
        });
      }
      return { action: 'block', reason: label, category };
    }
  }

  // Tier 2 — flag or block depending on autonomy
  for (const { pattern, label, category } of FLAGGED_PATTERNS) {
    if (pattern.test(message)) {
      const action = autonomy === 'autonomous' ? 'block' : 'flag';
      if (channels.securityFlagged.hasSubscribers) {
        channels.securityFlagged.publish({
          event_type: 'content_flagged',
          input_preview: message.slice(0, 500),
          decision: action === 'block' ? 'blocked' : 'flagged',
          detail: label,
          autonomy_level: autonomy,
        });
      }
      return { action, reason: label, category };
    }
  }

  return { action: 'allow' };
}
