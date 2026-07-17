import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionBindings } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";

const io = vi.hoisted(() => ({
	attach: vi.fn(),
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: vi.fn(),
}));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: io.attach,
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

afterEach(() => {
	vi.restoreAllMocks();
	io.attach.mockReset();
	io.lineHandler = undefined;
});

describe("RPC startup shutdown", () => {
	it("disposes before attaching input when session_start requests shutdown", async () => {
		const unsubscribe = vi.fn();
		const unsubscribeBackpressure = vi.fn();
		const bindExtensions = vi.fn(async (bindings: ExtensionBindings) => {
			bindings.shutdownHandler?.();
		});
		const session = {
			bindExtensions,
			subscribe: vi.fn(() => unsubscribe),
			agent: { subscribe: vi.fn(() => unsubscribeBackpressure) },
			waitForIdle: vi.fn(async () => {}),
			navigateTree: vi.fn(async () => ({ cancelled: false })),
			reload: vi.fn(async () => {}),
		};
		const dispose = vi.fn(async () => {});
		const runtimeHost = {
			session,
			setRebindSession: vi.fn(),
			newSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			dispose,
		} as unknown as AgentSessionRuntime;
		const exit = new Error("rpc startup shutdown exit");
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw exit;
		}) as typeof process.exit);

		await expect(runRpcMode(runtimeHost)).rejects.toBe(exit);

		expect(bindExtensions).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		expect(unsubscribeBackpressure).toHaveBeenCalledTimes(1);
		expect(io.attach).not.toHaveBeenCalled();
	});

	it("coalesces buffered shutdown gates until graceful disposal completes", async () => {
		let shutdownHandler: (() => void) | undefined;
		const unsubscribe = vi.fn();
		const unsubscribeBackpressure = vi.fn();
		const detachInput = vi.fn();
		io.attach.mockImplementation((_stream, onLine: (line: string) => void) => {
			io.lineHandler = onLine;
			return detachInput;
		});
		const bindExtensions = vi.fn(async (bindings: ExtensionBindings) => {
			shutdownHandler = bindings.shutdownHandler;
		});
		const session = {
			bindExtensions,
			subscribe: vi.fn(() => unsubscribe),
			agent: { subscribe: vi.fn(() => unsubscribeBackpressure) },
			waitForIdle: vi.fn(async () => {}),
			navigateTree: vi.fn(async () => ({ cancelled: false })),
			reload: vi.fn(async () => {}),
		};
		let finishDispose: (() => void) | undefined;
		const dispose = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishDispose = resolve;
				}),
		);
		const runtimeHost = {
			session,
			setRebindSession: vi.fn(),
			newSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			dispose,
		} as unknown as AgentSessionRuntime;
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as unknown as typeof process.exit);

		void runRpcMode(runtimeHost);
		await vi.waitFor(() => expect(io.lineHandler).toBeDefined());
		expect(shutdownHandler).toBeDefined();
		shutdownHandler!();
		io.lineHandler!("{}");
		io.lineHandler!("{}");

		await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
		expect(detachInput).toHaveBeenCalledTimes(1);
		expect(exit).not.toHaveBeenCalled();

		finishDispose!();
		await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		expect(unsubscribeBackpressure).toHaveBeenCalledTimes(1);
	});
});
