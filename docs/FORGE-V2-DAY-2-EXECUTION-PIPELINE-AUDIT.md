# FORGE V2 — Day 2 Execution Pipeline Audit

**Date:** 2026-11-20  
**Source inspected:** V1 `main` at `7de27108a2290dba8625b2b5c1e61c935dc5a49c`  
**Working branch:** `forge-v2`  
**Scope:** Read-only source and test inventory inspection. No application code or V1 deployment changes.

## 1. Executive summary

FORGE V1 already contains a meaningful engineering harness: a fixed review-plan generator, dependency-aware orchestration, provider/model routing, workspace context retrieval, local run persistence, approval and recovery flows, execution traces, and a local dashboard.

The main V2 opportunity is not simply adding more agents. It is making the existing capabilities consistent and composable across the CLI, provider adapters, orchestration runtime, dashboard and evaluation paths.

## 2. Standard CLI execution path

The `forge run --goal ...` path in `src/cli.ts` currently does the following:

1. Resolve project path and load the permission policy.
2. Select configured provider and model defaults.
3. Validate whether the provider is compatible with the configured permission mode.
4. Create a provider factory for Claude Code or the hosted OpenAI / Anthropic / Google / Ollama adapters.
5. Construct `ModelRouter` with fast, balanced and reasoning model tiers, optional fallback, retry settings, token ceilings and duration ceilings.
6. Generate the standard review plan using `createReviewPlan(goal)`.
7. Load the skill registry and select skills against the overall goal.
8. Load lifecycle hooks and apply them to each planned task; matching hooks can require approval, append guidance or block a task.
9. Build project memory context for the goal.
10. Call `advanceRun` with max concurrency 4 and per-task workspace code-search context.
11. Save the completed run and execution trace, then print task statuses and estimated usage.

The default review plan is a fixed 10-task sequence: understand, plan, review, security, performance, debugging, tests, docs, delivery and release. It uses dependencies so specialist reviews follow planning and the release summary follows the specialist checks.

## 3. Agent and context consistency finding

The standard `forge run` path visibly loads skills but does not load the agent registry or inject the registered agent instructions into each task's context. The registry is loaded in other paths, including dashboard listing and experiment evaluation.

The experiment/benchmark path does load the agent registry, selects skills per task and adds the matching agent instructions. This means the normal CLI run and the experiment path do not currently assemble agent context in the same way.

**V2 opportunity:** create one shared, tested task-context assembly service used by CLI runs, resumes, evaluations and future dashboard workflows. It should resolve agent definition, selected skills, project memory, workspace evidence, policy/hook guidance and provenance consistently.

The standard CLI run also selects skills once for the overall goal, while the experiment path supports per-task skill selection. V2 should make task-level skill selection a shared runtime behavior with an explainable selection record.

## 4. Orchestration and reliability

Observed in `src/core/orchestrator.ts`:

- Validates non-empty tasks, unique task IDs, dependency references and dependency cycles.
- Supports pending, awaiting-approval, running, completed, failed and blocked task states.
- Executes dependency-ready tasks in bounded batches; default concurrency is 4 and accepted range is 1–16.
- Prevents sibling tasks in the same parallel batch from observing partially committed sibling results.
- Supports cancellation checks, update callbacks and per-task settlement persistence callbacks.
- Blocks downstream tasks when dependencies fail or are blocked.
- Stops launching new tasks after configured budget exhaustion.

Observed recovery behavior:

- Resume takes an exclusive execution lock.
- If a run was left in running state, FORGE marks in-flight tasks failed with an unknown provider outcome.
- It explicitly does not replay provider requests automatically, because the remote provider may have completed and billed a request before the local process stopped.
- The operator must inspect and explicitly retry/replay work.

This conservative recovery behavior is a strength to preserve. V2 should add clearer attempt identity, idempotency strategy where supported, explicit retry decisions and more granular task checkpoints without silently replaying uncertain paid work.

## 5. Model routing and provider path

### ModelRouter

- Routes tasks to fast, balanced or reasoning tiers using agent ID and task text heuristics.
- Validates provider responses.
- Tracks estimated input/output tokens, provider, model, duration, retries and outcome.
- Supports configurable 429 retries, fallback model, per-task and cumulative token budgets, per-agent token ceilings and duration ceilings.
- Avoids automatically retrying timeouts, connection loss and general server errors because the provider may already have accepted/billed the request.
- Uses a serialized completion queue when cumulative token ceilings are enabled, so the budget can be accounted for before the next request. This means a configured cumulative budget can reduce the concurrency otherwise offered by the orchestrator.

### Provider capability asymmetry

- OpenAI-compatible provider supports explicitly policy-gated, read-only workspace tools: list files, read file and search code.
- Hosted Anthropic, Google and Ollama adapters currently return proposal text without the same workspace tool loop.
- Claude Code is a separate provider adapter.
- Permission policy validation currently limits restricted read-only tool mode to the supported OpenAI path and allowlisted tools.

**V2 opportunity:** publish a tested provider capability contract, make context/tool support explicit per adapter, unify error/usage/timeout semantics, and ensure routing never implies a capability an adapter does not have.

## 6. Dashboard and backend boundary

The local dashboard server:

- Binds to loopback address `127.0.0.1`.
- Applies security headers, a restrictive content security policy, Host-header checks and same-origin checks for relevant POST routes.
- Exposes read APIs for project overview, agents, runs, traces, providers, evaluations, benchmarks, health, quality, verification, reviews, dependency intelligence, architecture and workspace inspection.
- Supports local operator actions such as task approval, run cancellation, task retry/replay, workflow definition saving and creation of a saved run draft.
- The workflow run endpoint creates and persists a run record; it does not itself call the provider-backed `advanceRun` execution path.
- The dashboard is explicitly described in the UI as read-only, with operator actions exposed through limited API endpoints.

The dashboard page, inline CSS and inline JavaScript are embedded in `src/core/dashboard-server.ts`, a roughly 155 KB / 942-line module. The CLI entry point `src/cli.ts` is roughly 108 KB / 1,597 lines.

**V2 opportunity:** separate dashboard presentation, HTTP routing, application services and runtime orchestration behind stable interfaces. Do this incrementally and keep the V1 dashboard and public website unchanged until V2 preview testing and release approval.

## 7. Existing tests and CI

The repository tree contains 70 `*.test.ts` files, including dedicated tests for:
- agent registry and workspace context
- orchestrator and model router
- hosted providers and OpenAI-compatible tools
- run store, replay and execution trace
- memory, skills, hooks and permission policy
- workflow store and dashboard server
- sandbox unit and Docker integration
- evaluations, benchmarks and regression intelligence

The CI workflow on V1 currently runs typecheck, the test suite, build, package/CLI smoke checks and a real Docker sandbox integration job.

**CI gap:** `.github/workflows/ci.yml` currently triggers on pushes to `main` and pull requests targeting `main`. It does not trigger on ordinary pushes to `forge-v2`. V2 changes therefore need an explicit CI trigger or a V2-targeted workflow before implementation begins.

Latest observed workflow metadata at audit time:
- Main CI run created 2026-11-17: completed successfully.
- This is historical GitHub CI evidence, not a fresh local Day 2 run.

No local install, typecheck, test, build or Docker test was executed during this source-only audit.

## 8. V2 architecture decisions recommended

1. **One task-context pipeline:** agent definition + skill selection + memory + repository evidence + hook/policy context, with provenance.
2. **One execution service:** CLI, resume, evaluations and dashboard draft/run controls should use the same application service rather than assembling the runtime independently.
3. **Explicit agent contracts:** capabilities, inputs/outputs, tool requirements, permissions, model preferences, budgets and versioning.
4. **Provider capability registry:** distinguish text-only, read-only workspace tools, structured output and other tested capabilities.
5. **Durable execution model:** run/task/attempt identity, append-only events, checkpointing, safe recovery and explicit retry semantics.
6. **Workflow runtime:** distinguish workflow definitions, run drafts and actual executions; expose clear lifecycle states.
7. **Dashboard modularization:** keep the V1 UI frozen while V2 uses separated API/application/presentation layers.
8. **CI first:** make `forge-v2` receive the same quality gates before substantive code changes.
9. **Regression baseline:** preserve existing test suite and add end-to-end contract tests around the shared execution path.

## 9. Day 2 outcome and remaining work

Completed:
- Traced the standard CLI run and resume paths.
- Traced orchestrator dependency scheduling and task settlement.
- Reviewed model routing, token budgets, retry and fallback behavior.
- Reviewed provider capability differences.
- Mapped dashboard API actions and execution boundary.
- Enumerated the existing test suite and reviewed CI triggers.

Still required for Day 3 / end of Week 1:
- Inspect dashboard test coverage and identify safe module extraction boundaries.
- Review the complete permission and workspace-tool threat model.
- Verify Vercel production branch settings before any preview or deployment changes.
- Produce the consolidated V1 capability matrix and V2 architecture decision record.
- Establish a V2 CI gate before any application implementation.

No V1 source files, dashboard assets, production settings or deployment configuration were changed.
