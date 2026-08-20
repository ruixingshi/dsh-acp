# Turn Lifecycle and rc.8 Upgrade Plan

**Goal:** Keep each ACP prompt in flight until its DeepSeek Harness agent is quiescent, preserve activity-wide failures without misclassifying internal turn endings, then upgrade the Harness dependency family to `0.1.0-rc.8`.

**Design:** The runtime records the correlated turn, every activity-wide failure, and explicit ACP cancellation while the Harness driver is running. After submitting the prompt, it observes the whole-agent activity through `agent.whenIdle()` and settles only after that interval reaches quiescence. A failure from replacement work fails the owning prompt, while a Harness-internal abort and sticky per-step max-token marker settle as ordinary ACP `end_turn`. Session disposal remains a forced terminal path because it removes admission before releasing the agent. Assistant presentation comes from committed `assistant/message` events so failed retry attempts never reach clients.

## Tasks

1. Add real Agent Loop regressions for an error followed immediately by another prompt, cancellation followed immediately by another prompt, cancellation while queued behind maintenance, and failure before inbox claim.
2. Record error and cancellation state without clearing the in-flight prompt before the owned Harness activity reaches quiescence.
3. Settle the recorded outcome after `agent.whenIdle()`, mapping only explicit ACP cancellation to `cancelled`, any activity failure to rejection, and Harness-internal abort or max-token endings to ordinary completion.
4. Pin the complete standalone `@deepseek-ai/dsh-*` peer closure and the testkit to `0.1.0-rc.8`; bump the adapter patch version and match its supported Node.js range.
5. Add regressions for replacement-turn failure, hook cancellation, max-token completion, and the published Node.js engine range.
6. Run focused tests, typecheck, lint, build, the full test suite, and packed-package validation.
7. Cover provider retry output, stable ACP message ids, request-level cancellation, resource-link encoding, and package-version consistency.
