# Triage Labels

This file defines the canonical tracker roles and maps them to this tracker's strings.

## Category roles

| Canonical role | Label in our tracker | Meaning                    |
| -------------- | -------------------- | -------------------------- |
| `bug`          | `bug`                | Something is broken        |
| `enhancement`  | `enhancement`        | New feature or improvement |

## Artifact marker

| Canonical role | Label in our tracker | Meaning              |
| -------------- | -------------------- | -------------------- |
| `spec`         | `spec`               | Specification        |

The `spec` marker is authoritative. A `[SPEC]` title prefix is a display aid only.

## Readiness and disposition roles

| Canonical role      | Label in our tracker | Meaning                                     |
| ------------------- | -------------------- | ------------------------------------------- |
| `needs-triage`      | `needs-triage`       | Maintainer needs to evaluate this request   |
| `needs-info`        | `needs-info`         | Waiting on the reporter                     |
| `ready-for-tickets` | `ready-for-tickets`  | Settled spec awaiting decomposition         |
| `ready-for-agent`   | `ready-for-agent`    | Executable ticket an agent can complete     |
| `ready-for-human`   | `ready-for-human`    | Executable ticket requiring a human step    |
| `wontfix`           | `wontfix`            | Request will not be actioned                 |

Every triaged item has one category role. Every open actionable item has one readiness/disposition role. After decomposition, a parent keeps `spec` and its category but has no readiness role; its children carry the next actions.

- Active ownership is the configured tracker claim plus the deterministic Git branch/worktree and any open change request.
- A ticket is on the implementation frontier only when it is open, ready, unclaimed (none of the issue tracker's active-work signals), has no integration-merge record, and every blocker is done under `/to-tickets`' rule for when a blocker is done.
- A spec's repository-change tickets merge into the spec's integration branch (named by `/to-tickets`) with no change request of their own, and stay open. One spec change request takes that branch into the usual base branch. A standalone ticket ships in its own change request into the usual base branch. `docs/agents/issue-tracker.md` gives only the platform mechanics: opening a change request and how it closes issues.
- Repository-change delivery of a spec's ticket requires its ticket branch merged into the spec's integration branch, then the spec change request merged into the usual base branch, which closes the ticket. Merging into the integration branch alone is not delivery; the ticket stays open until then.
- Whoever merges a ticket branch into the integration branch records an **integration-merge record** on the ticket at once: a comment naming the integration branch and the merge commit. The ticket branch and worktree may be removed after the merge, so this record is the durable signal that keeps the open ticket off the frontier and lets its dependents start.
- Repository-change delivery of a standalone ticket (no parent spec) requires its own merged change request and a closed tracker item.
- Human-only or external-artifact delivery requires the recorded qualification or artifact named by its acceptance criteria and a closed item; no artificial change request is needed. Mixed work requires both kinds of evidence. Supersession or administrative closure is not delivery.
- The spec acceptance audit is the Spec axis of the final `code-review` over the whole integration branch, checked against every requirement the spec owns. There is no separate closer. Merging the spec change request after that review reports Ready authorizes closing the spec; the next rule says when it closes.
- The spec change request closes the spec and its delivered tickets when no other required child remains. When a human-only or non-repository child remains, it closes only its delivered tickets. The spec then closes when the last remaining child records its delivery evidence: whoever closes that child confirms every required child has its evidence and closes the spec too. A spec with no repository change follows the same rule without a change request. Closed children alone are otherwise insufficient.

Use `ready-for-agent` only when an agent can finish the work from repository and tracker context with ordinary authorized tools.

Use `ready-for-human` when completion inherently requires at least one of:

- Personal authentication
- Subjective visual or experiential qualification
- Privileged or irreversible production access
- Legal, compliance, or security approval
- A decision that cannot be reduced to approved acceptance criteria

A ticket that mixes agent-executable preparation with a human-only action should be split when each part can be verified independently. The human ticket depends on the agent preparation ticket. Record the specific human step on the ticket as its readiness rationale.

When a skill mentions a canonical role, use the corresponding tracker string from this table. Edit the right-hand column to match the repository's vocabulary.
