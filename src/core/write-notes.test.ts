import { describe, it, expect } from 'vitest';
import { collectWriteNotes } from '../tools/builtin/pipeline.js';
import { UNGRANTED_WRITE_PREFIX, hostShowsStoredValue, ungrantedWriteNote, writeForShortNote } from './write-notes.js';

const METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', ...Array.from({ length: 22 }, (_, i) => `X${String.fromCharCode(65 + i)}`)];
const UNTRUSTED = 'The run read external content before this call, and its grant does not cover writes after that.';
const HEADERS = 'which a run under a reviewed grant may not set.';

/** The line as the run report keeps it: what `collectWriteNotes` takes from a refusal. */
function kept(line: string): string {
  const notes = new Set<string>();
  collectWriteNotes(notes)({ toolName: 'http_request', outputJson: `Permission denied (non-interactive): http_request\n${line}` });
  return [...notes][0] ?? '';
}

describe('the line a run report keeps of a refused write', () => {
  // A long path cut the reason off the end of the line (26 methods and a 150-character path came
  // to 364 characters). The URL now gives way, marked, and the reason stays whole.
  it('keeps the reason whole when the path is long; the path is cut at its end and marked', () => {
    const method = writeForShortNote('POST', 'POST', METHODS);
    const url = `https://api.example.com/${'segment/'.repeat(19)}`;
    const line = ungrantedWriteNote(method, url, true, ['X-One', 'X-Two']);
    expect(line.length).toBeLessThanOrEqual(300);
    expect(line).toMatch(/^Not granted for an unattended run: POST \(also naming PUT, PATCH, DELETE and 22 more\) https:\/\/api\.example\.com\/(segment\/)*…\. /);
    expect(line).toContain('…');
    expect(line).toContain(UNTRUSTED);
    expect(line.endsWith(HEADERS)).toBe(true);
    expect(kept(line)).toBe(line);
  });

  // The line is masked after it is built, so a cut inside a segment could keep part of a stored
  // secret that the mask then no longer knows. A segment is kept whole or not at all.
  it('never keeps part of a path segment', () => {
    const token = `ghp_${'A1b2C3d4'.repeat(5)}`;
    const line = ungrantedWriteNote('POST', `https://api.example.com/${'hooks/'.repeat(20)}${token}/run`, true, ['X-One', 'X-Two']);
    expect(line.length).toBeLessThanOrEqual(300);
    expect(line).not.toContain('ghp_');
    expect(line).toMatch(/https:\/\/api\.example\.com\/(hooks\/)+…\. /);
  });

  // The URL may carry a stored value resolved, and the mask knows it only whole: it is masked
  // before the URL is cut, so a value with a `/` of its own is never cut at it. Every length of
  // the path before it is tried, so the line's end falls inside the value at least once.
  it('masks a stored value before it cuts the URL, so no part of it is kept', () => {
    const value = ['Q7x9', 'pL2m', 'Zr4t'].join('/') + 'Vw8k';
    const mask = (t: string): string => t.replaceAll(value, '***');
    for (let pad = 0; pad < 80; pad++) {
      const line = ungrantedWriteNote('POST', `https://api.example.com/${'p'.repeat(pad)}/${value}/run`, true, ['X-One', 'X-Two'], false, mask);
      expect(line.length).toBeLessThanOrEqual(300);
      expect(line).not.toContain('Q7x9');
    }
  });

  // The URL parser rewrites what it reads: a space or a quote in the path comes out
  // percent-encoded, a backslash as `/`, and the host in lower case. A stored value written that
  // way was missed by a mask that only saw the parsed URL. The part that holds it is left out.
  describe('a stored value the URL parser rewrites', () => {
    const HOST = '(host not shown: its address holds a stored secret)';
    const PATH = '/(path not shown: it holds a stored secret)';
    /** The caller's mask as the secret store writes it: stars and the value's last four characters. */
    const maskOf = (...values: string[]) => (t: string): string =>
      [...values].sort((a, b) => b.length - a.length).reduce((acc, v) => acc.replaceAll(v, `***${v.slice(-4)}`), t);
    const note = (url: string, mask: (t: string) => string, hideHost = false): string =>
      ungrantedWriteNote('POST', url, false, undefined, hideHost, mask);

    it('in the path: the path is left out, the host is named', () => {
      const line = note('https://api.example.com/v1/Q7 x"9\\Lm/run', maskOf('Q7 x"9\\Lm'));
      expect(line).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://api.example.com${PATH}.`);
    });

    it('in a host written in capitals: the host is left out, the path is named', () => {
      const line = note('https://ACME-Tenant7.example.com/v1/items', maskOf('ACME-Tenant7'));
      expect(line).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://${HOST}/v1/items.`);
    });

    it('in the path when the caller already leaves the host out: both are left out', () => {
      const line = note('https://sk-live-canary.h.example/v1/Q7 x9Lm/run', maskOf('Q7 x9Lm'), true);
      expect(line).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://${HOST}${PATH}.`);
    });

    // A value with a `/` of its own, written from the host into the path, is in neither part alone;
    // what follows it must not be read as another host.
    it('running from the host into the path: both are left out, and no other host is named', () => {
      const line = note('https://notes.example@AbCd/EfGhIjKlMnOp@evil.example/x', maskOf('AbCd/EfGhIjKlMnOp'));
      expect(line).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://${HOST}${PATH}.`);
    });

    // Of two stored values that overlap, the longer one taken first left the rest of the other.
    it('overlapping another stored value: nothing of either is shown', () => {
      const line = note('https://api.example.com/v1/abcdefghij Q7 x9-LONGSECRETVALUE123/run', maskOf('abcdefghij Q7 x9-LONGSEC', 'LONGSECRETVALUE123'));
      expect(line).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://api.example.com${PATH}.`);
    });

    it('spelled only once parsed, a backslash read as a slash: masked in the parsed path', () => {
      const line = note('https://api.example.com/v1/Q7x9\\Lm4k/run', maskOf('Q7x9/Lm4k'));
      expect(line).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://api.example.com/v1/***Lm4k/run.`);
    });

    // A value with a `?` or `#` of its own is cut where the parser cuts the path, and the mask run
    // over the path alone no longer finds it: the part before its `?` (here `/hookpart`) would be
    // shown. The path is left out, and the query stays out as always.
    it('in a value that runs from the path into the query or the fragment: the path is left out', () => {
      expect(note('https://hooks.example/hookpart?sig=ABCDEFGHIJKLMNOP&email=alice@corp.example', maskOf('hookpart?sig=ABCDEFGHIJKLMNOP')))
        .toBe(`${UNGRANTED_WRITE_PREFIX} POST https://hooks.example${PATH}.`);
      expect(note('https://api.example.com/v1/Q7x9#Lm4kZr', maskOf('Q7x9#Lm4kZr'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://api.example.com${PATH}.`);
    });

    // The same at the host's edges: a value that starts in the userinfo or before the host's own
    // `/`, or runs from the host into the query, is in the host only in part.
    it('in a value that runs into the host from before it, or out of it into the query: the host is left out', () => {
      expect(note('https://tok@ACME-Tenant7.example.com/x', maskOf('tok@ACME-Tenant7'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://${HOST}/x.`);
      expect(note('https:/ACME-Tenant7.example.com/p', maskOf('/ACME-Tenant7'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://${HOST}/p.`);
      expect(note('https://ACME-Tenant7.example.com?x=1', maskOf('ACME-Tenant7.example.com?x'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://${HOST}/.`);
    });

    // The parser keeps percent escapes as written, and the mask does not decode them.
    it('in a value written percent-encoded: the part that holds it is left out', () => {
      expect(note('https://api.example.com/v1/%51%37x9Lm4kZr/run', maskOf('Q7x9Lm4kZr'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://api.example.com${PATH}.`);
      expect(note('https://%41CME-Tenant7.example.com/v1', maskOf('ACME-Tenant7'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://${HOST}/v1.`);
      // A stray byte that is no UTF-8 does not keep the rest of its run encoded.
      expect(note('https://api.example.com/v1/Lm4kZr%51%37%FF/run', maskOf('Lm4kZrQ7'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://api.example.com${PATH}.`);
    });

    it('CONTROL: a percent escape beside a value written plainly leaves the path named, the value masked', () => {
      expect(note('https://api.example.com/My%20Doc/botQ7x9Lm4kZr/x', maskOf('Q7x9Lm4kZr'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://api.example.com/My%20Doc/bot***4kZr/x.`);
    });

    // The parser drops tabs and line breaks, so a value that holds one is no longer whole in the URL
    // it reads.
    it('in a value that holds a tab or a line break: the part that holds it is left out', () => {
      expect(note('https://api.example.com/v1/Q7x9\tLm4kZr/run', maskOf('Q7x9\tLm4kZr'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://api.example.com${PATH}.`);
      expect(note('https://ACME\nTenant7.example.com/v1', maskOf('ACME\nTenant7'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://${HOST}/v1.`);
    });

    it('CONTROL: a value in the query, or one that runs from the host into the path shown whole, leaves the URL named', () => {
      expect(note('https://api.example.com/v1/items?key=Q7x9Lm4kZr', maskOf('Q7x9Lm4kZr'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://api.example.com/v1/items.`);
      expect(note('https://hooks.example.com/Q7x9Lm4kZr/run', maskOf('hooks.example.com/Q7x9Lm4kZr'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://***4kZr/run.`);
    });

    // A value that runs over a part's edge in only one of the forms the parser undoes: split by a
    // tab it drops, holding a tab, or written percent-encoded.
    it('in a value that runs over a part\'s edge only once a tab is dropped, with its tab, or once decoded: the part is left out', () => {
      expect(note('https://tok@AC\tME-Tenant7.example.com/x', maskOf('tok@ACME-Tenant7'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://${HOST}/x.`);
      // With a percent sign of its own the value is not found decoded either: only once the tab is dropped.
      expect(note('https://hooks.example/hook%2Fpa\trt?sig=ABCDEFGHIJKLMNOP', maskOf('hook%2Fpart?sig=ABCDEFGHIJKLMNOP'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://hooks.example${PATH}.`);
      expect(note('https://tok@ACME\tTenant7.example.com/x', maskOf('tok@ACME\tTenant7'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://${HOST}/x.`);
      expect(note('https://hooks.example/hook%70art?sig=ABCDEFGHIJKLMNOP', maskOf('hookpart?sig=ABCDEFGHIJKLMNOP'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://hooks.example${PATH}.`);
    });

    // The same from the host into the path, with the tab kept: shown whole, the parser has dropped
    // the tab, and the mask no longer finds the value.
    it('in a value with a tab that runs from the host into the path: both are left out', () => {
      expect(note('https://hooks.example.com/Q7x9\tLm4k/run', maskOf('example.com/Q7x9\tLm4k'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://${HOST}${PATH}.`);
    });

    // A value that runs from the host into the path, where the host is left out for another reason:
    // the path would show the rest of it.
    it('in a value that runs from a host left out into the path: both are left out', () => {
      expect(note('https://hooks.example.com/Q7x9Lm4kZr/run', maskOf('hooks.example.com/Q7x9Lm4kZr'), true)).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://${HOST}${PATH}.`);
    });

    // The parser writes an internationalised host in its `xn--` form, the form the note shows: a
    // value stored that way is masked there like any other.
    it('CONTROL: a host written in Unicode, its value stored in the `xn--` form: masked in place', () => {
      expect(note('https://bücher.example.com/v1', maskOf('xn--bcher-kva'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://***-kva.example.com/v1.`);
    });

    // The control character after the URL is dropped before the path is compared with the parsed one.
    it('CONTROL: a value in a path the parser leaves as written, a control character after the URL: masked in place', () => {
      expect(note('https://api.example.com/hooks/Q7x9Lm4kZr\x01', maskOf('Q7x9Lm4kZr'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://api.example.com/hooks/***4kZr.`);
    });

    it('CONTROL: a value in a path the parser leaves as written is masked in place, the path named', () => {
      const line = note('https://api.example.com/hooks/Q7x9Lm4kZr/run', maskOf('Q7x9Lm4kZr'));
      expect(line).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://api.example.com/hooks/***4kZr/run.`);
    });

    // The parser takes the host after the userinfo, which a note never shows: a value there leaves
    // the host named.
    it('CONTROL: a value in the userinfo leaves the host named', () => {
      const line = note('https://Q7x9Lm4kZr@api.example.com/v1/items', maskOf('Q7x9Lm4kZr'));
      expect(line).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://api.example.com/v1/items.`);
    });

    // The parser reads `https:host`, `https:/host` and `https:\\\\host` as `https://host`.
    it('in a host written in capitals after a scheme without `//`: the host is left out', () => {
      for (const url of ['https:ACME-Tenant7.example.com/v1/items', 'https:/ACME-Tenant7.example.com/v1/items', 'https:\\\\ACME-Tenant7.example.com/v1/items']) {
        expect(note(url, maskOf('ACME-Tenant7'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://${HOST}/v1/items.`);
      }
    });

    it('in a host written in capitals after a control character before the URL: the host is left out', () => {
      expect(note('\x01https://ACME-Tenant7.example.com/v1/items', maskOf('ACME-Tenant7'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://${HOST}/v1/items.`);
    });

    it('in a host written in capitals under a scheme written in capitals: the host is left out', () => {
      expect(note('HTTPS://ACME-Tenant7.example.com/v1/items', maskOf('ACME-Tenant7'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://${HOST}/v1/items.`);
    });

    it('in the path, split by a tab the parser drops: the path is left out', () => {
      expect(note('https://api.example.com/v1/Q7 x\t9Lm', maskOf('Q7 x9Lm'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://api.example.com${PATH}.`);
    });

    it('in a path that starts with a backslash: the path is left out, the host named', () => {
      expect(note('https://api.example.com\\Q7 x9Lm', maskOf('Q7 x9Lm'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://api.example.com${PATH}.`);
    });

    it('CONTROL: a value in the fragment leaves host and path named', () => {
      expect(note('https://api.example.com/v1/x#Q7 x9Lm', maskOf('Q7 x9Lm'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://api.example.com/v1/x.`);
      expect(note('https://api.example.com#Q7 x9Lm', maskOf('Q7 x9Lm'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://api.example.com/.`);
    });

    it('CONTROL: a value in the first of two userinfo parts leaves the host named', () => {
      expect(note('https://x@Q7x9Lm4kZr@api.example.com/v1/items', maskOf('Q7x9Lm4kZr'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://api.example.com/v1/items.`);
    });

    // A scheme this split does not read: a stored value anywhere in the URL leaves both parts out.
    it('in a URL of another scheme: both parts are left out; without a value it is named', () => {
      expect(note('mailto:Q7 x9Lm@example.com', maskOf('Q7 x9Lm'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST mailto://${HOST}${PATH}.`);
      expect(note('mailto:anna@example.com', maskOf('Q7 x9Lm'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST mailto://anna@example.com.`);
    });

    // Read only as written, a value split by a tab the parser drops, or written percent-encoded,
    // was missed there; read only without the tabs, a value that holds one would be.
    it('in a URL of another scheme, the value split by a tab, holding one, or percent-encoded: both parts are left out', () => {
      expect(note('wss://api.example.com/Q7 x\t9Lm', maskOf('Q7 x9Lm'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST wss://${HOST}${PATH}.`);
      expect(note('wss://api.example.com/Q7 x\t9Lm', maskOf('Q7 x\t9Lm'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST wss://${HOST}${PATH}.`);
      expect(note('wss://api.example.com/%51%37x9Lm', maskOf('Q7x9Lm'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST wss://${HOST}${PATH}.`);
      // A value holding a percent sign of its own, split by a tab: found only without the tab, not decoded.
      expect(note('wss://api.example.com/Q7%20x\t9Lm', maskOf('Q7%20x9Lm'))).toBe(`${UNGRANTED_WRITE_PREFIX} POST wss://${HOST}${PATH}.`);
    });

    // `http_request` asks this of an http or https host only; another scheme's host its own checks read.
    it('hostShowsStoredValue: a host that holds a value in part; another scheme is left to the caller', () => {
      expect(hostShowsStoredValue('https://tok@ACME-Tenant7.example.com/x', maskOf('tok@ACME-Tenant7'))).toBe(true);
      expect(hostShowsStoredValue('https://api.example.com/x', maskOf('tok@ACME-Tenant7'))).toBe(false);
      expect(hostShowsStoredValue('wss://api.example.com/x?k=Q7x9Lm', maskOf('Q7x9Lm'))).toBe(false);
    });

    // The parser drops whitespace around the URL first; read as written without that, the host
    // and path are not found and the value in a capitalised host was missed.
    it('in a host written in capitals, with whitespace before the URL: the host is left out', () => {
      const line = note(' \thttps://ACME-Tenant7.example.com/v1/items', maskOf('ACME-Tenant7'));
      expect(line).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://${HOST}/v1/items.`);
    });
  });

  it('masks a credential shape no stored value names, in a path short enough to be kept whole', () => {
    const token = `ghp_${'A1b2C3d4'.repeat(5)}`;
    const line = ungrantedWriteNote('POST', `https://api.example.com/hooks/${token}/run`, false);
    expect(line.length).toBeLessThan(300);
    expect(line).not.toContain(token);
    expect(line).toContain('https://api.example.com/hooks/');
  });

  it('leaves out a host that holds a stored secret when asked to', () => {
    expect(ungrantedWriteNote('POST', 'https://sk-live-canary.h.example/a', false, undefined, true)).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://(host not shown: its address holds a stored secret)/a.`);
  });

  it('CONTROL: a short path is named whole, unmarked', () => {
    const line = ungrantedWriteNote('POST', 'https://api.example.com/v1/items?token=x', true);
    expect(line).toBe(`${UNGRANTED_WRITE_PREFIX} POST https://api.example.com/v1/items. ${UNTRUSTED}`);
    expect(kept(line)).toBe(line);
  });

  it('keeps the start of the URL however long the rest of the line is', () => {
    // Header names of 64 characters leave the URL no room: it keeps scheme, host and its `/`.
    const line = ungrantedWriteNote('POST', `https://api.example.com/${'x'.repeat(200)}`, true, Array.from({ length: 4 }, (_, i) => `X-${String(i)}${'a'.repeat(61)}`));
    expect(line).toMatch(/^Not granted for an unattended run: POST https:\/\/api\.example\.com\/…\./);
  });
});
