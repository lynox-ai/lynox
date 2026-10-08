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
 * (actions on hover, as before), 390 px with and without touch, and a 1024 px touch tablet —
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
    expect(classes, 'hidden only at sm and up, on a device that hovers').toContain('sm:[@media(hover:hover)]:opacity-0');
    expect(classes).toContain('group-hover:opacity-100');
    expect(classes, 'keyboard focus still reveals them').toContain('focus-visible:opacity-100');
  });

  it('gives every action button the shared class, and no button its own hover-only one', () => {
    expect(source.match(/\{revealOnHover\}/g) ?? [], 'run, schedule, edit, rename, delete').toHaveLength(5);
    expect(source, 'no button left on the old hover-only classes').not.toMatch(/class="[^"]*\bopacity-0 group-hover:opacity-100/);
  });

  it('stacks the actions under the name below sm instead of squeezing the name', () => {
    expect(source).toContain('class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3"');
    expect(source, 'the action row wraps and only refuses to shrink beside the name').toContain('class="flex flex-wrap items-center gap-2 sm:shrink-0 sm:mt-0.5"');
  });
});
