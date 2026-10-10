import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	normalizeContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.ts";
import type { AgentTool, StreamFn } from "../src/types.ts";

const model = {
	id: "synthetic",
	name: "synthetic",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
} satisfies Model<"openai-codex-responses">;
function message(tool = false): AssistantMessage {
	return {
		role: "assistant",
		content: tool
			? [{ type: "toolCall", id: "call", name: "synthetic", arguments: {} }]
			: [{ type: "text", text: "ok" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: tool ? "toolUse" : "stop",
		timestamp: 1,
	};
}
function stream(tool = false) {
	const result = createAssistantMessageEventStream();
	result.end(message(tool));
	return result;
}

describe("AK6449 private loop stream admission", () => {
	it("uses the separate delegate for prompt/continuation, never public calls or converted options", async () => {
		const publicStream = vi.fn<StreamFn>(() => stream());
		const loopStream = vi.fn<StreamFn>(() => stream());
		const agent = new Agent({ initialState: { model }, streamFn: publicStream, loopStreamFn: loopStream });
		await agent.prompt("first");
		agent.state.messages = [{ role: "user", content: "continue", timestamp: 1 }];
		await agent.continue();
		expect(loopStream).toHaveBeenCalledTimes(2);
		const converted = await agent.convertToLlm([{ role: "user", content: "manual", timestamp: 1 }]);
		await (await agent.streamFunction(model, normalizeContext({ messages: converted }))).result();
		expect(publicStream).toHaveBeenCalledTimes(1);
		expect(loopStream).toHaveBeenCalledTimes(2);
		for (const call of loopStream.mock.calls) expect(call[2]).not.toHaveProperty("loopStreamFn");
	});
	it("preserves tool turns and queued follow-ups through the private delegate", async () => {
		const publicStream = vi.fn<StreamFn>(() => {
			throw new Error("public invocation");
		});
		let calls = 0;
		const loopStream = vi.fn<StreamFn>(() => stream(++calls === 1));
		const tool: AgentTool = {
			name: "synthetic",
			label: "synthetic",
			description: "synthetic",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const agent = new Agent({
			initialState: { model, tools: [tool] },
			streamFn: publicStream,
			loopStreamFn: loopStream,
		});
		agent.followUp({ role: "user", content: "queued", timestamp: 1 });
		await agent.prompt("tool");
		expect(loopStream).toHaveBeenCalledTimes(3);
		expect(publicStream).not.toHaveBeenCalled();
		expect(agent.state.errorMessage).toBeUndefined();
	});
	it("retains public stream replacement behavior when the delegate is absent", async () => {
		const original = vi.fn<StreamFn>(() => stream());
		const replacement = vi.fn<StreamFn>(() => stream());
		const agent = new Agent({ initialState: { model }, streamFn: original });
		agent.streamFunction = replacement;
		await agent.prompt("unpinned");
		expect(replacement).toHaveBeenCalledTimes(1);
		expect(original).not.toHaveBeenCalled();
	});
});
