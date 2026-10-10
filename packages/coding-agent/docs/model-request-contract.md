# Exact request identity and custody

## Scope

`requestIdentity: { provider, model, route }` is an explicit opt-in for the builtin
`openai-codex` / `openai-codex-responses` executor at
`https://chatgpt.com/backend-api/codex/responses`. It binds local dispatched request
identity, not provider-reported assistant metadata or server-side serving weights.

The CLI accepts one bounded JSON object through `--request-identity`. It uses an
exact physical catalog lookup: no fuzzy match, synthesized model, settings default,
virtual model, thinking suffix, or fallback selection. Conflicting explicit model,
provider, and model-scope arguments refuse. Use `--thinking` separately. Primitive
pins are copied before asynchronous setup and retained during CLI runtime recreation.

The SDK requires an explicit catalog model together with `requestIdentity`. An
unsupported API/executor or initial route mismatch refuses before inference
authentication resolution. Builtin provider overlays/custom executors are not
qualified for strict mode. Ordinary unpinned selection and request behavior remain
unchanged.

## Final transport boundary

ModelRuntime rechecks identity and executor after authentication/header awaits.
The Codex adapter checks the actual serialized JSON after payload hooks and
`toJSON`, then snapshots it for strict WebSocket transformations. SSE checks include
the decoded final compressed body; WebSocket checks include final cached/delta
frames. Checks precede acquisition, construction, and sending, including retries
and fallback. Identity refusal is not retried or converted into transport fallback.
Allowed non-identity payload transformations and existing thinking mapping remain.

Strict HTTP requests use the captured trusted global fetch implementation, reject
independent fetch overrides, and prohibit redirects. The transport boundary assumes
trusted ordinary same-process code and transport implementations. It is not a
sandbox against malicious extensions, a kernel confinement claim, or proof of
server weights. Post-hook refusal prevents inference effects, but does not undo
earlier separately authorized authentication.

## Host-owned attempt journal

Strict SDK/CLI sessions expose `requestCustody.path`; `readRequestCustody(path)`
reads credential-free JSONL independently of mutable assistant/message events.
The host creates an exclusive owned 0600 file in an owned private directory. It
appends and fsyncs synchronously before inference acquisition/dispatch and verifies
actual bytes through the same descriptor before and after appending. File identity,
size, mode, links and ownership are checked. Any writer/readback failure prevents
subsequent inference effects; uncertain partial output is not repaired.

Records contain schema, session/run/call/attempt correlation, provider, API, model,
canonical route, transport and phase. `serializedModel` is present only after final
serialization was checked. No prompt, payload, body/hash, credentials, account,
response content or raw error is recorded. Phases are `prepared`, `dispatched`,
`completed`, `error`, and `aborted`. `dispatched` means the transport call returned
locally, not that the server accepted it. Preparation without a terminal remains
UNKNOWN; torn tails never imply success. Completion requires a dispatched predecessor;
prepared attempts may instead terminate with error or abort. Invalid or contradictory
histories refuse. A refusal before preparation on a later retry is retained separately
as attempt zero, even when an earlier transport attempt already terminated.

Limits: 4096 records, 4096 UTF-8 bytes per record, 16 MiB, 1024 distinct calls and
64 attempts per call, with reserved terminal capacity. These are checked software
bounds, not provisioned filesystem quotas or all-writer/kernel guarantees.

A run spans foreground requests and continuations until `agent_settled`; subsequent
runs get distinct IDs. Calls cannot migrate between runs. Strict SDK sessions do
not warm caches. Their session-local runtime view refuses compaction, summaries,
deferred/image/classifier and out-of-band calls that lack a private foreground
admission. Admission comes from a private Agent loop-only stream delegate, not the
session's streaming flag or a manually converted context. Public `agent.streamFunction`
requests refuse in strict mode, including concurrent bug-report summaries. An exposed
session runtime can be supplied to another SDK session without inheriting the first
session's admission or journal lifetime. Independently created runtimes or direct
extension-owned requests are not enrolled by a session pin. Low-level adapter use alone does not create the
host-owned journal; use the SDK/CLI for that channel.

`session.dispose()` remains synchronous: it prevents new admission, requests abort,
and keeps the journal open until the admitted agent run becomes idle. This allows the
provider to record its actual cancellation terminal. It does not fabricate a terminal
for a transport that never settles; such an attempt remains UNKNOWN.

## Qualification and adoption

Source checks and offline mocked-transport tests are not installation, release,
consumer acceptance, live authentication, native transport proof or publication.
A source worktree does not update the installed host. Packaging and adoption require
separate owner authorization before a consumer can rely on these capabilities.
