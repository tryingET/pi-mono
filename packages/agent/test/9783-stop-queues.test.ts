import {
	fauxAssistantMessage,
	getCurrentTools,
	type ImageContent,
	registerFauxProvider,
	type SystemMessage,
	streamSimple,
	type UserMessage,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";

function gate() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

// #9783: assert at the queue owner, not the session's display strings.
describe("stop during between-turn preparation", () => {
	// #9783: explicit prompts are accepted input, unlike queue-backed continue batches.
	it.each(["agent_start", "turn_start"] as const)(
		"Given an explicit initial prompt, When stopped at %s, Then its original text/images are accepted without a provider call",
		async (eventType) => {
			const faux = registerFauxProvider();
			const original: UserMessage = {
				role: "user",
				content: [
					{ type: "text", text: "retain me" },
					{ type: "image", mimeType: "image/png", data: "eA==" },
				],
				timestamp: 1,
			};
			const agent = new Agent({ streamFn: streamSimple, initialState: { model: faux.getModel() } });
			agent.subscribe((event) => {
				if (event.type === eventType) agent.abort();
			});
			try {
				await agent.prompt(original);
				expect(agent.state.messages.filter((m) => m === original)).toEqual([original]);
				expect(faux.state.callCount).toBe(0);
			} finally {
				faux.unregister();
			}
		},
	);

	for (const kind of ["steer", "followUp"] as const) {
		it.each([false, true])(
			`Given a queue-backed ${kind} continue, When stopped at agent_start (clear: %s), Then unaccepted originals are restored unless cleared`,
			async (clear) => {
				const faux = registerFauxProvider();
				const agent = new Agent({ streamFn: streamSimple, initialState: { model: faux.getModel() } });
				const original: UserMessage = { role: "user", content: "queued", timestamp: 1 };
				try {
					faux.setResponses([fauxAssistantMessage("first")]);
					await agent.prompt("old");
					agent[kind](original);
					const unsubscribe = agent.subscribe((event) => {
						if (event.type === "agent_start") {
							agent.abort();
							if (clear) agent.clearAllQueues();
						}
					});
					await agent.continue();
					expect(faux.state.callCount).toBe(1);
					expect(agent.state.messages).not.toContain(original);
					expect(agent.hasQueuedMessages()).toBe(!clear);
					unsubscribe();
					faux.setResponses([fauxAssistantMessage("fresh"), fauxAssistantMessage("queued")]);
					await agent.prompt("fresh");
					expect(agent.state.messages.filter((m) => m === original)).toHaveLength(clear ? 0 : 1);
					expect(agent.hasQueuedMessages()).toBe(false);
				} finally {
					faux.unregister();
				}
			},
		);
	}

	it.each(["steer", "followUp"] as const)(
		"Given a reserved %s system message and changed tools, When cleared during preparation, Then cleared content stays absent and the provider receives the executable loadout",
		async (kind) => {
			const faux = registerFauxProvider();
			const tool = {
				name: "new_tool",
				label: "New tool",
				description: "test",
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: {} }),
			};
			const queued: SystemMessage = { role: "system", content: "discard these instructions", timestamp: 1 };
			const agent = new Agent({
				streamFn: streamSimple,
				initialState: { model: faux.getModel(), tools: [{ ...tool, name: "old_tool" }] },
			});
			let first = true;
			agent.subscribe((event) => {
				if (event.type === "turn_end" && first) {
					first = false;
					agent[kind](queued);
				}
			});
			agent.prepareNextTurnWithContext = async (turn) => {
				agent.clearAllQueues();
				agent.state.tools = [tool];
				return { context: { ...turn.context, tools: [tool] } };
			};
			const seen: string[][] = [];
			faux.setResponses([
				fauxAssistantMessage("first"),
				(context) => {
					seen.push(getCurrentTools(context.messages).map((t) => t.name));
					return fauxAssistantMessage("next");
				},
			]);
			try {
				await agent.prompt("old");
				expect(faux.state.callCount).toBe(2);
				expect(agent.state.messages.some((m) => m.role === "system" && m.content === queued.content)).toBe(false);
				expect(agent.hasQueuedMessages()).toBe(false);
				expect(seen).toEqual([["new_tool"]]);
				expect(getCurrentTools(agent.state.messages).map((t) => t.name)).toEqual(["new_tool"]);
			} finally {
				faux.unregister();
			}
		},
	);

	for (const kind of ["steer", "followUp"] as const) {
		for (const mode of ["one-at-a-time", "all"] as const) {
			it.each(["stop", "stop and clear", "clear", "continue"] as const)(
				`Given reserved ${kind} in ${mode} mode, When %s during preparation, Then only live originals are delivered once`,
				async (action) => {
					const faux = registerFauxProvider();
					const image: ImageContent = { type: "image", mimeType: "image/png", data: "eA==" };
					const originals: UserMessage[] = [1, 2, 3].map((n) => ({
						role: "user",
						content: [{ type: "text", text: `queued-${n}` }, image],
						timestamp: n,
					}));
					const agent = new Agent({
						streamFn: streamSimple,
						initialState: { model: faux.getModel() },
						steeringMode: mode,
						followUpMode: mode,
					});
					const entered = gate();
					const release = gate();
					let first = true;
					agent.subscribe((e) => {
						if (e.type === "turn_end" && first) {
							first = false;
							for (const m of originals.slice(0, 2)) agent[kind](m);
						}
					});
					agent.prepareNextTurn = async () => {
						entered.release();
						await release.promise;
						return undefined;
					};
					try {
						faux.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage("ok")));
						const run = agent.prompt("old");
						await entered.promise;
						if (action.includes("stop")) agent.abort();
						if (action.includes("clear")) agent.clearAllQueues();
						// New arrivals must stay behind restored originals; clear must not discard new arrivals.
						agent[kind](originals[2]);
						release.release();
						await run;
						if (action.includes("stop")) {
							expect(faux.state.callCount).toBe(1);
							for (const m of originals) expect(agent.state.messages).not.toContain(m);
							expect(agent.hasQueuedMessages()).toBe(true);
						}
						agent.prepareNextTurn = undefined;
						faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("fresh")));
						await agent.prompt("fresh");
						const expected = action.includes("clear") ? originals.slice(2) : originals;
						const delivered = agent.state.messages.filter((m) => originals.includes(m as UserMessage));
						expect(delivered).toEqual(expected);
						for (const m of expected) {
							expect(delivered.filter((u) => u === m)).toHaveLength(1);
							expect(m.content).toContain(image);
						}
						expect(agent.hasQueuedMessages()).toBe(false);
					} finally {
						release.release();
						faux.unregister();
					}
				},
			);
		}
	}

	it.each(["steer", "followUp"] as const)(
		"Given an all-mode %s batch, When stopped after its first message, Then only unaccepted originals survive",
		async (kind) => {
			const faux = registerFauxProvider();
			const agent = new Agent({
				streamFn: streamSimple,
				initialState: { model: faux.getModel() },
				steeringMode: "all",
				followUpMode: "all",
			});
			const accepted: UserMessage = { role: "user", content: "accepted", timestamp: 1 };
			const pending: UserMessage = { role: "user", content: "pending", timestamp: 2 };
			let queued = false;
			const unsubscribe = agent.subscribe((e) => {
				if (e.type === "turn_end" && !queued) {
					queued = true;
					agent[kind](accepted);
					agent[kind](pending);
				}
				if (e.type === "message_end" && e.message === accepted) agent.abort();
			});
			try {
				faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("unexpected")]);
				await agent.prompt("old");
				expect(faux.state.callCount).toBe(1);
				expect(agent.state.messages).toContain(accepted);
				expect(agent.state.messages).not.toContain(pending);
				unsubscribe();
				faux.setResponses([fauxAssistantMessage("fresh")]);
				await agent.continue();
				expect(agent.state.messages.filter((m) => m === accepted)).toHaveLength(1);
				expect(agent.state.messages.filter((m) => m === pending)).toHaveLength(1);
				expect(agent.hasQueuedMessages()).toBe(false);
			} finally {
				faux.unregister();
			}
		},
	);

	it("Given a reserved system message in continue, When tool declarations normalize it, Then its original reservation is accepted exactly once", async () => {
		const faux = registerFauxProvider();
		const agent = new Agent({ streamFn: streamSimple, initialState: { model: faux.getModel() } });
		const system: SystemMessage = { role: "system", content: "queued system", timestamp: 1 };
		try {
			faux.setResponses([fauxAssistantMessage("first")]);
			await agent.prompt("old");
			agent.state.tools = [
				{
					name: "tool",
					label: "Tool",
					description: "test",
					parameters: Type.Object({}),
					execute: async () => ({ content: [], details: {} }),
				},
			];
			agent.steer(system);
			faux.setResponses([fauxAssistantMessage("next")]);
			await agent.continue();
			expect(agent.hasQueuedMessages()).toBe(false);
			await agent.prompt("fresh");
			expect(agent.state.messages.filter((m) => m.role === "system" && m.content === system.content)).toHaveLength(
				1,
			);
			expect(getCurrentTools(agent.state.messages).map((t) => t.name)).toEqual(["tool"]);
		} finally {
			faux.unregister();
		}
	});
});
