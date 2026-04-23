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

export function addToast(
	message: string,
	type: Toast['type'] = 'info',
	durationMs = 3000,
	action?: ToastAction,
): void {
	const id = nextId++;
	toasts.push(action ? { id, message, type, action } : { id, message, type });
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
