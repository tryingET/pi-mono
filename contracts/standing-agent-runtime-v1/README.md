# Pi strict standing-agent runtime attestation v1

Pi owns actual loading, session/process custody, final provider-input construction, and runtime observation. It does not approve releases or issue permits.

Strict mode is non-default and additive. It requires an accepted release and permit; a fresh in-memory session; zero inherited memory, transcript, or compaction; zero ambient context/prompts/skills/extensions/tools/credentials/modes; exact Vault materialization; hard tool and extension ceilings; exact model identity; and identity-bound system prompt, messages, tool schema, and final provider input. It inventories extension hooks separately from tools. The Pi attestation must carry `pre_effect_complete: false`; ASC owns any later effect-bound completion claim.

The current resource loader and SDK can load global/project resources, default tools, persistent sessions, and extension transformations. Therefore current generic Pi behavior cannot be called sealed. Strict mode must construct or override every input explicitly and attest after all pre-provider transformations. `pre_provider_complete` does not establish `pre_effect_complete`; ASC supplies effect-bound evidence.

Any ambient resource, resumed state, unexpected capability/hook, provider-input mismatch, missing permit/currentness, or unobservable effect fails closed before the next effect boundary. Rollback disables strict mode and retains current behavior under its existing claims.
