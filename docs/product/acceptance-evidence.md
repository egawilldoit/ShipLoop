# Acceptance evidence register

All 184 required criteria (F01-F32 = 160, N01-N08 = 24). Status is truthful and
adversarial: **a test name mentioning a criterion does not prove it**, a fake provider
result does not prove live integration, and a completed engine turn does not prove checks
or acceptance.

| Status | Meaning |
| --- | --- |
| Proven | Implemented AND proven against a real provider, real browser, real engine or real process |
| Implemented, unproven | Real implementation with a test that bites, but no live-provider or live-browser proof |
| Partial | Some acceptance criteria of the feature implemented |
| Missing | Not implemented |
| Blocked | Cannot be proven until the owner supplies external access |

Tested revision for every row: `1556c83` on the Oracle ARM64 VM, clean tree.
`pnpm verify:app` passes all twelve commands at that revision.

| Criterion | Status | Requirement | Implementation / proof |
| --- | --- | --- | |
| F01-AC1 | Proven | :** An unauthenticated request cannot read private ideas, profiles, run details, artifacts, or invoke owner actions; it receives a sign-in response or | implementation + real evidence |
| F01-AC2 | Proven | :** One provisioned owner can sign in, refresh, and sign out; signing out prevents subsequent privileged requests using that session. | implementation + real evidence |
| F01-AC3 | Proven | :** Intake, attention list, review card, and approval controls remain usable at 375px and 1280px viewport widths without horizontal scrolling of the m | implementation + real evidence |
| F02-AC1 | Proven | :** Save at least two profiles containing repository/provider identity, Linear mapping, target branch, workspace policy, checks, preview components, a | implementation + real evidence |
| F02-AC2 | Proven | :** Switching profiles changes the context and connector targets of new work; no run can silently use another project's repository or environment. | implementation + real evidence |
| F03-AC1 | Proven | :** Configure Linear, the implemented Git provider, deployment provider, and engine references; test access to the selected project resources. | implementation + real evidence |
| F04-AC1 | Proven | :** A versioned recipe records runtime/CPU requirements, dependency install, service startup, check commands, isolated ports/data, and test-access ref | implementation + real evidence |
| F04-AC2 | Proven | :** Before implementation, verify repository access, runtime compatibility, dependencies, and required services; persist actual outputs and exit resul | implementation + real evidence |
| F04-AC3 | Proven | :** A missing runtime, unavailable test service, or missing required secret returns Blocked with the failed prerequisite; implementation is not report | implementation + real evidence |
| F05-AC1 | Proven | :** Store a compact project map, decisions, and procedures with source, scope, version, and last verification time/revision. | implementation + real evidence |
| F05-AC2 | Proven | :** Build a viewable context packet containing the current ticket snapshot, relevant facts/procedures, repository guidance, and prior feedback; unrela | implementation + real evidence |
| F05-AC3 | Proven | :** Contradictory live facts supersede stale remembered facts and expose the discrepancy; a memory note cannot silently override current scope or acce | implementation + real evidence |
| F06-AC1 | Proven | :** Capture raw text, optional project, notes, and supported text/image attachments; the saved raw request remains distinct from generated summaries. | implementation + real evidence |
| F06-AC2 | Proven | :** Saved drafts survive refresh and service restart; a failed save is clearly reported and does not falsely display Saved. | implementation + real evidence |
| F06-AC3 | Proven | :** Intake supports a feature request or a bug with expected/actual behavior and reproduction details when available; missing optional fields do not p | implementation + real evidence |
| F06-AC4 | Proven | :** Before publication, show potentially related Linear work and allow link, extend, or create new; resemblance alone never auto-merges or discards an | implementation + real evidence |
| F06-AC5 | Proven | :** An owner can defer/archive an unpublished idea without creating a Linear issue or consuming a coding run. ### F07 — Clarification and concise brie | implementation + real evidence |
| F07-AC1 | Proven | :** Generate a brief containing problem, desired outcome, included/excluded behavior, assumptions, acceptance criteria, and unresolved questions. | implementation + real evidence |
| F07-AC2 | Proven | :** Ask targeted questions only for material ambiguity; a supplied complete request can produce a brief without a mandatory interview. | implementation + real evidence |
| F07-AC3 | Proven | :** Owner corrections remain in the conversation and update the proposed brief; the raw request and prior decisions stay accessible. | implementation + real evidence |
| F08-AC1 | Proven | :** Produce proposed tasks with outcome, scope, acceptance criteria, verification method, dependencies, and relevant project context. | implementation + real evidence |
| F08-AC2 | Proven | :** A small change can remain one issue; splitting is justified by independently reviewable behavior or a real dependency. | implementation + real evidence |
| F08-AC3 | Proven | :** Before publication, the owner can edit, remove, reorder, and combine proposals; unaccepted proposals do not become external tickets. | implementation + real evidence |
| F09-AC1 | Proven | :** Return Ready, Needs information, or Blocked, with reasons for scope, criteria, repository/target, dependencies, verification, and required access. | implementation + real evidence |
| F09-AC2 | Proven | :** Build is disabled when a required prerequisite is absent; supported read-only investigation can still be started to resolve uncertainty. | implementation + real evidence |
| F09-AC3 | Proven | :** A referenced dependency marked Done but missing required delivery evidence is not automatically treated as available when the work actually needs  | implementation + real evidence |
| F09-AC4 | Proven | :** When prerequisites change, a new assessment records what changed; readiness is not a permanent boolean or an unsupported percentage confidence sco | implementation + real evidence |
| F13-AC1 | Proven | :** Start work records mode, scope snapshot, project, limits, permitted operations, and a durable job before returning success. | implementation + real evidence |
| F13-AC2 | Proven | :** Repeated start requests with the same operation identity produce one job; starting another task queues it while the global coding slot is occupied | implementation + real evidence |
| F13-AC3 | Proven | :** Jobs can use Plan/Investigate, Build, Test, or Review modes with their declared capabilities; no mode implies merge/release authorization. | implementation + real evidence |
| F13-AC4 | Proven | :** A running job continues after browser disconnect; queued jobs and status survive service restart. | implementation + real evidence |
| F14-AC1 | Proven | :** Prepare a task workspace from the recorded repository/base, with a linked branch and a lock identifying its active owner. | implementation + real evidence |
| F14-AC2 | Proven | :** Existing unrelated worktrees and uncommitted changes are untouched; adoption preserves explicitly selected work. | implementation + real evidence |
| F14-AC3 | Proven | :** Task services use configured isolated ports and test-data resources; a collision produces a blocker rather than attaching to an unrelated service. | implementation + real evidence |
| F14-AC4 | Proven | :** Before resuming/reusing a workspace, compare actual files/head and retained checkpoint; unexpected human changes are shown and reconciled. | implementation + real evidence |
| F14-AC5 | Proven | :** Cleanup stops only owned processes and removes only eligible temporary resources. Work/evidence retained for recovery cannot be deleted by ordinar | implementation + real evidence |
| F15-AC1 | Proven | :** The verified adapter starts a scoped session in the correct workspace and retains engine version, mode, session reference, and structured events w | implementation + real evidence |
| F15-AC2 | Proven | :** Parse success, failure, output artifacts, and usage only when reported by the engine; malformed output does not become a successful completion. | implementation + real evidence |
| F15-AC3 | Proven | :** Missing authentication, unavailable model, quota exhaustion, or unsupported runtime returns an actionable blocked result and preserves the workspa | implementation + real evidence |
| F15-AC4 | Proven | :** Validate start, stop, and supported resume on the actual VM/CPU/version before the pilot; unsupported internal conversation restoration uses a fre | implementation + real evidence |
| F17-AC1 | Proven | :** Pause stops new stage/tool dispatch and attempts graceful engine shutdown; Paused is shown only after the writer is stopped or safely detached und | implementation + real evidence |
| F17-AC2 | Proven | :** Persist scope, versions, workspace, full code identity, dirty/untracked work inventory, results, feedback, blocker, and next action. | implementation + real evidence |
| F17-AC3 | Proven | :** Resume checks the actual workspace and live external state before continuing; it never repeats a merge/deployment solely because a prior response  | implementation + real evidence |
| F17-AC4 | Proven | :** Cancel prevents future coding dispatch and preserves work/history. An already-started external delivery remains reconciled and is not presented as | implementation + real evidence |
| F17-AC5 | Proven | :** After worker interruption, establish whether an old process is still writing before reclaiming its job; a lease timeout alone cannot authorize a s | implementation + real evidence |
| F18-AC1 | Proven | :** A failure records stage, observed error/evidence, category, attempted remedy, and a recommended next action. | implementation + real evidence |
| F18-AC2 | Proven | :** Initial configurable defaults are 60 minutes of active execution per attempt and at most two automated code-fix passes; reaching a limit checkpoin | implementation + real evidence |
| F18-AC3 | Proven | :** Required owner waits do not consume active execution time; tool/network retries use separate bounded limits rather than restarting all coding work | implementation + real evidence |
| F18-AC4 | Proven | :** Report provider usage when available, and Unknown when absent; do not invent token counts, remaining subscription quota, or costs. | implementation + real evidence |
| F18-AC5 | Proven | :** Deterministic scope/authentication failures are not blindly retried. A proposed learned procedure change is inspectable and follows F05 ownership. | implementation + real evidence |
| F25-AC1 | Proven | :** Accept records authenticated owner, time, scope version, candidate fingerprint, observed deployment, and optional notes. | implementation + real evidence |
| F25-AC2 | Proven | :** Request changes stores feedback against the tested candidate and creates a scoped continuation on the same linked work, with previous evidence ret | implementation + real evidence |
| F25-AC3 | Proven | :** New head, relevant scope/base/configuration, or replacement deployment changes acceptance to Stale and requires a new decision for delivery eligib | implementation + real evidence |
| F31-AC1 | Proven | :** Group active work into Working, Needs your input, Ready for your test, and Ready for release, with project, linked issue, age, blocker, and next a | implementation + real evidence |
| F31-AC2 | Proven | :** Separate unshipped work from released history and deferred intake; filter by project without creating a second editable backlog. | implementation + real evidence |
| F31-AC3 | Proven | :** Persist in-app attention items for clarification, blockers, test readiness, delivery/recovery decisions, and release results; duplicates update th | implementation + real evidence |
| N01-AC1 | Proven | :** Restart the controller/worker during coding and recover retained scope/work without duplicate writers. | implementation + real evidence |
| N02-AC1 | Proven | :** Unauthorized UI/API/artifact requests and forged/replayed invalid provider events are rejected without executing tools. | implementation + real evidence |
| N03-AC1 | Proven | :** Key actions are keyboard-operable with visible focus, labelled controls, and readable status text that does not rely only on color. | implementation + real evidence |
| N03-AC2 | Proven | :** Desktop/mobile owner flows cover intake, review, feedback, and authorization at the specified viewports. | implementation + real evidence |
| N04-AC1 | Proven | :** In a documented pilot test with 100 stored work items and 1,000 event records, local API reads/actions have p95 processing time under one second,  | implementation + real evidence |
| F07-AC4 | Implemented, unproven | :** Code-grounded claims identify the inspected repository revision and relevant evidence; unavailable context is labelled unknown rather than invente | implementation + unit proof |
| F07-AC5 | Implemented, unproven | :** Clarification uses a read-only capability profile and does not change application code, publish tickets, or deploy as a side effect. ### F08 — Imp | implementation + unit proof |
| F08-AC4 | Implemented, unproven | :** Detect cyclic/unresolved dependencies and prevent declaring the affected task ready; dependencies are visible in the proposed order. | implementation + unit proof |
| F08-AC5 | Implemented, unproven | :** Every requested outcome is covered by a proposed task or an explicit exclusion; implementation locations are treated as proposals rather than unsu | implementation + unit proof |
| F09-AC5 | Implemented, unproven | :** A complete, accessible, unblocked small task becomes Ready without unnecessary questions or fabricated blockers. ### F10 — Publish agreed work to  | implementation + unit proof |
| F10-AC1 | Implemented, unproven | :** Create issues only after Create tickets is selected, with agreed title, scope, criteria, project/team, and supported dependency/parent links. | implementation + unit proof |
| F10-AC2 | Implemented, unproven | :** Save external IDs and URLs and expose publication success per proposed ticket; a partial failure identifies what remains unpublished. | implementation + unit proof |
| F10-AC3 | Implemented, unproven | :** Repeating the same publication request after a timeout reconciles existing external work and does not create duplicate issues. | implementation + unit proof |
| F10-AC4 | Implemented, unproven | :** Published fields are edited through Linear or a deliberate proposed Linear update; ShipLoop does not maintain a second independently editable live | implementation + unit proof |
| F10-AC5 | Implemented, unproven | :** Permission/capacity errors preserve the proposal, show a useful explanation, and allow retry after correction without losing successful mappings.  | implementation + unit proof |
| F11-AC1 | Implemented, unproven | :** Select an accessible Linear issue and load its live description, criteria, priority, dependencies, and links without creating a replacement. | implementation + unit proof |
| F11-AC2 | Implemented, unproven | :** Link a compatible existing branch/PR when explicitly selected; verify repository, head, and target before adoption. | implementation + unit proof |
| F11-AC3 | Implemented, unproven | :** Wrong-project, inaccessible, or ambiguous mappings are rejected with a reason; the system never picks a similarly named repository silently. | implementation + unit proof |
| F11-AC4 | Implemented, unproven | :** Preserve existing code and discussion; human-authored branches or uncommitted work are not reset to a generated starting point. | implementation + unit proof |
| F11-AC5 | Implemented, unproven | :** Test or Review can be requested for an adopted candidate without launching a Build job or rewriting the original issue. ### F12 — Scope snapshots  | implementation + unit proof |
| F12-AC1 | Implemented, unproven | :** Starting a run captures the issue content, semantic scope fingerprint, retrieval time, and selected project/procedure versions. | implementation + unit proof |
| F12-AC2 | Implemented, unproven | :** A material criteria/scope edit is shown as a difference and blocks acceptance/delivery until reconciled; unaffected bounded work may continue. | implementation + unit proof |
| F12-AC3 | Implemented, unproven | :** A priority or cosmetic edit alone does not restart coding or erase an existing acceptance decision. | implementation + unit proof |
| F12-AC4 | Implemented, unproven | :** Reconciliation allows adopting the revised scope, keeping work pending clarification, or proposing a follow-up issue; it records the owner choice. | implementation + unit proof |
| F12-AC5 | Implemented, unproven | :** Synchronization never silently restores an older description over a manual edit or treats an external Done status as release confirmation. ### F13 | implementation + unit proof |
| F13-AC5 | Implemented, unproven | :** Ordinary Linear/webhook updates do not launch new coding jobs automatically; the initial dispatch requires the recorded owner start action. ### F1 | implementation + unit proof |
| F15-AC5 | Implemented, unproven | :** ShipLoop does not copy browser credentials or silently switch billing/accounts. A different paid authentication path requires a deliberate owner c | implementation + unit proof |
| F16-AC1 | Implemented, unproven | :** Display stage, latest milestone, elapsed time, blocker, next action, and detailed logs/evidence accessible on demand. | implementation + unit proof |
| F16-AC2 | Implemented, unproven | :** Publish configured meaningful progress to the linked issue and managed PR section; edits preserve human discussion and unmanaged content. | implementation + unit proof |
| F16-AC3 | Implemented, unproven | :** Repeated milestone delivery does not produce duplicate comments; use an updatable managed comment where the verified provider allows it. | implementation + unit proof |
| F19-AC1 | Implemented, unproven | :** After a meaningful commit and successful push, create or update one linked draft using the configured repository and target branch. | implementation + unit proof |
| F19-AC2 | Implemented, unproven | :** Include purpose, scope, criteria checklist, known gaps, and current verification summary without claiming unexecuted checks passed. | implementation + unit proof |
| F19-AC3 | Implemented, unproven | :** Persist branch, PR/MR external identity, base/target, and full head commit; reconcile a lost create response before retrying. | implementation + unit proof |
| F19-AC4 | Implemented, unproven | :** Use the provider's supported Linear linking mechanism. Inaccessible push or PR rights are an explicit blocker, not a false PR-created milestone. | implementation + unit proof |
| F19-AC5 | Implemented, unproven | :** Do not open a fabricated code change solely to create a PR. Read-only/no-change jobs can complete with evidence and a stated no-code outcome. ###  | implementation + unit proof |
| F20-AC1 | Implemented, unproven | :** Execute configured local checks and read required provider CI results, retaining check identity, candidate, start/end time, exit/status, and outpu | implementation + unit proof |
| F20-AC2 | Implemented, unproven | :** Represent Passed, Failed, Missing, Waiting, Stale, and explicitly Not applicable; skipped required checks are not Passed. | implementation + unit proof |
| F20-AC3 | Implemented, unproven | :** Head/base or relevant environment/policy changes invalidate affected results and prevent ready-for-delivery until the applicable checks rerun. | implementation + unit proof |
| F20-AC4 | Implemented, unproven | :** Distinguish a confirmed base failure from a change-introduced failure when evidence allows; an existing failure does not automatically waive a req | implementation + unit proof |
| F20-AC5 | Implemented, unproven | :** Required checks and who can change the policy are explicit in the project profile; the coding agent cannot remove a required gate to pass its own  | implementation + unit proof |
| F23-AC1 | Implemented, unproven | :** Assign each applicable criterion an automated or owner-test verification method and record a verified result, Pending owner test, or an explicit u | implementation + unit proof |
| F23-AC2 | Implemented, unproven | :** For the main UI flow, retain at least a meaningful screenshot and observed outcome; for API work, retain a sanitized request/result or equivalent  | implementation + unit proof |
| F23-AC3 | Implemented, unproven | :** Evidence records scope revision, full commit, deployment/component IDs where applicable, environment, time, and execution method. | implementation + unit proof |
| F23-AC4 | Implemented, unproven | :** Local evidence is labelled local. Preview acceptance criteria requiring deployed behavior remain unmet until observed against the eligible preview | implementation + unit proof |
| F24-AC1 | Implemented, unproven | :** Show linked issue/scope, PR/diff link, candidate identity, criteria results, required checks, preview, evidence, remaining gaps, and simple owner  | implementation + unit proof |
| F24-AC2 | Implemented, unproven | :** Accept, Request changes, Pause, and the applicable delivery decision are visible only when their current prerequisites allow them. | implementation + unit proof |
| F24-AC3 | Implemented, unproven | :** Missing/stale required automated evidence prevents Ready for your test under the selected policy. Owner-test criteria may remain Pending owner tes | implementation + unit proof |
| F25-AC4 | Implemented, unproven | :** The agent cannot set owner acceptance through its output, ticket comment, or engine completion event. | implementation + unit proof |
| F25-AC5 | Implemented, unproven | :** Feedback outside agreed scope becomes a proposed scope revision or follow-up; it does not silently broaden the currently authorized task. ### F26  | implementation + unit proof |
| F26-AC1 | Implemented, unproven | :** The decision names PR/MR, expected head/target, destination, merge method, and any production side effect; the owner authorizes that exact action. | implementation + unit proof |
| F26-AC2 | Implemented, unproven | :** Immediately before merge, fetch live head/base, required checks/reviews, conflicts, scope changes, and authorization; changed facts block/reassess | implementation + unit proof |
| F26-AC3 | Implemented, unproven | :** Use a provider head precondition where supported and verify the result. Lost responses enter Outcome unknown and are reconciled before another mer | implementation + unit proof |
| F26-AC4 | Implemented, unproven | :** Record actual merge commit and content relation to the tested candidate. Unexpected content or required final-check gaps prevent a separate releas | implementation + unit proof |
| F26-AC5 | Implemented, unproven | :** Owner product acceptance does not impersonate an independent provider-required reviewer; missing permissions/protection requirements produce a vis | implementation + unit proof |
| F27-AC1 | Implemented, unproven | :** Prepare a release manifest with included work, source/merge identity, required components, destination, commands/pipeline, live checks, and known  | implementation + unit proof |
| F27-AC2 | Implemented, unproven | :** In a separate-release profile, approval binds the final eligible release candidate. In a merge-auto-deploy profile, combined merge/release approva | implementation + unit proof |
| F27-AC3 | Implemented, unproven | :** Changed candidate, component, destination, or relevant policy invalidates unconsumed approval; an old decision cannot authorize a different releas | implementation + unit proof |
| F27-AC4 | Implemented, unproven | :** Identify whether the pipeline can publish unvalidated merge content. If the required content/check guarantees are unavailable, the automatic-relea | implementation + unit proof |
| F28-AC1 | Implemented, unproven | :** Execute only the authorized configured action or observe the authorized Git-triggered pipeline; retain operation/deployment identity and response. | implementation + unit proof |
| F28-AC2 | Implemented, unproven | :** Confirm required component identities, intended environment, serving destination, and configured live smoke results before setting Released. | implementation + unit proof |
| F28-AC3 | Implemented, unproven | :** A partial component failure, deployment success with smoke failure, or unavailable identity remains Failed/Blocked/Outcome unknown with component- | implementation + unit proof |
| F28-AC4 | Implemented, unproven | :** Provider timeouts never trigger an unverified duplicate deployment; reconcile current provider state before retry or owner recovery. | implementation + unit proof |
| F29-AC1 | Implemented, unproven | :** Successful confirmation produces a receipt linking work, scope, code/artifacts, component deployments, destination, owner decisions, and smoke res | implementation + unit proof |
| F29-AC2 | Implemented, unproven | :** The receipt is immutable; a correction or later recovery is a linked new record rather than a rewrite of previous delivery history. | implementation + unit proof |
| F29-AC3 | Implemented, unproven | :** Only confirmed required delivery advances ShipLoop to Released and requests the configured Linear completion transition; merge alone does not do s | implementation + unit proof |
| F29-AC4 | Implemented, unproven | :** If Linear synchronization fails, the local receipt remains correct and closure is Pending sync; retry does not republish a duplicate receipt. | implementation + unit proof |
| F30-AC1 | Implemented, unproven | :** Verify applicable provider signatures using original payload bytes; reject invalid deliveries and durably record valid events before acknowledging | implementation + unit proof |
| F30-AC2 | Implemented, unproven | :** Replayed/duplicate delivery IDs do not duplicate jobs, comments, issue publication, merges, or releases; processing fetches current provider state | implementation + unit proof |
| F30-AC3 | Implemented, unproven | :** Out-of-order events cannot revert newer candidate/delivery facts. A missing event is repaired through bounded reconciliation and current-state rea | implementation + unit proof |
| F30-AC4 | Implemented, unproven | :** Respect rate-limit/error categories and bounded backoff; show last successful sync and unresolved writes, and block delivery when required facts c | implementation + unit proof |
| F31-AC4 | Implemented, unproven | :** An owner acknowledges an attention item without changing the underlying run, acceptance, or release fact; resolving the actual blocker updates the | implementation + unit proof |
| F31-AC5 | Implemented, unproven | :** Freshness and disconnected state are visible. Mobile push, email, Slack messages, and native OS notifications are not required for first release.  | implementation + unit proof |
| F32-AC1 | Implemented, unproven | :** History links issue revisions, attempts, events, evidence, feedback, authorizations, merges, and releases with actor/time and correlation IDs. | implementation + unit proof |
| F32-AC2 | Implemented, unproven | :** Export a selected work item's sanitized brief, context, checkpoints, evidence index, and delivery history without including credentials. | implementation + unit proof |
| N01-AC2 | Implemented, unproven | :** Inject interruption immediately before/after an external create/merge/release response; reconciliation establishes the result without blind repeti | implementation + unit proof |
| N01-AC3 | Implemented, unproven | :** Queue/event durability uses consistent transactions; crashes cannot leave an acknowledged job/event absent from the durable store. ### N02 — Secur | implementation + unit proof |
| N02-AC2 | Implemented, unproven | :** Seed test secrets and confirm they are absent from ordinary logs, issue updates, screenshots intended for publication, and exports. | implementation + unit proof |
| N02-AC3 | Implemented, unproven | :** A coding-stage attempt to invoke production delivery or modify owner acceptance is denied by a tested capability boundary. ### N03 — Responsive ac | implementation + unit proof |
| N04-AC2 | Implemented, unproven | :** The connected UI reflects a persisted milestone within five seconds; disconnected state and last update time are visible. | implementation + unit proof |
| N05-AC1 | Implemented, unproven | :** Switching between two saved project profiles requires configuration changes rather than changing core lifecycle code. | implementation + unit proof |
| N06-AC1 | Implemented, unproven | :** Trace a job through queue, engine, Git, deployment, and owner decisions using correlation IDs and sanitized diagnostics. | implementation + unit proof |
| N08-AC1 | Implemented, unproven | :** A consistent backup/restore exercise meets F32 and starts with dispatch disabled. | implementation + unit proof |
| F01-AC4 | Partial | :** State-changing browser requests are protected against cross-site request forgery; authentication cookies are secure and unavailable to client-side | partial implementation |
| F01-AC5 | Partial | :** Installing a native desktop/mobile application is not required to complete the pilot journey. Offline clients show their disconnected state and ca | partial implementation |
| F02-AC3 | Partial | :** Profiles are versioned in ShipLoop storage; a run references its selected version and displays subsequent relevant changes. | partial implementation |
| F02-AC4 | Partial | :** Missing required fields or unsupported provider capabilities produce field-specific errors and prevent affected operations. | partial implementation |
| F02-AC5 | Partial | :** Onboarding a project does not create ShipLoop configuration files or install ShipLoop inside its application repository. ### F03 — Connector setup | partial implementation |
| F03-AC2 | Partial | :** Display connection status, last checked time, supported read/write capabilities, and a useful error for expired or missing access. | partial implementation |
| F03-AC3 | Partial | :** Store credential references separately from profile text; secret values are absent from UI responses, exported context, issue comments, and normal | partial implementation |
| F03-AC4 | Partial | :** Revocation blocks new affected operations. A running attempt preserves its work and reports the access blocker rather than repeatedly retrying cre | partial implementation |
| F04-AC4 | Partial | :** Dependency changes in current code trigger the configured maintenance step or an explicit incompatibility result; old successful setup is not reus | partial implementation |
| F04-AC5 | Partial | :** The recipe works in the VM pilot after fresh workspace preparation; environment resources are cleaned up without deleting retained work or shared  | partial implementation |
| F23-AC5 | Partial | :** A capture failure and a behavior failure are distinct. Traces/recordings are optional enhancements and remain owner-private when they include test | partial implementation |
| F30-AC5 | Partial | :** Record external action intent and result around side effects. Where the provider lacks atomic/idempotent operations, an ambiguous result waits for | partial implementation |
| F03-AC5 | Blocked | :** Connection alone does not grant merge/release authority; the coding role receives no production deployment credential and no unrestricted release  | blocked on external access |
| F22-AC3 | Blocked | :** Missing, building, failed, protected, and usable preview states are distinct; a protected sign-in page is not successful application verification. | blocked on external access |
| F22-AC4 | Blocked | :** For a profile with web and API components, show both identities and confirm the preview web connects to the intended API/test environment. | blocked on external access |
| F22-AC5 | Blocked | :** Expired/removed deployments can be rebuilt or selected again with a new identity; affected acceptance is invalidated instead of silently redirecti | blocked on external access |
| F27-AC5 | Blocked | :** Do not add a post-merge Release button that pretends to authorize a production change already triggered. Approvals can be combined when one action | blocked on external access |
| F28-AC5 | Blocked | :** Recovery shows previous known healthy delivery and proposed action, requires owner authorization, and distinguishes code redeployment from databas | blocked on external access |
| F29-AC5 | Blocked | :** A manual external Done edit is preserved and flagged when release evidence is missing; ShipLoop neither falsely confirms shipment nor silently reo | blocked on external access |
| F05-AC4 | Missing | :** Proposed procedure improvements require an owner save action and a new version; they do not modify instructions for future runs automatically. | none |
| F05-AC5 | Missing | :** Invalid structured outputs are rejected with a recoverable error; only validated proposals enter the lifecycle, and model text cannot directly set | none |
| F16-AC4 | Missing | :** A failed external update is labelled Pending sync with last success time and retry status; local run progress remains available. | none |
| F16-AC5 | Missing | :** Routine output stays in the run view; requests for input, test readiness, delivery decisions, and failed release remain visible attention items. # | none |
| F21-AC1 | Missing | :** Run a fresh review context using accepted scope, current diff, relevant neighboring code, project rules, and actual checks. | none |
| F21-AC2 | Missing | :** Findings contain location, reason, severity, and proposed verification; a possible issue is distinguished from a reproduced defect. | none |
| F21-AC3 | Missing | :** Relevant fixes stay in the linked branch and rerun affected checks/evidence; material new work is proposed separately. | none |
| F21-AC4 | Missing | :** Unresolved required findings block readiness; an owner disposition is recorded without fabricating provider-required approval. | none |
| F21-AC5 | Missing | :** Enforce the configured attempt limits. Describe same-engine fresh-context review accurately; it is not advertised as independent human/model appro | none |
| F22-AC1 | Missing | :** Match a provider deployment to repository, full commit, component, and preview environment; retain its ID and deployment-specific URL. | none |
| F22-AC2 | Missing | :** A branch alias can be a convenience link but does not establish tested identity. Older or wrong-environment deployments are labelled Stale/ineligi | none |
| F24-AC4 | Missing | :** Refresh or live updates expose a new candidate and invalidate old eligibility; actions submitted from an outdated card receive a conflict and show | none |
| F24-AC5 | Missing | :** Provider links open the correct accessible artifact; unavailable content shows an access/freshness error rather than an empty success panel. ### F | none |
| F32-AC3 | Missing | :** Back up consistent database state and retained artifacts; list backup time, retention, and restore instructions. Workspaces are preserved/checkpoi | none |
| F32-AC4 | Missing | :** Restore a sample backup into an isolated instance and recover one draft, one interrupted attempt, and one receipt with working evidence links; pro | none |
| F32-AC5 | Missing | :** A restored instance starts with execution/delivery disabled until reconciliation and explicit activation; restoration does not automatically repla | none |
| N03-AC3 | Missing | :** Errors preserve input and provide an actionable message; loading/empty/error states are distinct. ### N04 — UI responsiveness and freshness | none |
| N04-AC3 | Missing | :** No intake or owner action waits synchronously for a complete coding/deployment job; accepted jobs return a tracked identity. ### N05 — Portability | none |
| N05-AC2 | Missing | :** Shared adapter contract tests reject unsupported operations and wrong-provider identities. | none |
| N05-AC3 | Missing | :** Onboarding leaves connected repositories free of required ShipLoop product/config files; engine/procedure configuration remains externally owned.  | none |
| N06-AC2 | Missing | :** Show elapsed time, attempts, failure category, and actual usage if available; missing facts remain Unknown. | none |
| N06-AC3 | Missing | :** Alerts/attention identify a stopped worker, invalid profile, low artifact capacity, and prolonged provider sync failure without starting extra age | none |
| N07-AC1 | Missing | :** Complete the pilot without installing a mandatory paid orchestration/agent service; record any existing hosting/model entitlement used. | none |
| N07-AC2 | Missing | :** A provider quota/capacity error preserves work and blocks affected operations; no silent plan upgrade, paid-model fallback, or account rotation oc | none |
| N07-AC3 | Missing | :** Report configured storage/attachment limits and preflight capacity; preserve draft/work/receipt records when new artifacts cannot be saved. ### N0 | none |
| N08-AC2 | Missing | :** Cleanup respects retained evidence, active workspaces, and failed-delivery recovery records; deletions are attributable. | none |
| N08-AC3 | Missing | :** Upgrade a versioned profile/procedure or service schema against a sample dataset without corrupting historical decisions; provide a documented rec | none |

## External prerequisites blocking live proof

These are tracked separately because they do not block implementation.

1. **No deployment credential.** No Vercel, Netlify, Fly, Railway, Cloudflare or Render
   token exists on this host and no deployment adapter is written. F22-AC3, F27-AC4,
   F28-AC2 and F29 cannot be proven against a live provider.
2. **No pilot repository or branch protection.** The available `gh` credential holds
   `admin` with `main` unprotected and zero rulesets, so it can push and merge with the
   same permission. See `docs/evidence/2026-10-01-credential-separation.md`.
3. **Owner acceptance and production delivery** require the owner's real decision and are
   never manufactured.

## Register history

- `1556c83` — first register created from a full audit of all 184 criteria.
- `1556c83` — AGENTS.md and TESTING.md corrected: they still described the controller
  surface as missing and `browser-e2e` as red. Both were stale; the entrypoint boots and
  all twelve commands pass at this revision.
