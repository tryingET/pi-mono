import { fauxAssistantMessage, streamSimple } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { createHarness } from "../harness.ts";

// AK6449: ordinary faux providers do not invoke the payload hook, so instrument it explicitly.
// Production serialization/transport and SDK journal tests are paired in the other targeted files.
describe("strict host executor boundary", () => {
	it("preserves an unpinned faux run with explicitly instrumented payload hooks", async () => {
		let hookCalls = 0;
		const h = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_provider_request", () => {
						hookCalls++;
					});
				},
			],
		});
		try {
			const original = h.session.agent.streamFunction;
			h.session.agent.streamFunction = async (model, context, options) => {
				await options?.onPayload?.({ model: model.id }, model);
				return original(model, context, options);
			};
			h.setResponses([fauxAssistantMessage("synthetic reply")]);
			await h.session.prompt("synthetic prompt");
			expect(hookCalls).toBe(1);
			expect(h.getPendingResponseCount()).toBe(0);
		} finally {
			h.cleanup();
		}
	});

	it("rejects a same-ID custom Codex executor before authentication or fake transport", async () => {
		const h = await createHarness();
		try {
			const runtime = h.session.modelRuntime;
			const model = runtime.getModel("openai-codex", "gpt-6.1-sol")!;
			let executions = 0;
			runtime.registerProvider("openai-codex", {
				api: "openai-codex-responses",
				streamSimple: (_model, context, options) => {
					executions++;
					return streamSimple(h.getModel(), context, { ...options, apiKey: "faux-key" });
				},
			});
			const auth = vi.spyOn(runtime, "getAuth");
			await expect(
				createAgentSession({
					model,
					modelRuntime: runtime,
					requestIdentity: {
						provider: "openai-codex",
						model: "gpt-6.1-sol",
						route: "https://chatgpt.com/backend-api/codex/responses",
					},
				}),
			).rejects.toThrow("unsupported executor");
			expect(auth).not.toHaveBeenCalled();
			expect(executions).toBe(0);
		} finally {
			h.cleanup();
		}
	});
});
