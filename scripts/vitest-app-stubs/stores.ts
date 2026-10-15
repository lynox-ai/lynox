// `$app/stores` for a component mounted in the browser-compile project, where no SvelteKit
// runtime exists. A test that needs another page mocks it with `vi.mock`.
import { readable } from 'svelte/store';

export const page = readable({ url: new URL('http://localhost/') });
