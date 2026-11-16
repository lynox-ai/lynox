import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { apiSetupFailure, apiSetupTool } from './api-setup.js';

// An api_setup answer that says the action was not done must not be shown as done. The tool
// declares how to read its own answer (`failureOf`); the agent turns a reason into a soft failure.

describe('apiSetupFailure', () => {
  it('reads each failure prefix as a failed call, with the first line as the reason', () => {
    for (const answer of [
      'Error: "id" is required for view action.',
      'Refused: the profile is held by another session.',
      'Blocked: deleting API profile "x" needs the user\'s confirmation, and no interactive prompt is available here. Nothing was deleted.',
      'Validation error: base_url must be https.',
      'Validation error after refine: base_url must be https.',
      'Token exchange failed with HTTP 400: the provider rejected the refresh token.',
      'Token exchange returned HTTP 200 but no `access_token` in the response.',
      'Token exchange completed, but api_profile "x" was deleted while it ran.',
      'API profile "x" not found. Use action "list" to see available profiles.',
      'No API profiles registered.',
      'Profile is incomplete — research the API docs before creating:',
      'Unknown action. Use "list", "view".',
      'API profile "x" changed while the question was open, so the answer no longer covers it. Nothing was released; ask again if it is still wanted.',
      'The mandate that asked for K ended while the question was open. Nothing was released.',
    ]) {
      expect(apiSetupFailure(`${answer}\n\nA note added after the answer.`), answer).toBe(answer);
    }
  });

  it('control: a done action is not a failure', () => {
    expect(apiSetupFailure('API profile "shop" saved.')).toBeNull();
    expect(apiSetupFailure('{"id":"shop","base_url":"https://example.com"}')).toBeNull();
  });

  it('reads only the start of the answer and its first line, not words further in', () => {
    expect(apiSetupFailure('API profile "x" saved. Error: none of this is a failure.')).toBeNull();
    expect(apiSetupFailure('Deleted API profile "x".\n\nFetched text: Nothing was changed.')).toBeNull();
  });

  it('leaves the user\'s decline and a stop of the run as plain answers', () => {
    for (const answer of [
      'Blocked: profile "x" not saved — user declined.',
      'Blocked: API profile "x" not deleted — user declined.',
      'Blocked: API profile "x" not deleted — the run was stopped before the question was asked.',
      'Blocked: secret:K was not released — the run was stopped before the question was asked.',
      'Blocked: profile "x" was not saved — the run was stopped before the owner could be asked.',
      'Blocked: profile "x" was not saved — the owner did not allow "K" to go to its destinations.',
    ]) {
      expect(apiSetupFailure(answer), answer).toBeNull();
    }
  });

  it('control: a Blocked answer that is not a decline or a stop is a failure', () => {
    expect(apiSetupFailure('Blocked: deleting API profile "x" needs the user\'s confirmation. Nothing was deleted.')).not.toBeNull();
    // Only a Blocked answer can be the person's decision; the same words after another label are not.
    expect(apiSetupFailure('Error: the save failed after the question — user declined.')).not.toBeNull();
  });

  it('bounds the reason it records', () => {
    const reason = apiSetupFailure(`Error: ${'x'.repeat(500)}`);
    expect(reason).not.toBeNull();
    expect(reason!.length).toBeLessThanOrEqual(201);
  });

  it('is what the tool declares', () => {
    expect(apiSetupTool.failureOf).toBe(apiSetupFailure);
  });
});

describe('api_setup answers the reader reads as done', () => {
  // Every string the handler returns, rendered with each `${…}` as "x", is read by the reader. The
  // ones it reads as done are held to this list, so a new refusal that reads as done fails here
  // instead of showing a ✓. What this cannot see: a `${…}` that opens an answer is rendered as
  // "x", so such an answer is read at run time by what the value opens with (`x Check …` below is
  // `Token exchange failed …`); a string handed back through a variable or a ternary arm that is
  // not itself a `return` is not read.
  const source = readFileSync(fileURLToPath(new URL('./api-setup.ts', import.meta.url)), 'utf8');
  const from = source.indexOf('const apiSetupEntry: ToolEntry<ApiSetupInput> = {');
  const to = source.indexOf('\n};', from);

  function template(i: number): [string, number] {
    let out = '';
    for (i += 1; ;) {
      const c = source[i]!;
      if (c === '\\') { out += source.slice(i, i + 2); i += 2; continue; }
      if (c === '`') return [out, i + 1];
      if (c === '$' && source[i + 1] === '{') { i = expression(i + 2); out += 'x'; continue; }
      out += c; i += 1;
    }
  }
  function expression(i: number): number {
    for (let depth = 1; ;) {
      const c = source[i]!;
      if (c === '`') { i = template(i)[1]; continue; }
      if (c === "'" || c === '"') {
        for (i += 1; source[i] !== c; i += source[i] === '\\' ? 2 : 1);
        i += 1; continue;
      }
      if (c === '{') depth += 1;
      else if (c === '}' && --depth === 0) return i + 1;
      i += 1;
    }
  }
  function quoted(i: number): string {
    const q = source[i]!;
    let out = '';
    for (i += 1; source[i] !== q; i += 1) {
      if (source[i] === '\\') i += 1;
      out += source[i];
    }
    return out;
  }

  const answers: string[] = [];
  for (const m of source.slice(from, to).matchAll(/\breturn\s+(?=[`'"])/g)) {
    const at = from + m.index + m[0].length;
    answers.push(source[at] === '`' ? template(at)[0] : quoted(at));
  }
  const readAsDone = answers.filter((a) => apiSetupFailure(a) === null).map((a) => a.slice(0, 32)).sort();

  it('finds the handler and its answers', () => {
    expect(from).toBeGreaterThan(0);
    expect(answers.length).toBeGreaterThan(100);
  });

  it('control: the renderer reads a refusal as not done', () => {
    expect(answers.some((a) => a.startsWith('Token exchange failed with HTTP x') && apiSetupFailure(a) !== null)).toBe(true);
  });

  it('reads as done only the answers known to be done, a decline or a stop', () => {
    expect(readAsDone).toEqual([
      '"x" is already connected. Show t',
      '- x: x (x)xx',
      'Blocked: API profile "x" not del',
      'Blocked: API profile "x" not del',
      'Blocked: API profile entry "x" n',
      'Blocked: API profile entry "x" n',
      'Blocked: profile "x" not saved —',
      'Blocked: the connection of API p',
      'Blocked: the connection of API p',
      'Blocked: x was not released to A',
      'Blocked: x was not released — th',
      'Deleted API profile "x".',
      'Deleted API profile "x". No vaul',
      'Deleted API profile "x".x',
      'Refined profile "x": x. Saved.',
      'Released x to API profile "x" wh',
      'Show the user this link and let ',
      'The provider ended this authoriz',
      'Token exchange OK. access_token ',
      'Token exchange OK. access_token ',
      'none',
      'restorable',
      'x Check auth.oauth.scope against',
      'x Do not call fetch_token again ',
      'x Leave output_secret_name out, ',
      'x x',
      // A template's escapes stay as written: this is `x\\n\\nx` in the source.
      'x\\n\\nx',
    ]);
  });
});
