import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ImageContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getMessageText, getUserTexts, type Harness, type HarnessOptions } from "../harness.ts";

function gate() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

const largeTool: AgentTool = {
	name: "large_result",
	label: "Large result",
	description: "Large offline result",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "x".repeat(8000) }], details: {} }),
};
function seed(h: Harness) {
	const model = h.getModel();
	h.sessionManager.appendMessage({ role: "user", content: "old history", timestamp: Date.now() - 2000 });
	h.sessionManager.appendMessage({
		...fauxAssistantMessage("old response", { timestamp: Date.now() - 1000 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
	});
	h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
}

const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };

// #9783: explicit prompt stop is not the same operation as summary-attempt cancellation.
describe("#9783 prompt stop", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		for (const h of harnesses.splice(0)) h.cleanup();
	});
	async function setup(options: HarnessOptions = {}) {
		const h = await createHarness({
			models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
			settings: {
				compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1 },
				retry: { enabled: true, baseDelayMs: 0, maxRetries: 1 },
			},
			tools: [largeTool],
			...options,
		});
		harnesses.push(h);
		return h;
	}

	// #9783: stopping an awaited startup hook must not erase already submitted input.
	it("Given a held agent_start hook, When explicitly stopped, Then the submitted text/images persist without a provider call", async () => {
		const entered = gate();
		const release = gate();
		const h = await setup({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("agent_start", async () => {
						entered.release();
						await release.promise;
					});
				},
			],
		});
		const run = h.session.prompt("submitted", { images: [image] });
		await entered.promise;
		const stopped = h.session.abort();
		release.release();
		await run;
		await stopped;
		expect(getUserTexts(h)).toEqual(["submitted"]);
		expect(h.session.messages.find((m) => m.role === "user")?.content).toContainEqual(image);
		expect(h.sessionManager.getEntries().filter((e) => e.type === "message" && e.message.role === "user")).toEqual([
			expect.objectContaining({
				message: expect.objectContaining({ content: [{ type: "text", text: "submitted" }, image] }),
			}),
		]);
		expect(h.faux.state.callCount).toBe(0);
		expect(h.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it.each(["prompt is too long", "529 overloaded"])(
		"Given failed message_end (%s), When abort is called, Then no recovery starts",
		async (errorMessage) => {
			const h = await setup();
			seed(h);
			h.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage }),
				fauxAssistantMessage("unexpected"),
			]);
			let stopped: Promise<void> | undefined;
			h.session.subscribe((e) => {
				if (e.type === "message_end" && e.message.role === "assistant" && e.message.stopReason === "error")
					stopped = h.session.abort();
			});
			await h.session.prompt("x".repeat(10000));
			await stopped;
			expect(h.faux.state.callCount).toBe(1);
			expect(h.eventsOfType("compaction_start")).toEqual([]);
			expect(h.eventsOfType("auto_retry_start")).toEqual([]);
			expect(h.eventsOfType("agent_end").at(-1)?.willRetry).toBe(false);
			expect(h.eventsOfType("agent_settled")).toHaveLength(1);
		},
	);

	it.each(["stop", "attempt", "veto", "healthy"] as const)(
		"Given between-turn compaction, When %s, Then only explicit stop prevents the next request",
		async (action) => {
			const entered = gate();
			const release = gate();
			const h = await setup({
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (e) => {
							entered.release();
							await release.promise;
							if (action === "veto") return { cancel: true };
							return {
								compaction: {
									summary: "checkpoint",
									firstKeptEntryId: e.preparation.firstKeptEntryId,
									tokensBefore: e.preparation.tokensBefore,
								},
							};
						});
					},
				],
			});
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("continued"),
			]);
			const run = h.session.prompt("run tool");
			await entered.promise;
			const stopped = action === "stop" ? h.session.abort() : undefined;
			if (action === "attempt") h.session.abortCompaction();
			// Prevent a second threshold check obscuring the single between-turn attempt.
			h.session.setAutoCompactionEnabled(false);
			release.release();
			await run;
			await stopped;
			expect(h.faux.state.callCount).toBe(action === "stop" ? 1 : 2);
			expect(h.eventsOfType("compaction_start")).toHaveLength(1);
			expect(h.eventsOfType("compaction_end")).toHaveLength(1);
			expect(h.eventsOfType("compaction_end")[0]?.aborted).toBe(action !== "healthy");
		},
	);

	it.each(["one-at-a-time", "all"] as const)(
		"Given %s original queues before compaction, When stopped, Then fresh prompt delivers FIFO exactly once with images",
		async (mode) => {
			const entered = gate();
			const release = gate();
			const originals: AgentMessage[] = [];
			const h = await setup({
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async () => {
							entered.release();
							await release.promise;
							return { cancel: true };
						});
					},
				],
			});
			h.session.setSteeringMode(mode);
			h.session.setFollowUpMode(mode);
			const steer = vi.spyOn(h.session.agent, "steer");
			const follow = vi.spyOn(h.session.agent, "followUp");
			h.session.agent.subscribe(async (e) => {
				if (e.type === "turn_end" && e.message.role === "assistant" && e.message.stopReason === "toolUse") {
					await h.session.steer("s1", [image]);
					await h.session.steer("s2", [image]);
					await h.session.followUp("f1", [image]);
					await h.session.followUp("f2", [image]);
					originals.push(...steer.mock.calls.map(([m]) => m), ...follow.mock.calls.map(([m]) => m));
				}
			});
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("unexpected"),
			]);
			const run = h.session.prompt("run tool");
			await entered.promise;
			const stopped = h.session.abort();
			h.session.setAutoCompactionEnabled(false);
			release.release();
			await run;
			await stopped;
			expect(h.faux.state.callCount).toBe(1);
			expect(h.session.pendingMessageCount).toBe(4);
			expect(getUserTexts(h)).toEqual(["run tool"]);
			const requests: string[][] = [];
			h.setResponses(
				Array.from({ length: 6 }, () => (context) => {
					requests.push(context.messages.filter((m) => m.role === "user").map(getMessageText));
					return fauxAssistantMessage("delivered");
				}),
			);
			await h.session.prompt("explicit fresh prompt");
			expect(h.session.getLastAssistantText()).toBe("delivered");
			expect(getUserTexts(h)).toEqual(["run tool", "explicit fresh prompt", "s1", "s2", "f1", "f2"]);
			for (const original of originals) {
				expect(h.session.messages.filter((m) => m === original)).toHaveLength(1);
				expect(requests.some((r) => r.includes(getMessageText(original)))).toBe(true);
				expect(original.role).toBe("user");
				if (original.role === "user") expect(original.content).toContainEqual(image);
			}
			expect(h.session.pendingMessageCount).toBe(0);
			expect(h.session.agent.hasQueuedMessages()).toBe(false);
			expect(requests[0]).toEqual([
				"run tool",
				"explicit fresh prompt",
				...(mode === "all" ? ["s1", "s2"] : ["s1"]),
			]);
		},
	);

	it("Given queues reserved before compaction, When stop and clear, Then cleared originals never return", async () => {
		const entered = gate();
		const release = gate();
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => {
						entered.release();
						await release.promise;
						return { cancel: true };
					});
				},
			],
		});
		h.session.agent.subscribe(async (e) => {
			if (e.type === "turn_end" && e.message.role === "assistant" && e.message.stopReason === "toolUse") {
				await h.session.steer("cleared steer");
				await h.session.followUp("cleared follow");
			}
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("unexpected"),
		]);
		const run = h.session.prompt("run tool");
		await entered.promise;
		const stopped = h.session.abort();
		h.session.clearQueue();
		h.session.setAutoCompactionEnabled(false);
		release.release();
		await run;
		await stopped;
		h.setResponses([fauxAssistantMessage("fresh")]);
		await h.session.prompt("fresh");
		expect(getUserTexts(h)).toEqual(["run tool", "fresh"]);
		expect(h.session.agent.hasQueuedMessages()).toBe(false);
	});

	it.each([
		["steer", false],
		["followUp", false],
		["steer", true],
		["followUp", true],
	] as const)(
		"Given delayed %s input, When released after stop (new run completed: %s), Then transformed input waits for an explicit prompt",
		async (behavior, newRun) => {
			const provider = gate();
			const input = gate();
			const release = gate();
			const h = await setup({
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.on("input", async (e) => {
							if (e.text === "delayed") {
								input.release();
								await release.promise;
								return { action: "transform", text: "transformed", images: e.images };
							}
						});
					},
				],
			});
			h.setResponses([
				async (_context, options) => {
					provider.release();
					await new Promise<void>((resolve) =>
						options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					);
					return fauxAssistantMessage("", { stopReason: "aborted" });
				},
				fauxAssistantMessage("unsolicited"),
			]);
			const run = h.session.prompt("old");
			await provider.promise;
			const delayed = h.session.prompt("delayed", { streamingBehavior: behavior, images: [image] });
			await input.promise;
			await h.session.abort();
			await run;
			if (newRun) {
				h.setResponses([fauxAssistantMessage("explicit intervening run")]);
				await h.session.prompt("intervening");
			}
			release.release();
			await delayed;
			expect(h.faux.state.callCount).toBe(newRun ? 2 : 1);
			const beforeFresh = newRun ? ["old", "intervening"] : ["old"];
			expect(getUserTexts(h)).toEqual(beforeFresh);
			expect(behavior === "steer" ? h.session.getSteeringMessages() : h.session.getFollowUpMessages()).toEqual([
				"transformed",
			]);
			h.setResponses([fauxAssistantMessage("fresh"), fauxAssistantMessage("followed up")]);
			await h.session.prompt("fresh");
			expect(getUserTexts(h)).toEqual([...beforeFresh, "fresh", "transformed"]);
			const delivered = h.session.messages.find((m) => m.role === "user" && getMessageText(m) === "transformed");
			expect(delivered && "content" in delivered && delivered.content).toContainEqual(image);
			expect(h.session.pendingMessageCount).toBe(0);
		},
	);

	it("Given compaction queue flush after explicit stop, When input handlers settle after the run, Then no new run starts", async () => {
		const entered = gate();
		const release = gate();
		const input = gate();
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (e) => {
						if (e.text === "queued during compaction") await input.promise;
					});
					pi.on("session_before_compact", async () => {
						entered.release();
						await release.promise;
						return { cancel: true };
					});
				},
			],
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("unsolicited"),
		]);
		const run = h.session.prompt("old");
		await entered.promise;
		const stopped = h.session.abort();
		let flushed: Promise<void> | undefined;
		h.session.subscribe((e) => {
			if (e.type === "compaction_end")
				flushed = h.session.prompt("queued during compaction", { streamingBehavior: "steer" });
		});
		h.session.setAutoCompactionEnabled(false);
		release.release();
		await run;
		await stopped;
		input.release();
		await flushed;
		expect(h.faux.state.callCount).toBe(1);
		h.setResponses([fauxAssistantMessage("fresh")]);
		await h.session.prompt("fresh");
		expect(getUserTexts(h)).toEqual(["old", "fresh", "queued during compaction"]);
	});

	it.each(["continue", "handled"] as const)(
		"Given delayed input on a healthy run, When the hook returns %s after settlement, Then normal input semantics remain",
		async (action) => {
			const provider = gate();
			const finish = gate();
			const input = gate();
			const release = gate();
			const h = await setup({
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.on("input", async (e) => {
							if (e.text !== "delayed") return;
							input.release();
							await release.promise;
							return { action };
						});
					},
				],
			});
			h.setResponses([
				async () => {
					provider.release();
					await finish.promise;
					return fauxAssistantMessage("complete");
				},
				fauxAssistantMessage("new run"),
			]);
			const run = h.session.prompt("old");
			await provider.promise;
			const delayed = h.session.prompt("delayed", { streamingBehavior: "steer" });
			await input.promise;
			finish.release();
			await run;
			release.release();
			await delayed;
			expect(h.faux.state.callCount).toBe(action === "handled" ? 1 : 2);
			expect(h.session.pendingMessageCount).toBe(0);
		},
	);
});
