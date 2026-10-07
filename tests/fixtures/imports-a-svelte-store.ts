// A plain helper that imports a Svelte store at runtime, as a utility module might.
import { addToast } from '../../packages/web-ui/src/lib/stores/toast.svelte.js';

export const notify = (message: string): number => addToast(message, 'info');
