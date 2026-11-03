export interface ToastAction {
	label: string;
	handler: () => void;
}

export interface Toast {
	id: number;
	message: string;
	type: 'success' | 'error' | 'info';
	action?: ToastAction;
}

let toasts = $state<Toast[]>([]);
let nextId = 0;

/** `durationMs` null keeps the toast until the person closes it: for a message they have to act
 *  on. (Not `Infinity`: `setTimeout` takes that as 1 ms.) */
export function addToast(
	message: string,
	type: Toast['type'] = 'info',
	durationMs: number | null = 3000,
	action?: ToastAction,
): void {
	const id = nextId++;
	toasts.push(action ? { id, message, type, action } : { id, message, type });
	if (durationMs === null) return;
	setTimeout(() => {
		toasts = toasts.filter((t) => t.id !== id);
	}, durationMs);
}

export function dismissToast(id: number): void {
	toasts = toasts.filter((t) => t.id !== id);
}

export function getToasts(): Toast[] {
	return toasts;
}
