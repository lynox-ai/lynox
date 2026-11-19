// `$app/forms` for a component mounted in the browser-compile project, where no SvelteKit runtime
// exists. `enhance` leaves the form as it is; a test that submits mocks it with `vi.mock`.
export function enhance(): { destroy: () => void } {
	return { destroy: () => {} };
}
