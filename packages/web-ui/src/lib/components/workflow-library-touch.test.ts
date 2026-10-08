import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The saved-workflow cards on a phone. At 390 px the action column used to take the whole
 * width (`shrink-0`, five buttons in one row) and squeeze name and description to nothing,
 * and the buttons were `opacity-0` until hover — which a touch screen does not have, so Run
 * was unreachable there.
 *
 * Source-level because a Svelte component cannot be imported in vitest here (the root config
 * has no svelte plugin). What this pins is the SHAPE of the fix, which is a stand-in for what
 * matters: the rendered page. That was checked at the pixel when this was written — 1440 px
 * (actions on hover, as before), 320/390/640/768 px with and without touch, and a 1024 px touch tablet —
 * and a layout change should be checked there again, not only here.
 */
const source = readFileSync(
  fileURLToPath(new URL('./WorkflowLibraryView.svelte', import.meta.url)),
  'utf8',
);
const reveal = /const revealOnHover = '([^']+)';/.exec(source)?.[1];

describe('the workflow cards on a narrow or touch screen', () => {
  it('hides the actions only where there is room and a pointer that hovers', () => {
    expect(reveal, 'the shared class string exists').toBeDefined();
    const classes = reveal!.split(/\s+/);
    expect(classes, 'visible by default').toContain('opacity-100');
    expect(classes, 'never hidden unconditionally').not.toContain('opacity-0');
    expect(classes, 'hidden only at md and up, on a device that hovers').toContain('md:[@media(hover:hover)]:opacity-0');
    expect(classes).toContain('group-hover:opacity-100');
    expect(classes, 'keyboard focus still reveals them').toContain('focus-visible:opacity-100');
  });

  it('gives every action button the shared class, and no button its own hover-only one', () => {
    expect(source.match(/\{revealOnHover\}/g) ?? [], 'run, schedule, edit, rename, delete').toHaveLength(5);
    expect(source, 'no button left on the old hover-only classes').not.toMatch(/class="[^"]*\bopacity-0 group-hover:opacity-100/);
  });

  it('stacks the actions under the name below md, and caps them at half the row between md and lg', () => {
    const classesOf = (marker: string): string[] => {
      const m = new RegExp(`class="([^"]*${marker.replace(/[[\]]/g, '\\$&')}[^"]*)"`).exec(source);
      return m ? m[1]!.split(/\s+/) : [];
    };
    const row = classesOf('md:flex-row');
    expect(row, 'the card row stacks by default').toEqual(expect.arrayContaining(['flex', 'flex-col', 'md:flex-row']));
    const actions = classesOf('md:max-w-[50%]');
    expect(actions, 'the action row wraps and never takes more than half the row').toEqual(expect.arrayContaining(['flex-wrap', 'md:max-w-[50%]']));
    expect(actions, 'beside the name it keeps its width').toContain('md:shrink-0');
    expect(actions, 'and only there').not.toContain('shrink-0');
    expect(actions, 'from lg there is room for one row again, as before').toContain('lg:max-w-none');
  });
});
