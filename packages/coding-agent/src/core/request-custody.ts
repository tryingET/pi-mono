import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	type Stats,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
	type AnyModel,
	type Api,
	assertRequestIdentity,
	type Context,
	captureRequestIdentity,
	type Model,
	type ModelsApiStreamOptions,
	type ModelsSimpleStreamOptions,
	type RequestAttempt,
	type RequestIdentity,
	RequestIdentityError,
	uuidv7,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "./agent-session.ts";
import type { ModelRuntime, ModelRuntimeAuthOverrides } from "./model-runtime.ts";

const MAX_RECORDS = 4096;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_RECORD_BYTES = 4096;
const MAX_CALLS = 1024;
const underlyingRuntimes = new WeakMap<ModelRuntime, ModelRuntime>();
const PHASES = new Set(["prepared", "dispatched", "completed", "error", "aborted"]);
const FIELDS = new Set([
	"schema",
	"sessionId",
	"runId",
	"provider",
	"model",
	"route",
	"api",
	"callId",
	"attempt",
	"transport",
	"phase",
	"serializedModel",
]);

export interface RequestCustodyRecord extends RequestAttempt {
	schema: "pi.request-custody.v1";
	sessionId: string;
	runId: string;
}

function assertLabel(label: unknown): asserts label is string {
	if (typeof label !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(label))
		throw new RequestIdentityError("invalid correlation id");
}

function assertFile(stat: Stats): void {
	if (
		!stat.isFile() ||
		stat.size > MAX_BYTES ||
		stat.nlink !== 1 ||
		(stat.mode & 0o777) !== 0o600 ||
		(typeof process.getuid === "function" && stat.uid !== process.getuid())
	)
		throw new RequestIdentityError("invalid custody file");
}

function assertRecord(value: unknown): asserts value is RequestCustodyRecord {
	if (!value || typeof value !== "object" || Object.keys(value).some((key) => !FIELDS.has(key)))
		throw new RequestIdentityError("invalid custody record");
	const r = value as RequestCustodyRecord;
	assertLabel(r.callId);
	assertLabel(r.sessionId);
	assertLabel(r.runId);
	captureRequestIdentity(r);
	if (
		r.schema !== "pi.request-custody.v1" ||
		r.api !== "openai-codex-responses" ||
		!PHASES.has(r.phase) ||
		!Number.isInteger(r.attempt) ||
		r.attempt < 0 ||
		r.attempt > 64 ||
		!["sse", "websocket"].includes(r.transport) ||
		(r.serializedModel !== undefined && r.serializedModel !== r.model) ||
		(r.attempt === 0 && (r.serializedModel !== undefined || (r.phase !== "error" && r.phase !== "aborted"))) ||
		(r.phase === "prepared" && r.serializedModel !== r.model)
	)
		throw new RequestIdentityError("invalid custody fields");
}

function terminal(phase: RequestAttempt["phase"]): boolean {
	return phase === "completed" || phase === "error" || phase === "aborted";
}

function checkTransition(previous: RequestCustodyRecord | undefined, next: RequestCustodyRecord): void {
	if (!previous) {
		if (next.phase !== "prepared" && !(next.attempt === 0 && terminal(next.phase)))
			throw new RequestIdentityError("custody missing preparation");
		return;
	}
	if (
		terminal(previous.phase) ||
		next.phase === "prepared" ||
		(previous.phase === "dispatched" && next.phase === "dispatched") ||
		(next.phase === "completed" && previous.phase !== "dispatched") ||
		next.sessionId !== previous.sessionId ||
		next.runId !== previous.runId ||
		next.provider !== previous.provider ||
		next.model !== previous.model ||
		next.route !== previous.route ||
		next.transport !== previous.transport ||
		next.serializedModel !== previous.serializedModel
	)
		throw new RequestIdentityError("custody transition changed");
}

/** Checked readback preserves incomplete attempts as UNKNOWN, never inventing terminals. */
export function readRequestCustody(path: string): {
	records: RequestCustodyRecord[];
	unknown: string[];
	tornTail: boolean;
} {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		assertFile(fstatSync(fd));
		const bytes = readFileSync(fd);
		const text = bytes.toString("utf8");
		if (!Buffer.from(text).equals(bytes)) throw new RequestIdentityError("invalid custody encoding");
		const tornTail = !!text && !text.endsWith("\n");
		const lines = text.split("\n");
		lines.pop();
		if (lines.length > MAX_RECORDS) throw new RequestIdentityError("custody record limit");
		const records: RequestCustodyRecord[] = [];
		const states = new Map<string, RequestCustodyRecord>();
		const calls = new Map<string, string>();
		for (const line of lines) {
			if (Buffer.byteLength(line) + 1 > MAX_RECORD_BYTES) throw new RequestIdentityError("custody record too large");
			let record: unknown;
			try {
				record = JSON.parse(line);
			} catch {
				throw new RequestIdentityError("invalid custody record");
			}
			assertRecord(record);
			const correlation = `${record.sessionId}/${record.runId}`;
			if (calls.has(record.callId) && calls.get(record.callId) !== correlation)
				throw new RequestIdentityError("custody run changed");
			calls.set(record.callId, correlation);
			if (calls.size > MAX_CALLS) throw new RequestIdentityError("custody call limit");
			const key = `${record.callId}/${record.attempt}`;
			checkTransition(states.get(key), record);
			states.set(key, record);
			records.push(record);
		}
		return { records, unknown: [...states].filter(([, r]) => !terminal(r.phase)).map(([key]) => key), tornTail };
	} finally {
		closeSync(fd);
	}
}

/** One exclusive host-owned journal; synchronous durable append is the dispatch barrier. */
export class RequestCustody {
	readonly path: string;
	readonly sessionId: string;
	readonly pin: Readonly<RequestIdentity>;
	private readonly fd: number;
	private readonly dev: number;
	private readonly ino: number;
	private expectedBytes: Buffer = Buffer.alloc(0);
	private records = 0;
	private readonly calls = new Map<string, string>();
	private readonly states = new Map<string, RequestCustodyRecord>();
	private readonly open = new Set<string>();
	private broken = false;
	private closed = false;
	private draining = false;
	private activeRun: string | undefined;

	constructor(path: string, sessionId: string, pin: RequestIdentity) {
		if (!isAbsolute(path)) throw new RequestIdentityError("custody path must be absolute");
		assertLabel(sessionId);
		this.pin = captureRequestIdentity(pin);
		this.path = path;
		this.sessionId = sessionId;
		const directory = lstatSync(dirname(path));
		if (
			!directory.isDirectory() ||
			directory.isSymbolicLink() ||
			(directory.mode & 0o077) !== 0 ||
			(typeof process.getuid === "function" && directory.uid !== process.getuid())
		)
			throw new RequestIdentityError("custody directory must be owned and private");
		this.fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		const stat = fstatSync(this.fd);
		this.dev = stat.dev;
		this.ino = stat.ino;
		try {
			fsyncSync(this.fd);
			const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			try {
				fsyncSync(parent);
			} finally {
				closeSync(parent);
			}
		} catch (error) {
			closeSync(this.fd);
			throw error;
		}
	}

	get runId(): string | undefined {
		return this.activeRun;
	}

	/** Reusing an exposed view must not reuse another session's admission or journal lifetime. */
	static baseRuntime(runtime: ModelRuntime): ModelRuntime {
		return underlyingRuntimes.get(runtime) ?? runtime;
	}

	static snapshot(
		pin: RequestIdentity | undefined,
		model: Model<Api> | undefined,
	): Readonly<RequestIdentity> | undefined {
		if (!pin) return undefined;
		const copied = captureRequestIdentity(pin);
		if (!model) throw new RequestIdentityError("strict SDK requires an explicit catalog model");
		assertRequestIdentity(copied, model);
		return copied;
	}

	static create(directory: string, sessionId: string, pin: RequestIdentity): RequestCustody {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		return new RequestCustody(join(directory, `${sessionId}-${uuidv7()}.jsonl`), sessionId, pin);
	}

	attach(session: Pick<AgentSession, "subscribe" | "dispose" | "agent">): void {
		session.subscribe((event) => {
			if (event.type === "agent_settled") this.endRun();
		});
		const dispose = session.dispose.bind(session);
		session.dispose = () => {
			if (this.draining || this.closed) return;
			this.draining = true;
			try {
				dispose();
			} finally {
				// In-flight provider cancellation records its real terminal before idle.
				if (session.agent.state.isStreaming) {
					void session.agent.waitForIdle().then(
						() => this.close(),
						() => this.close(),
					);
				} else {
					this.close();
				}
			}
		};
	}

	/** Only private foreground option objects may enter this session-local view. */
	bindRuntime(runtime: ModelRuntime, foregroundOptions: WeakSet<object>): ModelRuntime {
		const custody = this;
		runtime = RequestCustody.baseRuntime(runtime);
		const scoped = new Proxy(runtime, {
			get(target, property) {
				if (property === "getAuth")
					return (subject: string | AnyModel, overrides?: ModelRuntimeAuthOverrides) => {
						const model =
							typeof subject === "string"
								? target.getPhysicalModel(custody.pin.provider, custody.pin.model)
								: subject;
						if (!model || (typeof subject === "string" && subject !== custody.pin.provider))
							throw new RequestIdentityError("authentication selection changed");
						target.assertStrictRequestIdentity(model, custody.pin);
						return typeof subject === "string"
							? target.getAuth(subject, overrides)
							: target.getAuth(subject, overrides);
					};
				if (["stream", "streamSimple", "complete", "completeSimple"].includes(String(property))) {
					return (model: Model<Api>, context: Context, options: ModelsSimpleStreamOptions = {}) => {
						if (!custody.runId || !foregroundOptions.has(options) || options.sessionId !== custody.sessionId)
							throw new RequestIdentityError("unsupported out-of-band request");
						const observer = options.onRequestAttempt;
						const pinned = {
							...options,
							requestIdentity: custody.pin,
							onRequestAttempt: (attempt: RequestAttempt) => {
								custody.record(attempt);
								return observer?.(attempt);
							},
						};
						const stream =
							property === "stream" || property === "complete"
								? target.stream(model, context, pinned as ModelsApiStreamOptions<Api>)
								: target.streamSimple(model, context, pinned);
						return property === "complete" || property === "completeSimple" ? stream.result() : stream;
					};
				}
				if (
					[
						"resolveModel",
						"streamDeferred",
						"fetchDeferred",
						"cancelDeferred",
						"generateImages",
						"classify",
					].includes(String(property))
				)
					return () => {
						throw new RequestIdentityError("unsupported strict operation");
					};
				const value: unknown = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		underlyingRuntimes.set(scoped, runtime);
		return scoped;
	}
	beginRun(): void {
		if (!this.activeRun) this.activeRun = uuidv7();
	}
	/** Called only by the SDK's private agent-loop delegate, never its public stream function. */
	registerForeground(options: ModelsSimpleStreamOptions, admitted: WeakSet<object>): void {
		if (this.draining || this.closed) throw new RequestIdentityError("custody unavailable");
		this.beginRun();
		admitted.add(options);
	}
	endRun(): void {
		this.activeRun = undefined;
	}

	record(attempt: RequestAttempt): void {
		if (!this.activeRun || this.closed || this.broken) throw new RequestIdentityError("custody unavailable");
		const record: RequestCustodyRecord = {
			schema: "pi.request-custody.v1",
			sessionId: this.sessionId,
			runId: this.activeRun,
			provider: attempt.provider,
			model: attempt.model,
			route: attempt.route,
			api: attempt.api,
			callId: attempt.callId,
			attempt: attempt.attempt,
			transport: attempt.transport,
			phase: attempt.phase,
			...(attempt.serializedModel === undefined ? {} : { serializedModel: attempt.serializedModel }),
		};
		assertRecord(record);
		if (record.provider !== this.pin.provider || record.model !== this.pin.model || record.route !== this.pin.route)
			throw new RequestIdentityError("custody identity changed");
		if (this.calls.has(record.callId) && this.calls.get(record.callId) !== this.activeRun)
			throw new RequestIdentityError("custody run changed");
		const key = `${record.callId}/${record.attempt}`;
		checkTransition(this.states.get(key), record);
		const data = Buffer.from(`${JSON.stringify(record)}\n`);
		const reserved =
			this.open.size +
			(record.phase === "prepared" ? 1 : 0) -
			(terminal(record.phase) && this.open.has(key) ? 1 : 0);
		if (
			data.length > MAX_RECORD_BYTES ||
			this.expectedBytes.length + data.length + reserved * MAX_RECORD_BYTES > MAX_BYTES ||
			this.records + 1 + reserved > MAX_RECORDS ||
			(!this.calls.has(record.callId) && this.calls.size >= MAX_CALLS)
		)
			throw new RequestIdentityError("custody capacity");
		try {
			this.checkBytes();
			let written = 0;
			while (written < data.length) {
				const count = writeSync(this.fd, data, written, data.length - written, this.expectedBytes.length + written);
				if (count <= 0) throw new RequestIdentityError("custody short write");
				written += count;
			}
			fsyncSync(this.fd);
			this.expectedBytes = Buffer.concat([this.expectedBytes, data]);
			this.checkBytes();
			this.records++;
			this.calls.set(record.callId, this.activeRun);
			this.states.set(key, record);
			if (record.phase === "prepared") this.open.add(key);
			if (terminal(record.phase)) this.open.delete(key);
		} catch {
			this.broken = true;
			throw new RequestIdentityError("custody append or readback failed");
		}
	}

	private checkBytes(): void {
		const stat = fstatSync(this.fd);
		assertFile(stat);
		const named = lstatSync(this.path);
		if (
			named.isSymbolicLink() ||
			named.dev !== this.dev ||
			named.ino !== this.ino ||
			named.size !== stat.size ||
			stat.size !== this.expectedBytes.length
		)
			throw new RequestIdentityError("custody file changed");
		const actual = Buffer.alloc(stat.size);
		let read = 0;
		while (read < actual.length) {
			const count = readSync(this.fd, actual, read, actual.length - read, read);
			if (count <= 0) throw new RequestIdentityError("custody short read");
			read += count;
		}
		if (!actual.equals(this.expectedBytes)) throw new RequestIdentityError("custody bytes changed");
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.activeRun = undefined;
		closeSync(this.fd);
	}
}
