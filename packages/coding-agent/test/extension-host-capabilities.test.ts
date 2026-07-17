import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectTrustContext } from "../src/cli/project-trust.ts";
import { VERSION } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	discoverAndLoadExtensions,
	EXTENSION_HOST_CAPABILITIES,
	type ExtensionHostCapabilities,
	type ExtensionHostCapability,
	ExtensionRunner,
} from "../src/core/extensions/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

const REQUIRED_CAPABILITIES: readonly ExtensionHostCapability[] = [
	"prompt.system.chain.v1",
	"session.lifecycle.reason.v1",
	"ui.mode.v1",
	"ui.confirm.timeout.v1",
	"session.shutdown.v1",
];

function supportsHost(identity: ExtensionHostCapabilities): boolean {
	return (
		identity.extension_api_version === "1.0.0" &&
		REQUIRED_CAPABILITIES.every((capability) => identity.capabilities.includes(capability))
	);
}

describe("extension host capabilities", () => {
	let tempDir: string;
	let oldEnv: string | undefined;

	beforeEach(() => {
		initTheme("dark");
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-host-capabilities-"));
		oldEnv = process.env.PI_EXTENSION_HOST_CAPABILITIES;
	});

	afterEach(() => {
		vi.useRealTimers();
		fs.rmSync(tempDir, { recursive: true, force: true });
		if (oldEnv === undefined) delete process.env.PI_EXTENSION_HOST_CAPABILITIES;
		else process.env.PI_EXTENSION_HOST_CAPABILITIES = oldEnv;
		const globals = globalThis as typeof globalThis & { __piHostSeen?: unknown; __piHostForge?: unknown };
		delete globals.__piHostSeen;
		delete globals.__piHostForge;
	});

	async function createRunner(extensionPaths: string[] = []): Promise<ExtensionRunner> {
		const result = await discoverAndLoadExtensions(extensionPaths, tempDir, tempDir);
		expect(result.errors).toEqual([]);
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage);
		return new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
	}

	it("exposes one runtime-frozen host-owned identity", async () => {
		const runner = await createRunner();
		const firstContext = runner.createContext();
		const first = firstContext.hostCapabilities;
		const second = runner.createContext().hostCapabilities;

		expect(first).toBe(EXTENSION_HOST_CAPABILITIES);
		expect(second).toBe(first);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.capabilities)).toBe(true);
		expect(first.host_package).toBe("@earendil-works/pi-coding-agent");
		expect(first.host_version).toBe(VERSION);
		expect(supportsHost(first)).toBe(true);
		expect(Object.getOwnPropertyDescriptor(firstContext, "hostCapabilities")).toMatchObject({
			configurable: false,
			enumerable: true,
			set: undefined,
		});

		expect(() => {
			(first.capabilities as ExtensionHostCapability[]).push("session.shutdown.v1");
		}).toThrow();
	});

	it("reports exact modes and defaults SDK contexts to print", async () => {
		const runner = await createRunner();
		expect(runner.createContext().mode).toBe("print");
		for (const mode of ["tui", "rpc", "json", "print"] as const) {
			runner.setUIContext(undefined, mode);
			expect(runner.createContext().mode).toBe(mode);
		}
	});

	it("honors confirmation timeout cancellation and no-UI fallback semantics", async () => {
		vi.useFakeTimers();
		const onCancel = vi.fn();
		const selector = new ExtensionSelectorComponent("Confirm", ["Yes", "No"], vi.fn(), onCancel, {
			timeout: 1_500,
			tui: { requestRender: vi.fn() } as unknown as TUI,
		});
		await vi.advanceTimersByTimeAsync(1_499);
		expect(onCancel).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(onCancel).toHaveBeenCalledTimes(1);
		selector.dispose();
		vi.useRealTimers();

		const runner = await createRunner();
		expect(await runner.createContext().ui.confirm("Confirm", "Proceed?", { timeout: 1 })).toBe(false);
	});

	it("propagates the same guarded identity to command and project-trust contexts", async () => {
		const runner = await createRunner();
		const commandContext = runner.createCommandContext();
		const projectTrustContext = createProjectTrustContext({
			cwd: tempDir,
			mode: "print",
			settingsManager: SettingsManager.create(tempDir, tempDir),
			hasUI: false,
		});

		for (const context of [commandContext, projectTrustContext]) {
			expect(context.hostCapabilities).toBe(EXTENSION_HOST_CAPABILITIES);
			expect(Object.getOwnPropertyDescriptor(context, "hostCapabilities")).toMatchObject({
				configurable: false,
				enumerable: true,
				set: undefined,
			});
		}
	});

	it("exposes identity for every supported session_start reason", async () => {
		const extensionPath = path.join(tempDir, "host-canary.ts");
		fs.writeFileSync(
			extensionPath,
			`export default function (pi) {
				pi.on("session_start", (event, ctx) => {
					globalThis.__piHostSeen ??= [];
					globalThis.__piHostSeen.push({ reason: event.reason, identity: ctx.hostCapabilities, mode: ctx.mode });
				});
			}`,
		);
		const reasons = ["startup", "reload", "new", "resume", "fork"] as const;
		for (const reason of reasons) {
			const runner = await createRunner([extensionPath]);
			runner.setUIContext(undefined, "tui");
			await runner.emit({ type: "session_start", reason });
		}
		const seen = (
			globalThis as typeof globalThis & {
				__piHostSeen: Array<{ reason: string; identity: ExtensionHostCapabilities; mode: string }>;
			}
		).__piHostSeen;
		expect(seen.map((item) => item.reason)).toEqual(reasons);
		expect(seen.every((item) => item.identity === EXTENSION_HOST_CAPABILITIES)).toBe(true);
		expect(seen.every((item) => item.mode === "tui")).toBe(true);
	});

	it("rejects identity replacement attempts from loaded extension code", async () => {
		const extensionPath = path.join(tempDir, "host-forge-canary.ts");
		fs.writeFileSync(
			extensionPath,
			`export default function (pi) {
				pi.on("session_start", (_event, ctx) => {
					let assignmentRejected = false;
					let redefineRejected = false;
					try { ctx.hostCapabilities = { host_package: "attacker" }; } catch { assignmentRejected = true; }
					try { Object.defineProperty(ctx, "hostCapabilities", { value: { host_package: "attacker" } }); }
					catch { redefineRejected = true; }
					globalThis.__piHostForge = {
						assignmentRejected,
						redefineRejected,
						identity: ctx.hostCapabilities,
						descriptor: Object.getOwnPropertyDescriptor(ctx, "hostCapabilities"),
					};
				});
			}`,
		);
		const runner = await createRunner([extensionPath]);
		await runner.emit({ type: "session_start", reason: "startup" });

		const result = (
			globalThis as typeof globalThis & {
				__piHostForge: {
					assignmentRejected: boolean;
					redefineRejected: boolean;
					identity: ExtensionHostCapabilities;
					descriptor: PropertyDescriptor;
				};
			}
		).__piHostForge;
		expect(result.assignmentRejected).toBe(true);
		expect(result.redefineRejected).toBe(true);
		expect(result.identity).toBe(EXTENSION_HOST_CAPABILITIES);
		expect(result.descriptor.configurable).toBe(false);
	});

	it("cannot be forged by repository files or environment", async () => {
		process.env.PI_EXTENSION_HOST_CAPABILITIES = JSON.stringify({
			host_package: "attacker",
			host_version: "999.0.0",
			extension_api_version: "999.0.0",
			capabilities: ["attacker"],
		});
		fs.writeFileSync(
			path.join(tempDir, "package.json"),
			JSON.stringify({ hostCapabilities: JSON.parse(process.env.PI_EXTENSION_HOST_CAPABILITIES) }),
		);
		fs.mkdirSync(path.join(tempDir, ".pi"));
		fs.writeFileSync(
			path.join(tempDir, ".pi", "settings.json"),
			JSON.stringify({ hostCapabilities: JSON.parse(process.env.PI_EXTENSION_HOST_CAPABILITIES) }),
		);

		const runner = await createRunner();
		expect(runner.createContext().hostCapabilities).toBe(EXTENSION_HOST_CAPABILITIES);
		expect(runner.createContext().hostCapabilities.host_package).not.toBe("attacker");
	});

	it("fails an unsupported-host canary when API version or tokens are absent", () => {
		const missingToken = {
			...EXTENSION_HOST_CAPABILITIES,
			capabilities: EXTENSION_HOST_CAPABILITIES.capabilities.filter((capability) => capability !== "ui.mode.v1"),
		};
		const wrongApi = { ...EXTENSION_HOST_CAPABILITIES, extension_api_version: "0.9.0" };
		expect(supportsHost(missingToken as ExtensionHostCapabilities)).toBe(false);
		expect(supportsHost(wrongApi as ExtensionHostCapabilities)).toBe(false);
	});
});
