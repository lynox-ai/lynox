export interface Toast {
	id: number;
	message: string;
	type: 'success' | 'error' | 'info';
}

let toasts = $state<Toast[]>([]);
let nextId = 0;

export function addToast(message: string, type: Toast['type'] = 'info', durationMs = 3000): void {
	const id = nextId++;
	toasts.push({ id, message, type });
	setTimeout(() => {
		toasts = toasts.filter((t) => t.id !== id);
	}, durationMs);
}

export function getToasts(): Toast[] {
	return toasts;
}
