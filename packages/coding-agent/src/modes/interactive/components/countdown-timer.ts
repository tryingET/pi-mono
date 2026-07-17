/**
 * Reusable countdown timer for dialog components.
 */

import type { TUI } from "@earendil-works/pi-tui";

export class CountdownTimer {
	private intervalId: ReturnType<typeof setInterval> | undefined;
	private timeoutId: ReturnType<typeof setTimeout> | undefined;
	private readonly deadline: number;
	private tui: TUI | undefined;
	private onTick: (seconds: number) => void;
	private onExpire: () => void;

	constructor(timeoutMs: number, tui: TUI | undefined, onTick: (seconds: number) => void, onExpire: () => void) {
		this.tui = tui;
		this.onTick = onTick;
		this.onExpire = onExpire;
		this.deadline = Date.now() + timeoutMs;
		this.onTick(Math.ceil(timeoutMs / 1000));

		this.intervalId = setInterval(() => {
			const remainingMs = Math.max(0, this.deadline - Date.now());
			this.onTick(Math.ceil(remainingMs / 1000));
			this.tui?.requestRender();
		}, 1000);
		this.timeoutId = setTimeout(() => {
			this.onTick(0);
			this.tui?.requestRender();
			this.dispose();
			this.onExpire();
		}, timeoutMs);
	}

	dispose(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
		if (this.timeoutId) {
			clearTimeout(this.timeoutId);
			this.timeoutId = undefined;
		}
	}
}
