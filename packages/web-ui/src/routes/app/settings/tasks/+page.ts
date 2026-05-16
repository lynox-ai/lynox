import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * PRD-IA-V2 P3-PR-G — Tasks relocate from Settings to Automation Hub.
 * The `tasks` tab in `AutomationHub.svelte` mounts the same `TasksView`
 * component that lived here; scheduled tasks are an automation primitive
 * (alongside Workflows + API Profiles), not a settings concern.
 * SSR-side `redirect()` so cold bookmark loads land on the right page
 * without a client-only flash.
 *
 * Security (PRD S2): hard-coded target path, no user-input passthrough.
 */
export const load: PageLoad = () => {
  throw redirect(301, '/app/hub?section=tasks');
};
