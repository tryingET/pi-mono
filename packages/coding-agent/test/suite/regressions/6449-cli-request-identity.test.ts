import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { createAgentSessionFromServices } from "../../../src/core/agent-session-services.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { buildSessionOptions } from "../../../src/main.ts";
import { createHarness } from "../harness.ts";

// AK6449 owner regression, not an upstream GitHub issue.
const pin = {
	provider: "openai-codex",
	model: "gpt-6.1-sol",
	route: "https://chatgpt.com/backend-api/codex/responses",
};

describe("exact CLI identity bridge", () => {
	it("selects the exact catalog entry and forwards copied pins through typed services on recreation", async () => {
		const h = await createHarness();
		try {
			const parsed = parseArgs(["--request-identity", JSON.stringify(pin)]);
			const runtime = h.session.modelRuntime;
			const auth = vi.spyOn(runtime, "getAuth");
			for (let n = 0; n < 2; n++) {
				const selected = buildSessionOptions(parsed, [], false, runtime, h.settingsManager);
				expect(selected.options.model?.id).toBe(pin.model);
				expect(selected.options.requestIdentity).toEqual(pin);
				expect(Object.isFrozen(selected.options.requestIdentity)).toBe(true);
				const agentDir = join(h.tempDir, "agent");
				const loader = new DefaultResourceLoader({ cwd: h.tempDir, agentDir, settingsManager: h.settingsManager });
				await loader.reload();
				const created = await createAgentSessionFromServices({
					services: {
						cwd: h.tempDir,
						agentDir,
						modelRuntime: runtime,
						settingsManager: h.settingsManager,
						resourceLoader: loader,
						diagnostics: [],
					},
					sessionManager: SessionManager.inMemory(h.tempDir),
					model: selected.options.model,
					requestIdentity: selected.options.requestIdentity,
					noTools: "all",
				});
				try {
					expect(created.requestCustody?.pin).toEqual(pin);
				} finally {
					created.session.dispose();
				}
			}
			expect(auth).not.toHaveBeenCalled();
		} finally {
			h.cleanup();
		}
	});

	it.each(["typo", "fuzzy", "provider", "scope"] as const)(
		"refuses %s without default or synthesized fallback",
		async (kind) => {
			const h = await createHarness();
			try {
				const runtime = h.session.modelRuntime;
				const auth = vi.spyOn(runtime, "getAuth");
				const wrongPin = kind === "typo" ? { ...pin, model: "gpt-6.1-sol-typo" } : pin;
				const args = ["--request-identity", JSON.stringify(wrongPin)];
				if (kind === "fuzzy") args.push("--model", "6.1");
				if (kind === "provider") args.push("--provider", "anthropic");
				if (kind === "scope") args.push("--models", "openai-codex/*");
				expect(() => buildSessionOptions(parseArgs(args), [], false, runtime, h.settingsManager)).toThrow(
					"Request identity",
				);
				expect(auth).not.toHaveBeenCalled();
			} finally {
				h.cleanup();
			}
		},
	);
});
