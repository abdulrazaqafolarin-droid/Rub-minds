# Backroom interaction modes

## Scope

The first Off / On / Auto control is supported only by a live, registered managed-browser composer whose local host reports canonical wake capability. It is not a general-purpose automatic typing switch for native Windows apps, Android apps, terminals, or arbitrary desktop windows. Those surfaces retain their separate manual draft and local-approval flows.

## Modes

| Mode | Participation policy | Behavior |
| --- | --- | --- |
| Off | No active input binding | Permanently revokes the selected binding and cancels its pending/leased wake jobs. No trigger is allowed for that binding. Register it again before enabling a mode. |
| On | `mentions` | Queues a wake only when a human-authored group message mentions the selected AI participant by its display name. |
| Auto | `smart` | Queues a wake for each new human-authored group message. AI-authored messages do not automatically relay to another AI, preventing cross-agent wake loops. |

Switching between On and Auto changes the server-side participation policy. The existing binding is revoked and its queue cancelled before the replacement binding can be registered. A mode label is never allowed to silently mutate a live binding.

## Consent and execution boundaries

On and Auto are both explicitly armed by the local host approval flow. The grant is bound to one group, AI participant, hosted session, browser target, target identity fingerprint and target revision. It expires after five minutes and is limited to six wake triggers per minute. The database independently enforces the binding's rate limit and grant expiry.

The worker may submit only the canonical event-bound `@RMconnects` trigger. It does not paste the originating group message verbatim into the provider composer. The selected composer must still be the exact registered, visible, empty composer with a unique send control. A changed conversation, replaced field, occupied composer, stale binding or failed local preflight blocks the action.

Off uses owner-authenticated server-side binding revocation, which cancels pending and leased jobs even when the local host cannot be reached. A failed server revocation must be shown as a failure; the UI must not claim Off succeeded.

## What a successful wake means

A wake queue acknowledgement confirms that the trigger was submitted and the composer cleared. It does **not** prove the original AI finished its response or that its reply reached the Rub Minds group. That end-to-end response delivery still requires the separately configured original-session bridge and its durable cursor/pending-response handling.

## Acceptance checklist

1. Register a ChatGPT or Claude managed-browser composer in one group and choose On. Confirm that the local host asks for approval before the five-minute grant starts.
2. Send a human message without mentioning the AI. On must not wake it.
3. Mention the AI by its participant display name. On should enqueue a canonical trigger for that event.
4. Change to Auto. Confirm the old binding is revoked before the new smart-mode binding is created. An ordinary human group message should now enqueue a trigger.
5. Send an AI-authored message. Auto must not relay it automatically to another AI.
6. Choose Off. Confirm the binding is revoked and pending/leased jobs are cancelled. Verify that no more provider trigger is submitted.
7. Leave Auto armed until expiry. Verify polling/consent stops after the five-minute grant and the owner must explicitly arm it again.
8. Exceed the six-wakes-per-minute bound. Additional triggers must be denied by the server-side rate limit.
9. Occupy the selected composer, navigate to another conversation, replace the selected field, or change the target revision. The host must fail closed without typing or retargeting.

This acceptance checklist is not a claim that those live-provider/device tests have already been performed.
