import type { Api, Model } from "./types.ts";
import { uuidv7 } from "./utils/uuid.ts";

export const CODEX_REQUEST_ROUTE = "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_REQUEST_API = "openai-codex-responses";

/** Explicit opt-in. These primitives are copied before asynchronous preparation. */
export interface RequestIdentity {
	provider: string;
	model: string;
	route: string;
}

/** Credential-free local observations, not proof of server-side serving weights. */
export interface RequestAttempt extends Readonly<RequestIdentity> {
	callId: string;
	attempt: number;
	api: typeof CODEX_REQUEST_API;
	transport: "sse" | "websocket";
	phase: "prepared" | "dispatched" | "completed" | "error" | "aborted";
	/** Present only after checking the actual serialized request. */
	serializedModel?: string;
}

export class RequestIdentityError extends Error {
	constructor(reason: string) {
		super(`Request identity refused: ${reason}`);
		this.name = "RequestIdentityError";
	}
}

export function captureRequestIdentity(value: RequestIdentity): Readonly<RequestIdentity> {
	const { provider, model, route } = value;
	if (
		provider !== "openai-codex" ||
		route !== CODEX_REQUEST_ROUTE ||
		typeof model !== "string" ||
		!model.length ||
		model.length > 256 ||
		/[\s\x00-\x1f\x7f]/u.test(model)
	) {
		throw new RequestIdentityError("unsupported pin");
	}
	return Object.freeze({ provider, model, route });
}

export function assertRequestIdentity(
	pin: Readonly<RequestIdentity>,
	model: Pick<Model<Api>, "provider" | "api" | "id" | "baseUrl">,
): void {
	if (typeof model.baseUrl !== "string") throw new RequestIdentityError("missing model route");
	const base = model.baseUrl.replace(/\/+$/, "");
	const route = base.endsWith("/codex/responses")
		? base
		: base.endsWith("/codex")
			? `${base}/responses`
			: `${base}/codex/responses`;
	if (
		model.provider !== pin.provider ||
		model.api !== CODEX_REQUEST_API ||
		model.id !== pin.model ||
		route !== pin.route
	) {
		throw new RequestIdentityError("model or route changed");
	}
}

/** Adapter-owned final checks stay outside swallowed extension-hook errors. */
export class RequestIdentityGuard {
	readonly pin: Readonly<RequestIdentity>;
	private readonly model: Model<Api>;
	private readonly recorder: ((attempt: RequestAttempt) => void) | undefined;
	private readonly callId = uuidv7();
	private attempt = 0;
	private active: RequestAttempt | undefined;
	private terminal = false;

	constructor(pin: RequestIdentity, model: Model<Api>, recorder?: (attempt: RequestAttempt) => void) {
		this.pin = captureRequestIdentity(pin);
		this.model = model;
		this.recorder = recorder;
	}

	check(serialized: string, url: string): void {
		assertRequestIdentity(this.pin, this.model);
		if (url !== this.pin.route && url !== this.pin.route.replace(/^https:/, "wss:")) {
			throw new RequestIdentityError("transport route changed");
		}
		let body: unknown;
		try {
			body = JSON.parse(serialized);
		} catch {
			throw new RequestIdentityError("invalid serialized body");
		}
		if (!body || typeof body !== "object" || (body as Record<string, unknown>).model !== this.pin.model) {
			throw new RequestIdentityError("serialized model changed or missing");
		}
		if (url.startsWith("wss:") && (body as Record<string, unknown>).type !== "response.create")
			throw new RequestIdentityError("unsupported serialized API operation");
	}

	prepare(serialized: string, url: string, transport: RequestAttempt["transport"]): void {
		// A retry can refuse before preparation, after the previous terminal was recorded.
		// Keep that refusal distinct rather than silently reusing the prior terminal.
		this.terminal = false;
		this.active = undefined;
		this.check(serialized, url);
		if (++this.attempt > 64) throw new RequestIdentityError("attempt limit");
		this.active = {
			...this.pin,
			callId: this.callId,
			attempt: this.attempt,
			api: CODEX_REQUEST_API,
			transport,
			phase: "prepared",
			serializedModel: this.pin.model,
		};
		this.emit(this.active);
		// A trusted observer can mutate caller objects; recheck after recording too.
		this.check(serialized, url);
	}

	dispatched(): void {
		if (this.active) this.emit({ ...this.active, phase: "dispatched" });
	}

	finish(phase: "completed" | "error" | "aborted"): void {
		if (this.terminal) return;
		this.terminal = true;
		this.emit({
			...(this.active ?? {
				...this.pin,
				callId: this.callId,
				attempt: 0,
				api: CODEX_REQUEST_API,
				transport: "sse" as const,
			}),
			phase,
		});
		this.active = undefined;
	}

	private emit(record: RequestAttempt): void {
		recordRequestAttempt(this.recorder, record);
	}
}

export function recordRequestAttempt(
	recorder: ((record: RequestAttempt) => void) | undefined,
	record: RequestAttempt,
): void {
	try {
		const result: unknown = recorder?.(Object.freeze(record));
		if (result && typeof result === "object" && "then" in result) {
			void Promise.resolve(result).catch(() => {});
			throw new Error("asynchronous recorder");
		}
	} catch {
		throw new RequestIdentityError("attempt recorder failed");
	}
}
