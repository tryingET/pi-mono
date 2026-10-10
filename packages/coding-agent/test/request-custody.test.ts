import { appendFileSync, chmodSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestAttempt } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { RequestCustody, readRequestCustody } from "../src/core/request-custody.ts";

const pin = {
	provider: "openai-codex",
	model: "gpt-6.1-sol",
	route: "https://chatgpt.com/backend-api/codex/responses",
};
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "custody-"));
	const path = join(dir, "attempts.jsonl");
	const custody = new RequestCustody(path, "session-test", pin);
	custody.beginRun();
	return { dir, path, custody };
}
function attempt(phase: RequestAttempt["phase"], callId = "call-test", number = 1): RequestAttempt {
	return {
		...pin,
		api: "openai-codex-responses",
		callId,
		attempt: number,
		transport: "sse",
		phase,
		...(number === 0 ? {} : { serializedModel: pin.model }),
	};
}

describe("credential-free request custody", () => {
	it("durably appends and reads actual correlated records", () => {
		const f = fixture();
		try {
			for (const phase of ["prepared", "dispatched", "completed"] as const) f.custody.record(attempt(phase));
			const result = readRequestCustody(f.path);
			expect(result.records.map((r) => r.phase)).toEqual(["prepared", "dispatched", "completed"]);
			expect(new Set(result.records.map((r) => r.runId)).size).toBe(1);
			expect(result.records.every((r) => r.sessionId === "session-test")).toBe(true);
			expect(result.unknown).toEqual([]);
			expect(result.tornTail).toBe(false);
		} finally {
			f.custody.close();
		}
	});

	it("never invents success for prepared attempts or torn terminals", () => {
		const f = fixture();
		f.custody.record(attempt("prepared"));
		f.custody.close();
		appendFileSync(f.path, '{"phase":"completed"');
		expect(readRequestCustody(f.path)).toMatchObject({ unknown: ["call-test/1"], tornTail: true });
	});

	it.each(["error", "aborted"] as const)("retains first %s with no message/body/credential fields", (phase) => {
		const f = fixture();
		try {
			f.custody.record({ ...attempt(phase, "first", 0), privateError: "DO_NOT_PERSIST" } as RequestAttempt);
			expect(readFileSync(f.path, "utf8")).not.toContain("DO_NOT_PERSIST");
			expect(readRequestCustody(f.path).records[0].phase).toBe(phase);
		} finally {
			f.custody.close();
		}
	});

	it.each(["size", "same-size", "mode", "replacement", "symlink"] as const)(
		"refuses %s drift without overwrite/repair",
		(kind) => {
			const f = fixture();
			try {
				f.custody.record(attempt("prepared"));
				f.custody.record(attempt("dispatched"));
				if (kind === "size") appendFileSync(f.path, "partial");
				if (kind === "same-size")
					writeFileSync(f.path, readFileSync(f.path, "utf8").replace("call-test", "call-evil"));
				if (kind === "mode") chmodSync(f.path, 0o644);
				if (kind === "replacement" || kind === "symlink") {
					renameSync(f.path, `${f.path}.retained`);
					if (kind === "replacement") writeFileSync(f.path, "replacement", { mode: 0o600 });
					else symlinkSync(`${f.path}.retained`, f.path);
				}
				expect(() => f.custody.record(attempt("completed"))).toThrow("custody append or readback failed");
				expect(() => f.custody.record(attempt("completed"))).toThrow("custody unavailable");
			} finally {
				f.custody.close();
			}
		},
	);

	it("caps distinct calls without refilling on new runs", () => {
		const f = fixture();
		try {
			for (let n = 0; n < 1024; n++) f.custody.record(attempt("error", `call-${n}`, 0));
			f.custody.endRun();
			f.custody.beginRun();
			expect(() => f.custody.record(attempt("error", "overflow", 0))).toThrow("custody capacity");
			expect(readRequestCustody(f.path).records).toHaveLength(1024);
		} finally {
			f.custody.close();
		}
	});

	it("reserves terminal record slots before admitting more prepared attempts", () => {
		const f = fixture();
		try {
			for (let n = 1; n <= 64; n++) {
				for (let c = 0; c < 32; c++) f.custody.record(attempt("prepared", `call-${c}`, n));
			}
			expect(() => f.custody.record(attempt("prepared", "overflow", 1))).toThrow("custody capacity");
			for (let n = 1; n <= 64; n++) {
				for (let c = 0; c < 32; c++) f.custody.record(attempt("error", `call-${c}`, n));
			}
			expect(readRequestCustody(f.path).records).toHaveLength(4096);
			expect(readRequestCustody(f.path).unknown).toEqual([]);
		} finally {
			f.custody.close();
		}
	});

	it("refuses without a live run and after close", () => {
		// This case is followed by the separate cross-run check below.
		const f = fixture();
		f.custody.endRun();
		expect(() => f.custody.record(attempt("prepared"))).toThrow("custody unavailable");
		f.custody.close();
		expect(() => f.custody.record(attempt("prepared"))).toThrow("custody unavailable");
	});

	it("refuses a late terminal after changing runs and retains UNKNOWN", () => {
		const f = fixture();
		try {
			f.custody.record(attempt("prepared"));
			f.custody.endRun();
			f.custody.beginRun();
			expect(() => f.custody.record(attempt("completed"))).toThrow("custody run changed");
			expect(readRequestCustody(f.path).unknown).toEqual(["call-test/1"]);
		} finally {
			f.custody.close();
		}
	});

	it("P2: rejects completion without a dispatch observation in writer and readback", () => {
		const f = fixture();
		try {
			f.custody.record(attempt("prepared"));
			expect(() => f.custody.record(attempt("completed"))).toThrow("custody transition changed");
		} finally {
			f.custody.close();
		}
		const other = fixture();
		other.custody.record(attempt("prepared"));
		other.custody.close();
		const prepared = readRequestCustody(other.path).records[0];
		appendFileSync(other.path, `${JSON.stringify({ ...prepared, phase: "completed" })}\n`);
		expect(() => readRequestCustody(other.path)).toThrow("custody transition changed");
	});

	it("rejects dispatched-only and contradictory terminal histories", () => {
		const f = fixture();
		try {
			expect(() => f.custody.record(attempt("dispatched"))).toThrow("custody missing preparation");
			f.custody.record(attempt("prepared"));
			f.custody.record(attempt("error"));
			expect(() => f.custody.record(attempt("completed"))).toThrow("custody transition changed");
		} finally {
			f.custody.close();
		}
	});
});
