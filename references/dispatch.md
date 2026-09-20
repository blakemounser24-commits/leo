# Native agent dispatch

Use this contract whenever orchestrated mode has two or more independent `READY` leaves. Unlazy records native launches; the host creates the agent sessions.

For one wave, every native launch call and every `start` record must finish before the first wait, join, result read, or return record.

## Open and seal a launch wave

Claim every leaf first. Partition more `READY` leaves into later waves when they exceed the host's current concurrency limit. Then open one wave with the exact ids:

```text
node <skill-dir>/scripts/dispatch-check.mjs open --scope <scope> --wave ready-1 --leaf leaf-1.1.1 --leaf leaf-1.1.2
```

For each leaf, call the host's native nonblocking launch tool and record the opaque, nonsecret handle it returns:

```text
node <skill-dir>/scripts/dispatch-check.mjs start --scope <scope> --wave ready-1 --leaf leaf-1.1.1 --handle <host-agent-id-1>
node <skill-dir>/scripts/dispatch-check.mjs start --scope <scope> --wave ready-1 --leaf leaf-1.1.2 --handle <host-agent-id-2>
```

Seal the wave before waiting for any result:

```text
node <skill-dir>/scripts/dispatch-check.mjs seal --scope <scope> --wave ready-1
```

Seal fails until every declared leaf has a distinct start handle. `return` fails before seal. These refusals catch the serial pattern where a driver launches one leaf, waits for it, and only then launches the next.

When a native agent finishes, record the return before parent re-verification:

```text
node <skill-dir>/scripts/dispatch-check.mjs return --scope <scope> --wave ready-1 --leaf leaf-1.1.1
```

A return records scheduler completion, including a failed worker result. It does not mark the leaf `VERIFIED`; the parent still runs the leaf gates and reviews manual evidence.

Check the finished wave with:

```text
node <skill-dir>/scripts/dispatch-check.mjs status --scope <scope> --wave ready-1
```

`status` exits `0` only after every declared leaf returned. Dispatch state and timestamps live in `.unlazy/<scope>/dispatch.json`; lifecycle events also append to the scope status log. The atomic state transition is authoritative: if the later audit-log append is refused, the transition command still succeeds and prints a bounded warning that the state was committed. Inspect state before deciding what to do next; do not blindly repeat the transition.

The state loader requires string ids, handles, and abandonment reasons plus a possible transition history: returns require an all-started sealed wave, terminal timestamps must exist and follow prior transitions, and a fully returned wave must be complete. Hand-editing an impossible terminal state fails closed. The primary `gate-check.mjs --scope <scope>` reduction includes this aggregate state and cannot print `ALL MET` while a wave is open, sealed, abandoned, or invalid.

## Codex adapter

[Current Codex releases support parallel subagents](https://developers.openai.com/codex/agent-configuration/subagents). Use the native subagent tools available in the host. When the tools are named `spawn_agent` and `wait_agent`, follow this exact order:

1. call `spawn_agent` once for each leaf in the open wave
2. record each returned agent id with `dispatch-check start`
3. seal the wave
4. call `wait_agent` only after seal
5. record each completion with `dispatch-check return`, then reverify it

Do not use `codex exec` as a substitute. It creates a separate CLI process rather than a native subagent owned and visible through the current host.

## Claude Code adapter

[Claude Code background subagents run concurrently](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background). Launch every leaf as a background `Agent` task, record every returned task or agent id, and seal before reading any result. Do not issue foreground Agent calls one after another.

For a large regular fan-out, prefer a [Dynamic Workflow](https://code.claude.com/docs/en/workflows). Its `pipeline()` primitive runs agent work across a list under the runtime's concurrency limit. The workflow must still preserve the same semantic barrier: schedule the whole fan-out before collecting its first result. Open a CLI dispatch wave only when the workflow surface exposes a distinct native handle for each agent. Otherwise retain the generated workflow script and runtime progress as branch evidence without claiming a CLI-verified wave.

Do not use `claude -p` as a substitute for an available native background Agent or workflow. A shell process farm loses the current session's native scheduling and observability.

## ACP adapter

Use this adapter when the host has no nonblocking native launch, or when one wave must mix harnesses or models that the host's native subagents cannot reach. Each leaf is one [Agent Client Protocol](https://agentclientprotocol.com/) session opened by an ACP client. The launch barrier is unchanged. The mechanism is:

1. Give every leaf its own Git worktree and pass it as the absolute `cwd` of [`session/new`](https://agentclientprotocol.com/protocol/session-setup). Leases coordinate ownership. The worktree separates files, because an ACP session does not share the driver's working tree.
2. Create each session synchronously and record the [session id](https://agentclientprotocol.com/protocol/session-setup#session-id) it returns as the handle with `dispatch-check start`. It is the opaque, nonsecret host identifier the barrier requires. A session that failed to open returns no id, so the wave stays open until the launch is fixed or the wave is abandoned.
3. Read the model back from the session and record it in `PLAN.md`. Which leaves go to ACP, and to which agent and model, is a project decision recorded there.
4. Send every leaf brief with `session/prompt` as a background process, with its event stream and exit code written to files under `.unlazy/<scope>/`, then seal the wave. A prompt still running is a started leaf.
5. Record `dispatch-check return` when the prompt process exits and the reply carries a [stop reason](https://agentclientprotocol.com/protocol/prompt-turn#stop-reasons). Classify the return before its gates run: `end_turn` with at least one `tool_call` update is a worked leaf, `end_turn` with none is an **empty leaf**, and any other stop reason, a timeout, or a truncated stream is a failed one.
6. Re-verify every returned leaf from the parent with its own shell and toolchain. Then close each session you created and remove each worktree once its commits are integrated.

An empty leaf is the ACP-specific failure. `end_turn` means the model stopped requesting tools, so an agent whose model is unreachable or refused by the provider returns it with exit `0` and no error in the stream. The stream holds no cause: query the harness outside ACP with the same model, fix the launch, and retry in a new wave. The same session id is a valid handle for the retry wave. Stop a leaf that outlives its timeout with [`session/cancel`](https://agentclientprotocol.com/protocol/prompt-turn#cancellation), then record its return as failed.

Keep the path boundary structural: one worktree per leaf, plus one gate in every leaf ledger, re-verified by the parent, asserting that the files changed since the branch base are a non-empty subset of the leaf's `Owns`. Client permission flags sit under that boundary as a net, because a permission request is decided per tool call and only when the agent sends one. Resolve a denial by fixing the policy or the brief.

## Failure and fallback

If a native launch fails before returning a handle, leave the wave open, fix the launch problem, and retry that leaf. Do not seal a partial wave. If recovery is impossible, preserve the audit trail instead of inventing a handle or deleting state:

```text
node <skill-dir>/scripts/dispatch-check.mjs abandon --scope <scope> --wave ready-1 --reason "<bounded nonblank reason>"
```

An abandoned wave is terminal and `status` exits `1`. The Stop hook does not block on it, but emits a bounded `HANDOFF REQUIRED` message naming the wave without copying its free-form reason into the privileged host message. Surface the reason from dispatch state in the final handoff. If the host has neither a nonblocking native launch nor an ACP client, record the limitation in `PLAN.md`, execute a declared sequential fallback, and do not open or describe a parallel wave.

Opening a wave is an execution claim. Do not invent handles, record a foreground result as a start, or call simultaneous work proved merely because commands ran quickly.

## Evidence boundary

The launch barrier proves that the host accepted every native start before the driver accepted a return. It does not prove worker honesty, exact CPU overlap, filesystem isolation, or successful integration. Leases, parent re-verification, and branch gates remain separate requirements.
