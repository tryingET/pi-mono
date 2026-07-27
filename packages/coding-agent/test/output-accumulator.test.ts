import { once } from "node:events";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";

function archiveTarget(stream: Writable) {
	return { stream };
}

class CollectingWritable extends Writable {
	readonly chunks: Buffer[] = [];

	override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		this.chunks.push(Buffer.from(chunk));
		callback();
	}
}

class CloseFailingWritable extends Writable {
	private closeCallback: ((error?: Error | null) => void) | undefined;

	override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		callback();
	}

	override _destroy(_error: Error | null, callback: (error?: Error | null) => void): void {
		this.closeCallback = callback;
	}

	failClose(): void {
		const error = new Error("Close failed") as NodeJS.ErrnoException;
		error.code = "ENOSPC";
		this.closeCallback?.(error);
	}
}

class LateDestroyFailingWritable extends Writable {
	override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		callback();
	}

	override _destroy(_error: Error | null, callback: (error?: Error | null) => void): void {
		const error = new Error("late destroy failure") as NodeJS.ErrnoException;
		error.code = "EIO";
		setImmediate(() => callback(error));
	}
}

class DelayedCloseWritable extends Writable {
	override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		callback();
	}

	override _final(_callback: (error?: Error | null) => void): void {
		// Force the accumulator's close timeout to destroy this stream.
	}

	override _destroy(_error: Error | null, callback: (error?: Error | null) => void): void {
		setTimeout(callback, 25);
	}
}

class StalledWritable extends Writable {
	override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		callback();
	}

	override _final(_callback: (error?: Error | null) => void): void {
		// Deliberately never settles: the accumulator must bound close liveness.
	}
}

class FailingWritable extends Writable {
	hadErrorListenerBeforeWrite = false;
	private readonly code: string;
	private readonly failureMessage: string;

	constructor(code = "EDQUOT", failureMessage = "Archive storage unavailable") {
		super();
		this.code = code;
		this.failureMessage = failureMessage;
	}

	override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		this.hadErrorListenerBeforeWrite = this.listenerCount("error") > 0;
		const error = new Error(this.failureMessage) as NodeJS.ErrnoException;
		error.code = this.code;
		setImmediate(() => callback(error));
	}
}

class ErrorThenManualCloseWritable extends Writable {
	constructor() {
		super({ autoDestroy: false, emitClose: false });
	}

	override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		const error = new Error("write failed") as NodeJS.ErrnoException;
		error.code = "EDQUOT";
		this.emit("error", error);
		callback();
	}

	closeManually(): void {
		this.emit("close");
	}
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";
}

const ownedArchiveDirectories: string[] = [];

async function ownedArchivePath(label: string, fileName = "archive.log"): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), `pi-output-${label}-`));
	ownedArchiveDirectories.push(directory);
	return join(directory, fileName);
}

afterAll(async () => {
	await Promise.all(ownedArchiveDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("OutputAccumulator archive containment", () => {
	it("caps archive bytes independently while preserving tail metadata", async () => {
		const path = await ownedArchivePath("bounded");
		const archive = new CollectingWritable();
		const output = new OutputAccumulator({
			maxBytes: 8,
			maxLines: 100,
			maxArchiveBytes: 5,
			archiveStreamFactory: () => archiveTarget(archive),
			tempFilePathFactory: () => path,
		});

		output.append(Buffer.from("0123456789abcdef"));
		await output.closeTempFile();
		const snapshot = output.snapshot();

		expect(Buffer.concat(archive.chunks).toString()).toBe("01234");
		expect(snapshot.content).toBe("89abcdef");
		expect(snapshot.truncation).toMatchObject({ truncated: true, totalBytes: 16, outputBytes: 8 });
		expect(snapshot.archive).toMatchObject({
			path,
			archivedBytes: 5,
			maxBytes: 5,
			status: "succeeded",
			truncated: true,
		});
		expect(snapshot.fullOutputPath).toBeUndefined();
	});

	it("does not report a full archive before a close-time failure", async () => {
		const path = await ownedArchivePath("close-failure");
		const archive = new CloseFailingWritable();
		const output = new OutputAccumulator({
			maxBytes: 4,
			archiveStreamFactory: () => archiveTarget(archive),
			tempFilePathFactory: () => path,
		});

		output.append(Buffer.from("useful-tail"));
		const closing = output.closeTempFile();
		await once(archive, "finish");
		expect(output.snapshot().archive).toMatchObject({ status: "pending" });
		expect(output.snapshot().archive?.path).toBeUndefined();
		expect(output.snapshot().fullOutputPath).toBeUndefined();

		archive.failClose();
		await closing;
		const snapshot = output.snapshot();
		expect(snapshot.archive).toMatchObject({
			status: "failed",
			error: "ENOSPC: Close failed",
		});
		expect(snapshot.archive?.path).toBeUndefined();
		expect(snapshot.fullOutputPath).toBeUndefined();
	});

	it("waits through finish and contains a late destroy failure", async () => {
		const path = await ownedArchivePath("late-destroy");
		const output = new OutputAccumulator({
			maxBytes: 4,
			archiveStreamFactory: () => archiveTarget(new LateDestroyFailingWritable()),
			tempFilePathFactory: () => path,
		});

		output.append(Buffer.from("useful-tail"));
		await output.closeTempFile();
		const snapshot = output.snapshot();
		expect(snapshot.archive).toMatchObject({ status: "failed", error: "EIO: late destroy failure" });
		expect(snapshot.archive?.path).toBeUndefined();
		expect(snapshot.fullOutputPath).toBeUndefined();
	});

	it("waits for resource closure after an early write error", async () => {
		const path = await ownedArchivePath("manual-close");
		const archive = new ErrorThenManualCloseWritable();
		const output = new OutputAccumulator({
			maxBytes: 4,
			archiveCloseTimeoutMs: 1_000,
			archiveStreamFactory: () => archiveTarget(archive),
			tempFilePathFactory: () => path,
		});

		output.append(Buffer.from("useful-tail"));
		let resolved = false;
		const closing = output.closeTempFile().then(() => {
			resolved = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(resolved).toBe(false);
		archive.closeManually();
		await closing;
		expect(output.snapshot().archive).toMatchObject({ status: "failed", error: "EDQUOT: write failed" });
	});

	it("contains synchronous archive-path allocation failure", async () => {
		const output = new OutputAccumulator({
			maxBytes: 4,
			tempFilePathFactory: () => {
				const error = new Error("No quota for path allocation") as NodeJS.ErrnoException;
				error.code = "EDQUOT";
				throw error;
			},
		});

		output.append(Buffer.from("useful-tail"));
		await output.closeTempFile();

		expect(output.snapshot().archive).toMatchObject({
			status: "failed",
			error: "EDQUOT: No quota for path allocation",
		});
		expect(output.snapshot().archive?.path).toBeUndefined();
		expect(output.snapshot().fullOutputPath).toBeUndefined();
	});

	it("does not publish or leak a planned path when stream creation fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-output-factory-failed-"));
		const path = join(directory, "planned.log");
		await writeFile(path, "partial factory artifact");
		try {
			const output = new OutputAccumulator({
				maxBytes: 4,
				tempFilePathFactory: () => path,
				archiveStreamFactory: () => {
					throw new Error(`factory failed after partial creation at ${path}`);
				},
			});

			output.append(Buffer.from("useful-tail"));
			await output.closeTempFile();
			expect(output.snapshot().archive).toMatchObject({
				status: "failed",
				error: "factory failed after partial creation at <archive>",
			});
			expect(output.snapshot().archive?.error).not.toContain(path);
			expect(output.snapshot().archive?.path).toBeUndefined();
			await expect(access(path)).rejects.toThrow();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("redacts a long archive path before truncating an error", async () => {
		const path = await ownedArchivePath("long-path", `${"p".repeat(180)}.log`);
		expect(path.length).toBeGreaterThan(200);
		const output = new OutputAccumulator({
			maxBytes: 4,
			tempFilePathFactory: () => path,
			archiveStreamFactory: () => {
				throw new Error(`factory failed at ${path}`);
			},
		});

		output.append(Buffer.from("useful-tail"));
		await output.closeTempFile();
		expect(output.snapshot().archive?.error).toBe("factory failed at <archive>");
		expect(output.snapshot().archive?.error).not.toContain(path.slice(0, 80));
	});

	it("always reports a non-empty archive error", async () => {
		const output = new OutputAccumulator({
			maxBytes: 4,
			archiveStreamFactory: () => {
				throw new Error("");
			},
		});

		output.append(Buffer.from("useful-tail"));
		await output.closeTempFile();
		expect(output.snapshot().archive).toMatchObject({ status: "failed", error: "Output archive failed" });
	});

	it("bounds archive close liveness", async () => {
		const path = await ownedArchivePath("stalled");
		const output = new OutputAccumulator({
			maxBytes: 4,
			archiveCloseTimeoutMs: 5,
			archiveStreamFactory: () => archiveTarget(new StalledWritable()),
			tempFilePathFactory: () => path,
		});

		output.append(Buffer.from("useful-tail"));
		await output.closeTempFile();

		expect(output.snapshot().archive).toMatchObject({
			status: "failed",
			error: "Output archive did not close within 5ms",
		});
	});

	it("defers failed-archive cleanup until delayed resource closure", async () => {
		const path = await ownedArchivePath("delayed-close");
		await writeFile(path, "partial");
		const archive = new DelayedCloseWritable();
		const closed = once(archive, "close");
		const output = new OutputAccumulator({
			maxBytes: 4,
			archiveCloseTimeoutMs: 5,
			archiveStreamFactory: () => archiveTarget(archive),
			tempFilePathFactory: () => path,
		});

		output.append(Buffer.from("useful-tail"));
		await output.closeTempFile();
		await expect(access(path)).resolves.toBeUndefined();
		await closed;
		await expect
			.poll(async () => {
				try {
					await access(path);
					return true;
				} catch {
					return false;
				}
			})
			.toBe(false);
	});

	it("removes a failed partial archive", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-output-failed-"));
		const path = join(directory, "partial.log");
		await writeFile(path, "partial");
		try {
			const output = new OutputAccumulator({
				maxBytes: 4,
				archiveStreamFactory: () => archiveTarget(new FailingWritable()),
				tempFilePathFactory: () => path,
			});
			output.append(Buffer.from("useful-tail"));
			await Promise.all([output.closeTempFile(), output.closeTempFile(), output.closeTempFile()]);
			await expect(access(path)).rejects.toThrow();
			expect(output.snapshot().archive?.path).toBeUndefined();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("finishes the accumulator when close begins and rejects later appends", async () => {
		const path = await ownedArchivePath("closed");
		const output = new OutputAccumulator({
			maxBytes: 4,
			archiveStreamFactory: () => archiveTarget(new CollectingWritable()),
			tempFilePathFactory: () => path,
		});

		output.append(Buffer.from("useful-tail"));
		await output.closeTempFile();

		expect(() => output.append(Buffer.from("late"))).toThrow("Cannot append to a finished output accumulator");
		expect(output.snapshot().fullOutputPath).toBe(path);
	});

	it.each([
		["maxLines", { maxLines: Number.NaN }, "maxLines must be a positive safe integer"],
		["maxBytes", { maxBytes: Number.POSITIVE_INFINITY }, "maxBytes must be a positive safe integer"],
		["maxArchiveBytes", { maxArchiveBytes: -1 }, "maxArchiveBytes must be a non-negative safe integer"],
		[
			"archiveCloseTimeoutMs",
			{ archiveCloseTimeoutMs: 1.5 },
			"archiveCloseTimeoutMs must be a positive safe integer",
		],
		[
			"archiveCloseTimeoutMs overflow",
			{ archiveCloseTimeoutMs: 2_147_483_648 },
			"archiveCloseTimeoutMs must not exceed 2147483647",
		],
		[
			"maxBytes multiplication overflow",
			{ maxBytes: Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1 },
			`maxBytes must not exceed ${Math.floor(Number.MAX_SAFE_INTEGER / 2)}`,
		],
	] as const)("rejects an invalid %s bound", (_name, options, message) => {
		expect(() => new OutputAccumulator(options)).toThrow(message);
	});

	it.each(["EDQUOT", "ENOSPC"])(
		"contains asynchronous %s after installing an error listener before writes",
		async (code) => {
			const path = await ownedArchivePath(`quota-${code}`);
			const archive = new FailingWritable(code);
			const output = new OutputAccumulator({
				maxBytes: 4,
				archiveStreamFactory: () => archiveTarget(archive),
				tempFilePathFactory: () => path,
			});

			output.append(Buffer.from("useful-tail"));
			await output.closeTempFile();
			const snapshot = output.snapshot();

			expect(archive.hadErrorListenerBeforeWrite).toBe(true);
			expect(snapshot.content).toBe("tail");
			expect(snapshot.truncation.totalBytes).toBe(11);
			expect(snapshot.archive).toMatchObject({
				status: "failed",
				error: `${code}: Archive storage unavailable`,
			});
			expect(snapshot.archive?.path).toBeUndefined();
			expect(snapshot.fullOutputPath).toBeUndefined();
		},
	);

	it("ignores output delivered after an operation resolves", async () => {
		let lateDelivery: Promise<void> | undefined;
		const tool = createBashToolDefinition("/work", {
			exposeSessionEnvironment: false,
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("initial-tail"));
					lateDelivery = new Promise((resolve) => {
						setImmediate(() => {
							onData(Buffer.from("late-output"));
							resolve();
						});
					});
					return { exitCode: 0 };
				},
			},
		});

		const result = await tool.execute("call", { command: "ignored" }, undefined, undefined, {} as ExtensionContext);
		await lateDelivery;
		const text = resultText(result);

		expect(text).toContain("initial-tail");
		expect(text).not.toContain("late-output");
	});
});
