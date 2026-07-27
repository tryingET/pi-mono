import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.ts";

export const DEFAULT_MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_ARCHIVE_CLOSE_TIMEOUT_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface OutputArchiveTarget {
	/** Must emit `close` after all storage and resource-release work is terminal. */
	stream: Writable;
}

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	maxArchiveBytes?: number;
	archiveCloseTimeoutMs?: number;
	tempFilePrefix?: string;
	/** Overrides used by focused tests and embedders with custom archive storage. */
	archiveStreamFactory?: (path: string) => OutputArchiveTarget;
	/** Must return a newly allocated path owned exclusively by this accumulator. */
	tempFilePathFactory?: (prefix: string) => string;
}

export type OutputArchiveStatus = "pending" | "succeeded" | "failed";

export interface OutputArchiveSnapshot {
	path?: string;
	archivedBytes: number;
	maxBytes: number;
	status: OutputArchiveStatus;
	truncated: boolean;
	error?: string;
}

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	/** Set only when the archive finished successfully and contains all output. */
	fullOutputPath?: string;
	archive?: OutputArchiveSnapshot;
}

function defaultTempFilePath(prefix: string): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `${prefix}-${id}.log`);
}

function defaultArchiveStreamFactory(path: string): OutputArchiveTarget {
	return { stream: createWriteStream(path) };
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

function redactArchivePath(message: string, path: string | undefined): string {
	return path ? message.split(path).join("<archive>") : message;
}

function formatArchiveError(error: unknown, path?: string): string {
	if (!(error instanceof Error)) {
		const text = redactArchivePath(String(error), path).slice(0, 200);
		return text || "Output archive failed";
	}
	const code = (error as NodeJS.ErrnoException).code;
	const message = redactArchivePath(error.message, path).slice(0, 200) || "Output archive failed";
	return code && !message.includes(code) ? `${code}: ${message}` : message;
}

/** Incrementally tracks streaming output with independently bounded display and archive storage. */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly maxArchiveBytes: number;
	private readonly archiveCloseTimeoutMs: number;
	private readonly tempFilePrefix: string;
	private readonly archiveStreamFactory: (path: string) => OutputArchiveTarget;
	private readonly tempFilePathFactory: (prefix: string) => string;
	private readonly decoder = new TextDecoder();

	private rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private totalLines = 0;
	private currentLineBytes = 0;
	private hasOpenLine = false;
	private finished = false;

	private tempFilePath: string | undefined;
	private archiveCleanupPath: string | undefined;
	private tempFileStream: Writable | undefined;
	private archiveRequested = false;
	private closePromise: Promise<void> | undefined;
	private archiveDone: Promise<void> | undefined;
	private resolveArchiveDone: (() => void) | undefined;
	private archiveResourceSettled = false;
	private archiveResourceClosed = false;
	private archiveCleanupPromise: Promise<void> | undefined;
	private archiveStatus: OutputArchiveStatus = "pending";
	private archiveTruncated = false;
	private archiveError: string | undefined;
	private archiveBytesAttempted = 0;
	private archivedBytes = 0;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = this.requirePositiveSafeInteger(options.maxLines ?? DEFAULT_MAX_LINES, "maxLines");
		this.maxBytes = this.requirePositiveSafeInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, "maxBytes");
		if (this.maxBytes > Math.floor(Number.MAX_SAFE_INTEGER / 2)) {
			throw new RangeError(`maxBytes must not exceed ${Math.floor(Number.MAX_SAFE_INTEGER / 2)}`);
		}
		this.maxArchiveBytes = this.requireNonNegativeSafeInteger(
			options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES,
			"maxArchiveBytes",
		);
		this.archiveCloseTimeoutMs = this.requirePositiveSafeInteger(
			options.archiveCloseTimeoutMs ?? DEFAULT_ARCHIVE_CLOSE_TIMEOUT_MS,
			"archiveCloseTimeoutMs",
		);
		if (this.archiveCloseTimeoutMs > MAX_TIMER_DELAY_MS) {
			throw new RangeError(`archiveCloseTimeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`);
		}
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "pi-output";
		this.archiveStreamFactory = options.archiveStreamFactory ?? defaultArchiveStreamFactory;
		this.tempFilePathFactory = options.tempFilePathFactory ?? defaultTempFilePath;
	}

	append(data: Buffer): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		this.totalRawBytes += data.length;
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));

		if (this.tempFileStream || this.tempFilePath || this.shouldUseTempFile()) {
			this.ensureTempFile();
			this.writeArchiveChunk(data);
		} else if (data.length > 0) {
			this.rawChunks.push(data);
		}
	}

	finish(): void {
		if (this.finished) return;
		this.finished = true;
		this.appendDecodedText(this.decoder.decode());
		if (this.shouldUseTempFile()) this.ensureTempFile();
	}

	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const tailTruncation = truncateTail(this.getSnapshotText(), {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};

		if (options.persistIfTruncated && truncation.truncated) this.ensureTempFile();

		const archive = this.archiveRequested
			? {
					...(this.archiveStatus === "succeeded" && this.tempFilePath ? { path: this.tempFilePath } : {}),
					archivedBytes: this.archivedBytes,
					maxBytes: this.maxArchiveBytes,
					status: this.archiveStatus,
					truncated: this.archiveTruncated,
					...(this.archiveError ? { error: this.archiveError } : {}),
				}
			: undefined;
		return {
			content: truncation.content,
			truncation,
			fullOutputPath:
				archive?.path && archive.status === "succeeded" && !archive.truncated && !archive.error
					? archive.path
					: undefined,
			archive,
		};
	}

	closeTempFile(): Promise<void> {
		this.closePromise ??= this.closeArchive();
		return this.closePromise;
	}

	private async closeArchive(): Promise<void> {
		this.finish();
		const stream = this.tempFileStream;
		if (!stream) {
			await this.archiveDone;
			await this.cleanupFailedArchive();
			return;
		}
		this.tempFileStream = undefined;

		const timeout = setTimeout(() => {
			this.recordArchiveError(new Error(`Output archive did not close within ${this.archiveCloseTimeoutMs}ms`));
			if (!stream.destroyed) {
				try {
					stream.destroy();
				} catch (error) {
					this.recordArchiveError(error);
				}
			}
			this.settleArchiveResource();
		}, this.archiveCloseTimeoutMs);
		if (!stream.destroyed && !stream.writableEnded) {
			try {
				stream.end();
			} catch (error) {
				this.recordArchiveError(error);
				if (!stream.destroyed) {
					try {
						stream.destroy();
					} catch (destroyError) {
						this.recordArchiveError(destroyError);
					}
				}
			}
		}
		await this.archiveDone;
		clearTimeout(timeout);
		await this.cleanupFailedArchive();
	}

	getLastLineBytes(): number {
		return this.currentLineBytes;
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) return;
		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) this.trimTail();

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
			this.hasOpenLine = true;
		} else {
			this.completedLines += newlines;
			const tail = text.slice(lastNewline + 1);
			this.currentLineBytes = byteLength(tail);
			this.hasOpenLine = tail.length > 0;
		}
		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}
		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) return this.tailText;
		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		);
	}

	private ensureTempFile(): void {
		if (this.archiveRequested) return;
		this.archiveRequested = true;
		this.archiveDone = new Promise((resolve) => {
			this.resolveArchiveDone = resolve;
		});
		try {
			const plannedPath = this.tempFilePathFactory(this.tempFilePrefix);
			this.archiveCleanupPath = plannedPath;
			const target = this.archiveStreamFactory(plannedPath);
			this.tempFilePath = plannedPath;
			const { stream } = target;
			this.tempFileStream = stream;
			// This listener is deliberately installed before buffered or live writes.
			stream.on("error", (error) => this.recordArchiveError(error));
			stream.once("close", () => {
				this.archiveResourceClosed = true;
				if (!stream.writableFinished) {
					this.recordArchiveError(new Error("Output archive closed before finishing"));
				} else {
					this.markArchiveSucceeded();
				}
				this.settleArchiveResource();
				void this.cleanupFailedArchive();
			});
			for (const chunk of this.rawChunks) this.writeArchiveChunk(chunk);
		} catch (error) {
			this.archiveResourceClosed = true;
			this.recordArchiveError(error);
			this.settleArchiveResource();
		}
		this.rawChunks = [];
	}

	private writeArchiveChunk(chunk: Buffer): void {
		if (chunk.length === 0 || this.archiveStatus === "failed") return;
		const remaining = this.maxArchiveBytes - this.archiveBytesAttempted;
		if (remaining <= 0) {
			this.archiveTruncated = true;
			return;
		}
		const output = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
		if (output.length < chunk.length) this.archiveTruncated = true;
		this.archiveBytesAttempted += output.length;
		try {
			this.tempFileStream?.write(output, (error) => {
				if (error) this.recordArchiveError(error);
				else this.archivedBytes += output.length;
			});
		} catch (error) {
			this.recordArchiveError(error);
		}
	}

	private markArchiveSucceeded(): void {
		if (this.archiveStatus === "pending") this.archiveStatus = "succeeded";
	}

	private settleArchiveResource(): void {
		if (this.archiveResourceSettled) return;
		this.archiveResourceSettled = true;
		this.resolveArchiveDone?.();
	}

	private recordArchiveError(error: unknown): void {
		this.archiveError ??= formatArchiveError(error, this.archiveCleanupPath);
		this.archiveStatus = "failed";
	}

	private cleanupFailedArchive(): Promise<void> {
		if (this.archiveStatus !== "failed" || !this.archiveCleanupPath || !this.archiveResourceClosed) {
			return Promise.resolve();
		}
		this.archiveCleanupPromise ??= this.removeFailedArchive();
		return this.archiveCleanupPromise;
	}

	private async removeFailedArchive(): Promise<void> {
		const path = this.archiveCleanupPath;
		if (!path) return;
		try {
			await rm(path, { force: true });
			this.tempFilePath = undefined;
			this.archiveCleanupPath = undefined;
			this.archivedBytes = 0;
		} catch (error) {
			const cleanupError = formatArchiveError(error, path);
			this.archiveError = `${this.archiveError ?? "Output archive failed"}; cleanup failed: ${cleanupError}`;
		}
	}

	private requireNonNegativeSafeInteger(value: number, name: string): number {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new RangeError(`${name} must be a non-negative safe integer`);
		}
		return value;
	}

	private requirePositiveSafeInteger(value: number, name: string): number {
		if (!Number.isSafeInteger(value) || value <= 0) {
			throw new RangeError(`${name} must be a positive safe integer`);
		}
		return value;
	}
}
