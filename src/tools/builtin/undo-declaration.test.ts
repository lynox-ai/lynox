import { describe, it, expect } from 'vitest';
import type { ToolEntry, UndoKind } from '../../types/index.js';
import * as builtinTools from './index.js';

/**
 * The declaration half of the undo contract (PRD bulk-changes-reversible §1.4, §3.6):
 * every builtin tool either says what reversing its effect takes (`undo`), or is named
 * here with the reason it has no effect of its own. Fail-closed on purpose — a NEW tool
 * that declares nothing and is on neither list fails this file, so the default for a
 * tool nobody thought about is a red test, not a silent gap in the contract.
 */

const TOOLS: readonly ToolEntry[] = Object.values(builtinTools).filter(
  (v): v is ToolEntry =>
    typeof v === 'object' && v !== null && 'definition' in v &&
    typeof (v as { definition: unknown }).definition === 'object',
);
const byName = new Map(TOOLS.map((t) => [t.definition.name, t]));

/** No effect outside the conversation: nothing to reverse. */
const NO_EFFECT: Readonly<Record<string, string>> = {
  archive_search: 'reads durable memory',
  artifact_history: 'lists versions',
  artifact_list: 'lists artifacts',
  ask_user: 'asks; the answer is conversation state',
  bulk_status: 'reads counters and phases of a bulk run',
  calendar_read: 'reads a feed',
  contacts_search: 'reads contacts',
  data_store_list: 'lists collections',
  data_store_query: 'reads rows',
  diagnose_workflow_run: 'reads a run trace',
  export_workflow: 'returns a share block, writes nothing',
  memory_focus: 'session-only override, nothing is stored',
  memory_list: 'reads memory',
  memory_recall: 'reads memory',
  plan_task: 'returns a plan, writes nothing',
  read_file: 'reads a file',
  recall: 'reads durable memory',
  recall_tool_result: 'reads a stored tool result',
  suggest_follow_ups: 'emits UI chips',
  task_list: 'lists tasks',
};

/**
 * Consent without an effect of its own: what these do is run OTHER tools, and those
 * carry their own declarations. The one place `destructive` legitimately stands
 * without `undo` (PRD §3.6 names `spawn_agent`).
 */
const DELEGATES: Readonly<Record<string, string>> = {
  spawn_agent: 'the sub-agent’s tools carry the effects',
};

describe('ToolEntry.undo declaration', () => {
  it('every builtin tool declares undo, or is named with the reason it has no effect', () => {
    const undeclared = TOOLS
      .map((t) => t.definition.name)
      .filter((n) => byName.get(n)!.undo === undefined && !(n in NO_EFFECT) && !(n in DELEGATES));
    expect(undeclared).toEqual([]);
  });

  it('a named tool does not also declare undo (the lists cannot hide a declaration)', () => {
    const both = [...Object.keys(NO_EFFECT), ...Object.keys(DELEGATES)]
      .filter((n) => byName.get(n)?.undo !== undefined);
    expect(both).toEqual([]);
  });

  it('every named tool exists, so a stale entry cannot sit on either list', () => {
    const stale = [...Object.keys(NO_EFFECT), ...Object.keys(DELEGATES)].filter((n) => !byName.has(n));
    expect(stale).toEqual([]);
  });

  it('destructive implies undo, except the named delegates', () => {
    const missing = TOOLS
      .filter((t) => t.destructive !== undefined && t.undo === undefined)
      .map((t) => t.definition.name)
      .filter((n) => !(n in DELEGATES));
    expect(missing).toEqual([]);
  });

  it('a tool with no effect carries no destructive flag', () => {
    const contradictory = Object.keys(NO_EFFECT).filter((n) => byName.get(n)?.destructive !== undefined);
    expect(contradictory).toEqual([]);
  });

  // PRD §3.6 lists `memory_store` as compensatable. The code says otherwise: its knowledge-
  // layer write supersedes contradicted memories, so deleting what it stored does not bring
  // them back. The declaration follows the code; the PRD line is what moves.
  it('the classes PRD §3.6 names are the classes declared (memory_store corrected, see above)', () => {
    const expected: Record<string, UndoKind> = {
      write_file: 'restorable',
      edit_file: 'restorable',
      memory_update: 'restorable',
      memory_block_edit: 'restorable',
      memory_store: 'restorable',
      remember: 'restorable',
      bulk_plan: 'restorable',
      task_update: 'restorable',
      contacts_save: 'restorable',
      subjects_merge: 'restorable',
      bash: 'none',
    };
    const actual = Object.fromEntries(Object.keys(expected).map((n) => [n, byName.get(n)?.undo]));
    expect(actual).toEqual(expected);
  });

  describe('per-input classification', () => {
    const classify = (name: string, input: unknown): UndoKind | null => {
      const undo = byName.get(name)!.undo;
      if (typeof undo !== 'function') throw new Error(`${name} does not classify per input`);
      return undo(input);
    };

    it('http_request: PUT/PATCH restorable, POST and DELETE none, reads no effect', () => {
      expect(classify('http_request', { url: 'https://x.test', method: 'PUT' })).toBe('restorable');
      expect(classify('http_request', { url: 'https://x.test', method: 'patch' })).toBe('restorable');
      expect(classify('http_request', { url: 'https://x.test', method: 'POST' })).toBe('none');
      expect(classify('http_request', { url: 'https://x.test', method: 'DELETE' })).toBe('none');
      expect(classify('http_request', { url: 'https://x.test', method: 'HEAD' })).toBeNull();
      expect(classify('http_request', { url: 'https://x.test' })).toBeNull();
    });

    it('api_setup: reads no effect, fetch_token none, every other action restorable', () => {
      expect(classify('api_setup', { action: 'list' })).toBeNull();
      expect(classify('api_setup', { action: 'view', id: 'a' })).toBeNull();
      expect(classify('api_setup', { action: 'create' })).toBe('restorable');
      expect(classify('api_setup', { action: 'delete', id: 'a' })).toBe('restorable');
      expect(classify('api_setup', { action: 'fetch_token', id: 'a' })).toBe('none');
    });

    it('artifact_save: an update restorable, a new artifact compensatable', () => {
      expect(classify('artifact_save', { title: 't', content: 'c', id: 'a1' })).toBe('restorable');
      expect(classify('artifact_save', { title: 't', content: 'c' })).toBe('compensatable');
    });
  });
});
