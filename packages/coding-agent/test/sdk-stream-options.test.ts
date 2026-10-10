import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { readRequestCustody } from "../src/core/request-custody.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

describe("createAgentSession stream options", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-stream-options-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createModel(api: Api): Model<Api> {
		return {
			id: "capture-model",
			name: "Capture Model",
			api,
			provider: "capture-provider",
			baseUrl: "https://capture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
			headers: { "x-model": "model" },
		};
	}

	function createDoneMessage(api: Api, promptTokens = 0): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api,
			provider: "capture-provider",
			model: "capture-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: promptTokens,
				cacheWrite: 0,
				totalTokens: promptTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	function createDoneStream(api: Api, promptTokens = 0) {
		const stream = createAssistantMessageEventStream();
		stream.end(createDoneMessage(api, promptTokens));
		return stream;
	}

	async function captureStreamOptions(
		api: Api,
		settings: Partial<Settings>,
		requestOptions: SimpleStreamOptions = {},
		extensionFactory?: ExtensionFactory,
		providerEvent?: unknown,
	): Promise<SimpleStreamOptions | undefined> {
		const model = createModel(api);
		const settingsManager = SettingsManager.inMemory(settings);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: extensionFactory ? [extensionFactory] : [],
		});
		await resourceLoader.reload();

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		let capturedOptions: SimpleStreamOptions | undefined;

		modelRegistry.registerProvider(model.provider, {
			api,
			headers: { "x-provider": "provider" },
			streamSimple: (requestModel, _context, providerOptions) => {
				capturedOptions = providerOptions;
				if (providerEvent === undefined) return createDoneStream(api);

				const stream = createAssistantMessageEventStream();
				void (async () => {
					await providerOptions?.onProviderStreamEvent?.(providerEvent, requestModel);
					stream.end(createDoneMessage(api));
				})();
				return stream;
			},
		});

		const modelRuntime = getModelRuntime(modelRegistry);
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		try {
			if (providerEvent === undefined) {
				const stream = await session.agent.streamFunction(
					model,
					normalizeContext({ messages: [] }),
					requestOptions,
				);
				await stream.result();
			} else {
				await session.prompt("test");
			}
			return capturedOptions;
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	}

	async function createCacheWarmingSession(populate?: (manager: SessionManager, model: Model<Api>) => void) {
		const model: Model<Api> = {
			...createModel("anthropic-messages"),
			cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
			promptCache: { short: 300 },
		};
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		let providerCalls = 0;
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: () => {
				providerCalls++;
				return createDoneStream(model.api, 100_000);
			},
		});
		const sessionManager = SessionManager.inMemory(cwd);
		populate?.(sessionManager, model);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager: SettingsManager.inMemory({ cacheWarming: "idle" }),
			sessionManager,
		});
		return {
			session,
			providerCalls: () => providerCalls,
			dispose: () => {
				session.dispose();
				modelRegistry.unregisterProvider(model.provider);
			},
		};
	}

	it("schedules cache warming after a completed session request", async () => {
		const fixture = await createCacheWarmingSession();
		try {
			await fixture.session.prompt("test");
			expect(fixture.session.cacheWarmingStatus?.nextWarmAt).toBeGreaterThan(Date.now());

			// Equivalent shallow copies remain current, but removing the request prefix does not.
			fixture.session.agent.state.messages = [...fixture.session.agent.state.messages];
			fixture.session.agent.state.model = { ...fixture.session.agent.state.model };
			expect(fixture.session.cacheWarmingStatus?.nextWarmAt).toBeGreaterThan(Date.now());
			fixture.session.agent.state.messages = fixture.session.agent.state.messages.slice(1);
			expect(fixture.session.cacheWarmingStatus?.reason).toBe("conversation context changed");
		} finally {
			fixture.dispose();
		}
	});

	it("waits for the next request instead of restoring cache warming", async () => {
		const fixture = await createCacheWarmingSession((manager, model) => {
			manager.appendModelChange(model.provider, model.id);
			manager.appendThinkingLevelChange("off");
			manager.appendMessage({ role: "user", content: "test", timestamp: Date.now() - 60_000 });
			const assistant = { ...createDoneMessage(model.api, 100_000), timestamp: Date.now() - 59_000 };
			manager.appendMessage(assistant);
			manager.appendUsage("cache_warm", model.provider, model.id, assistant.usage);
		});
		try {
			expect(fixture.providerCalls()).toBe(0);
			expect(fixture.session.cacheWarmingStatus).toEqual({
				state: "inactive",
				reason: "waiting for first request",
			});
		} finally {
			fixture.dispose();
		}
	});

	it("forwards httpIdleTimeoutMs as timeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
	});

	it("defaults timeoutMs from httpIdleTimeoutMs for all providers", async () => {
		const options = await captureStreamOptions("openai-completions", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
	});

	it("lets request timeoutMs override httpIdleTimeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ httpIdleTimeoutMs: 1234 },
			{ timeoutMs: 0 },
		);

		expect(options?.timeoutMs).toBe(0);
	});

	it("forwards websocketConnectTimeoutMs from settings", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { websocketConnectTimeoutMs: 1234 });

		expect(options?.websocketConnectTimeoutMs).toBe(1234);
	});

	it("lets request websocketConnectTimeoutMs override settings", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ websocketConnectTimeoutMs: 1234 },
			{ websocketConnectTimeoutMs: 0 },
		);

		expect(options?.websocketConnectTimeoutMs).toBe(0);
	});

	it("forwards provider retry settings", async () => {
		const options = await captureStreamOptions("openai-completions", {
			retry: { provider: { maxRetries: 2, maxRetryDelayMs: 3000 } },
		});

		expect(options?.maxRetries).toBe(2);
		expect(options?.maxRetryDelayMs).toBe(3000);
	});

	// Regression test for #9784.
	it("forwards provider stream events to extensions", async () => {
		const providerEvent = { openrouter_metadata: { strategy: "direct" } };
		const extensionEvents: unknown[] = [];

		const options = await captureStreamOptions(
			"openai-completions",
			{},
			{},
			(pi) => {
				pi.on("provider_stream_event", (event) => {
					extensionEvents.push(event);
				});
			},
			providerEvent,
		);

		expect(options?.onProviderStreamEvent).toEqual(expect.any(Function));
		expect(extensionEvents).toEqual([
			{
				data: providerEvent,
				type: "provider_stream_event",
				provider: "capture-provider",
				api: "openai-completions",
				model: "capture-model",
			},
		]);
	});

	it("runs before_provider_headers on assembled headers without forwarding the transform", async () => {
		const options = await captureStreamOptions(
			"openai-completions",
			{},
			{ headers: { "x-explicit": "explicit" } },
			(pi) => {
				pi.on("before_provider_headers", (event) => {
					event.headers["x-hook"] = [
						event.headers["x-provider"],
						event.headers["x-model"],
						event.headers["x-explicit"],
					].join(":");
				});
			},
		);

		expect(options?.headers).toMatchObject({
			"x-provider": "provider",
			"x-model": "model",
			"x-explicit": "explicit",
			"x-hook": "provider:model:explicit",
		});
		expect(options).not.toHaveProperty("transformHeaders");
	});

	async function strictFixture(changePayload: boolean) {
		const token = `aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic" } })).toString("base64")}.bbb`;
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const auth = vi.spyOn(runtime, "getAuth").mockResolvedValue({ auth: { apiKey: token } });
		vi.spyOn(runtime, "hasConfiguredAuth").mockReturnValue(true);
		const model = { ...runtime.getModel("openai-codex", "gpt-6.1-sol")! };
		const settingsManager = SettingsManager.inMemory({ transport: "sse", retry: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: changePayload
				? [
						(pi) => {
							pi.on("before_provider_request", () => ({ model: "wrong" }));
						},
					]
				: [],
		});
		await resourceLoader.reload();
		const fetch = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				new Response(
					`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`,
				),
		);
		vi.stubGlobal("fetch", fetch);
		const created = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: runtime,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			noTools: "all",
			requestIdentity: {
				provider: "openai-codex",
				model: "gpt-6.1-sol",
				route: "https://chatgpt.com/backend-api/codex/responses",
			},
		});
		return { ...created, fetch, auth, settingsManager, resourceLoader };
	}

	it.each(["bug-report", "direct", "manual-conversion"] as const)(
		"AK6449 P1: refuses concurrent %s before dispatch",
		async (kind) => {
			const fixture = await strictFixture(false);
			const originalFetch = fixture.fetch.getMockImplementation()!;
			let release!: () => void;
			let ready!: () => void;
			const reached = new Promise<void>((resolve) => {
				ready = resolve;
			});
			fixture.fetch.mockImplementationOnce(
				(input, init) =>
					new Promise<Response>((resolve) => {
						release = () => resolve(originalFetch(input, init));
						ready();
					}),
			);
			const foreground = fixture.session.prompt("foreground");
			await reached;
			try {
				if (kind === "bug-report") {
					await expect(
						fixture.session.summarizeForBugReport({ signal: new AbortController().signal }),
					).rejects.toThrow("unsupported");
				} else {
					const messages = [{ role: "user" as const, content: "out-of-band", timestamp: 1 }];
					const converted =
						kind === "manual-conversion" ? await fixture.session.agent.convertToLlm(messages) : messages;
					const stream = await fixture.session.agent.streamFunction(
						fixture.session.model!,
						normalizeContext({ messages: converted }),
						{ sessionId: fixture.session.sessionManager.getSessionId() },
					);
					expect((await stream.result()).errorMessage).toContain("unsupported");
				}
				expect(fixture.fetch).toHaveBeenCalledTimes(1);
				expect(
					readRequestCustody(fixture.requestCustody!.path).records.filter((r) => r.phase === "prepared"),
				).toHaveLength(1);
			} finally {
				release();
				await foreground;
				fixture.session.dispose();
				vi.unstubAllGlobals();
			}
		},
	);

	it.each(["virtual-provider", "openai-codex"])(
		"AK6449 P1: refuses %s virtual routing before auth/transport",
		async (provider) => {
			const fixture = await strictFixture(false);
			const runtime = fixture.session.modelRuntime;
			const physical = fixture.session.model!;
			fixture.auth.mockClear();
			vi.spyOn(runtime, "checkAuth").mockResolvedValue({ type: "api_key", source: "synthetic" });
			const route = vi.fn(() => ({ model: physical, thinkingLevel: "off" as const }));
			runtime.registerVirtualModel({ provider, id: "virtual-pin", name: "virtual-pin", route });
			try {
				await fixture.session.setModel(runtime.getModel(provider, "virtual-pin")!);
				await fixture.session.prompt("virtual");
				expect(fixture.session.agent.state.errorMessage).toContain("unsupported");
				expect(route).not.toHaveBeenCalled();
				expect(fixture.auth).not.toHaveBeenCalled();
				expect(fixture.fetch).not.toHaveBeenCalled();
				expect(readRequestCustody(fixture.requestCustody!.path).records).toEqual([]);
			} finally {
				fixture.session.dispose();
				vi.unstubAllGlobals();
			}
		},
	);

	it("AK6449 P2: public refusal is observable through async iteration and result", async () => {
		const fixture = await strictFixture(false);
		try {
			const stream = await fixture.session.agent.streamFunction(
				fixture.session.model!,
				normalizeContext({ messages: [] }),
			);
			const events = [];
			for await (const event of stream) events.push(event);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				type: "error",
				reason: "error",
				error: { errorMessage: expect.stringContaining("unsupported") },
			});
			expect((await stream.result()).errorMessage).toContain("unsupported");
			expect(fixture.fetch).not.toHaveBeenCalled();
			expect(readRequestCustody(fixture.requestCustody!.path).records).toEqual([]);
		} finally {
			fixture.session.dispose();
			vi.unstubAllGlobals();
		}
	});

	it.each(["connect", "response"] as const)(
		"AK6449 P2: pending WebSocket %s disposal drains custody",
		async (phase) => {
			const fixture = await strictFixture(false);
			fixture.session.agent.transport = "websocket";
			let ready!: () => void;
			const reached = new Promise<void>((resolve) => {
				ready = resolve;
			});
			const connect = vi.fn();
			const send = vi.fn();
			const close = vi.fn();
			class MockWebSocket extends EventTarget {
				static OPEN = 1;
				readyState = 0;
				constructor() {
					super();
					connect();
					if (phase === "connect") ready();
					else
						queueMicrotask(() => {
							this.readyState = 1;
							this.dispatchEvent(new Event("open"));
						});
				}
				send() {
					send();
					ready();
				}
				close() {
					close();
					this.readyState = 3;
					this.dispatchEvent(new Event("close"));
				}
			}
			vi.stubGlobal("WebSocket", MockWebSocket);
			try {
				const foreground = fixture.session.prompt("websocket dispose");
				await reached;
				fixture.session.dispose();
				await foreground;
				const readback = readRequestCustody(fixture.requestCustody!.path);
				expect(readback.records.at(-1)?.phase).toBe("aborted");
				expect(readback.unknown).toEqual([]);
				expect(connect).toHaveBeenCalledTimes(1);
				expect(send).toHaveBeenCalledTimes(phase === "connect" ? 0 : 1);
				expect(close).toHaveBeenCalled();
				expect(fixture.fetch).not.toHaveBeenCalled();
			} finally {
				fixture.session.dispose();
				vi.unstubAllGlobals();
			}
		},
	);

	it("AK6449: successful provider retry retains a common run/call and both attempts", async () => {
		const fixture = await strictFixture(false);
		fixture.settingsManager.applyOverrides({ retry: { enabled: false, provider: { maxRetries: 1 } } });
		fixture.fetch.mockImplementationOnce(
			async () => new Response("temporary", { status: 503, headers: { "retry-after-ms": "1" } }),
		);
		try {
			await fixture.session.prompt("successful retry");
			const readback = readRequestCustody(fixture.requestCustody!.path);
			expect(fixture.fetch).toHaveBeenCalledTimes(2);
			expect(readback.records.map((r) => [r.attempt, r.phase])).toEqual([
				[1, "prepared"],
				[1, "dispatched"],
				[1, "error"],
				[2, "prepared"],
				[2, "dispatched"],
				[2, "completed"],
			]);
			expect(new Set(readback.records.map((r) => r.runId)).size).toBe(1);
			expect(new Set(readback.records.map((r) => r.callId)).size).toBe(1);
			expect(readback.unknown).toEqual([]);
		} finally {
			fixture.session.dispose();
			vi.unstubAllGlobals();
		}
	});

	it("AK6449: foreground queued follow-up retains custody in the same run", async () => {
		const fixture = await strictFixture(false);
		const original = fixture.fetch.getMockImplementation()!;
		fixture.fetch.mockImplementationOnce(async (input, init) => {
			fixture.session.agent.followUp({ role: "user", content: "queued", timestamp: 1 });
			return original(input, init);
		});
		try {
			await fixture.session.prompt("follow up");
			const readback = readRequestCustody(fixture.requestCustody!.path);
			expect(fixture.fetch).toHaveBeenCalledTimes(2);
			expect(readback.records.filter((r) => r.phase === "completed")).toHaveLength(2);
			expect(new Set(readback.records.map((r) => r.runId)).size).toBe(1);
			expect(readback.unknown).toEqual([]);
		} finally {
			fixture.session.dispose();
			vi.unstubAllGlobals();
		}
	});

	it("AK6449 P2: disposal drains an admitted fetch abort before closing custody", async () => {
		const fixture = await strictFixture(false);
		let ready!: () => void;
		const reached = new Promise<void>((resolve) => {
			ready = resolve;
		});
		fixture.fetch.mockImplementationOnce(
			(_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => queueMicrotask(() => reject(new Error("Request was aborted"))),
						{ once: true },
					);
					ready();
				}),
		);
		const foreground = fixture.session.prompt("foreground");
		await reached;
		fixture.session.dispose();
		await foreground;
		const result = readRequestCustody(fixture.requestCustody!.path);
		expect(result.records.at(-1)?.phase).toBe("aborted");
		expect(result.unknown).toEqual([]);
		vi.unstubAllGlobals();
	});

	it.each(["prepared", "dispatched"] as const)(
		"AK6449 P2: disposal during %s observation drains its real terminal",
		async (phase) => {
			const fixture = await strictFixture(false);
			const record = fixture.requestCustody!.record.bind(fixture.requestCustody);
			vi.spyOn(fixture.requestCustody!, "record").mockImplementation((attempt) => {
				record(attempt);
				if (attempt.phase === phase) fixture.session.dispose();
			});
			try {
				await fixture.session.prompt("dispose callback");
				const readback = readRequestCustody(fixture.requestCustody!.path);
				expect(readback.records.at(-1)?.phase).toBe("aborted");
				expect(readback.unknown).toEqual([]);
				expect(fixture.fetch).toHaveBeenCalledTimes(phase === "prepared" ? 0 : 1);
			} finally {
				fixture.session.dispose();
				vi.unstubAllGlobals();
			}
		},
	);

	it("AK6449 P2: an exposed runtime can be reused independently after first-session disposal", async () => {
		const first = await strictFixture(false);
		const second = await createAgentSession({
			cwd,
			agentDir,
			model: first.session.model!,
			modelRuntime: first.session.modelRuntime,
			settingsManager: first.settingsManager,
			resourceLoader: first.resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			noTools: "all",
			requestIdentity: first.requestCustody!.pin,
		});
		try {
			first.session.dispose();
			await second.session.prompt("independent");
			expect(first.fetch).toHaveBeenCalledTimes(1);
			expect(readRequestCustody(second.requestCustody!.path).records.at(-1)?.phase).toBe("completed");
		} finally {
			second.session.dispose();
			first.session.dispose();
			vi.unstubAllGlobals();
		}
	});

	it("AK6449 P2: a journal retains identity refusal after an earlier transport terminal", async () => {
		const fixture = await strictFixture(false);
		fixture.settingsManager.applyOverrides({ retry: { enabled: false, provider: { maxRetries: 1 } } });
		fixture.fetch.mockImplementationOnce(async () => {
			fixture.session.model!.id = "wrong";
			return new Response("temporary failure", { status: 503, headers: { "retry-after-ms": "1" } });
		});
		try {
			await fixture.session.prompt("retry");
			expect(fixture.fetch).toHaveBeenCalledTimes(1);
			const records = readRequestCustody(fixture.requestCustody!.path).records;
			expect(records.map((r) => [r.attempt, r.phase])).toEqual([
				[1, "prepared"],
				[1, "dispatched"],
				[1, "error"],
				[0, "error"],
			]);
		} finally {
			fixture.session.dispose();
			vi.unstubAllGlobals();
		}
	});

	it("AK6449: rejects a replacement extension payload and retains the first error independently", async () => {
		const fixture = await strictFixture(true);
		try {
			await fixture.session.prompt("synthetic prompt");
			expect(fixture.fetch).not.toHaveBeenCalled();
			expect(fixture.requestCustody).toBeDefined();
			const readback = readRequestCustody(fixture.requestCustody!.path);
			expect(readback.records.at(-1)?.phase).toBe("error");
			expect(readback.records.at(-1)?.serializedModel).toBeUndefined();
			expect(
				readback.records.every((record) => record.sessionId === fixture.session.sessionManager.getSessionId()),
			).toBe(true);
			expect(JSON.stringify(readback.records)).not.toContain("synthetic prompt");
		} finally {
			fixture.session.dispose();
			vi.unstubAllGlobals();
		}
	});

	it("AK6449: forwards exact pins into production transport and separates settled runs", async () => {
		const fixture = await strictFixture(false);
		try {
			await fixture.session.prompt("first synthetic prompt");
			await fixture.session.prompt("second synthetic prompt");
			expect(fixture.fetch).toHaveBeenCalledTimes(2);
			const readback = readRequestCustody(fixture.requestCustody!.path);
			expect(readback.records.filter((record) => record.phase === "prepared")).toHaveLength(2);
			expect(new Set(readback.records.map((record) => record.runId)).size).toBe(2);
			expect(readback.unknown).toEqual([]);
		} finally {
			fixture.session.dispose();
			vi.unstubAllGlobals();
		}
	});
});
