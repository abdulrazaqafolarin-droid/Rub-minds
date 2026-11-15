# Rub Minds — Stage B interface integration plan

**Working branch:** `feat/full-product-experience-stage-b`  
**Base:** Stage A PR #69 exact-head commit `e062c943eb1503ccc4d29f11121496c8295c9c34`  
**Current commit before this plan:** `2254f175c96f0c754f6b05285c5445c399ab0617`  
**Scope:** reconcile the merged PR #70 design system with Stage A collaboration/task/device functionality, then implement the full responsive product interface.  
**Status:** engineering plan; no production or database changes.

## 1. Source-of-truth order

1. The Stage A execution contract on PR #69 defines identity, device/frame, collaboration, memory, task and execution boundaries.
2. The feature preservation matrix defines what the interface must retain.
3. PR #70 on main supplies the newer visual system, accessible group/auth flows, dialogs and theme.
4. PR #71 on main supplies the corrected Deno/Playwright CI workflow.
5. This Stage B branch is where these are reconciled. Do not change PR #69's base or merge its stack as part of UI work.

The parked PR #72 is an earlier Home/Backroom exploration only. Do not copy its Home component as the application architecture or treat it as an alternative Stage A base.

## 2. Exact source reconciliation

| Source | Use in Stage B | Important caution |
|---|---|---|
| `src/CloudApp.tsx` from main / PR #70 | Visual and navigation baseline for auth, invite and group workspace | Re-add the Stage A GroupTaskBoard as a real group tab. Do not replace the task APIs or omit their authorization/review flows. |
| `src/cloudRooms.ts` from Stage A | Canonical cloud API/types, including task and device-adjacent APIs | Keep this version; do not downgrade to main's older 285-line version. |
| `src/GroupTaskBoard.tsx`, `src/group-task-board.css` from Stage A | Existing task UI and lifecycle | Integrate into the new panel system and adapt the CSS tokens. Preserve dependencies, idempotency, criterion evidence, human review and Realtime race guards. |
| `src/UiPreferences.tsx`, `src/themePreference.ts`, tests, `src/uiFlow.ts` from main | Shared theme preference and participant labels | Keep primary blue identical in both themes. |
| `src/rub-minds-redesign.css` from main | Visual system for CloudApp and the existing Backroom styles | Extend it for Stage A device screens; do not assume its legacy Backroom selectors style the new Device Workspace. |
| `src/main.tsx`, `src/App.tsx`, `index.html`, `tsconfig.json` from main | Theme provider, current entry behavior and build exclusions | Retain Stage A's Backroom route target, which resolves to the new device experience. |
| `src/BackroomApp.tsx` from Stage A | Wrapper to `BackroomDevicesApp` | Do not overwrite it with main's legacy Backroom browser simulator. |
| `src/BackroomDevicesApp.tsx`, Android/desktop controls, frame connector, device APIs and styles from Stage A | Backroom phone/desktop/terminal/device-frame product | Keep one device/runtime/AI-session/group identity; improve theme and navigation additively. |
| `integrations/backroom/dispatcher.mjs` and `durable-wake-runtime.mjs` from PR #70 | Specific one-shot seal/grant-before-effect safety behavior | Reconcile the exact guard hunks with Stage A's later changes; do not wholesale replace newer code. |
| PR #70 UI browser test and PR #70 regression tests | Retained baseline acceptance | Extend them to assert the task tab and Stage A Backroom device flows. |

## 3. Group workspace — first implementation slice

Use the PR #70 group workspace as the visual base. Keep existing panels:
- Conversation
- People
- Private context
- Shared memory
- Connections

Add Tasks as a sixth panel using the existing `GroupTaskBoard` component. The component must receive the current room ID, current participants, current human participant ID and group-owner status. It must be keyed by room so a group switch cannot retain another group's board state.

No room task tables, MCP task tools, assignment engine or dependency rules are to be recreated. Existing GroupTaskBoard handles loading, Realtime refresh, idempotent creation/submission, dependencies, criterion evidence, human review and task lifecycle.

The task tab must be available only in an authenticated group context. It must never display invented progress or confuse tasks with full Projects.

## 4. Backroom — preserve and restyle the current product

Keep Stage A's actual `BackroomApp` → `BackroomDevicesApp` routing. Restyle `br-cloud-shell`, connected device cards, surface tabs, phone frame, app inventory, device activity, Android control, desktop view and terminal panels using the shared `--rm-*` theme tokens.

Preserve explicit state distinctions:
- device pending / approved / revoked;
- runtime live / unavailable;
- app inventory / running app;
- AI joined / frame unbound / frame bound;
- manual draft capability versus verified native action;
- local approval, group invitation, frame binding and wake consent as separate permissions.

The current Backroom device page selects a group and shows devices paired to that group. Do not call it a global cloud virtual-device manager. A future owner-level inventory requires a reviewed data/API model before implementation.

## 5. Global navigation and domain gaps

Deliver functional existing destinations first:
- Home / Groups: real cloud rooms, create and invite flows.
- Group workspace: all six panels.
- Backroom: existing Stage A device/frame app.

Do not yet create functioning Projects, global People & Minds or global Activity pages with fake data. The current code has room-scoped participants, tasks, messages and device events, but not separate project records, a global people directory or one normalized activity feed. Those domains need their own schema/permissions/contracts before implementation.

A clearly labelled "not available yet" view is acceptable only as an honest explanation, not as a simulated data dashboard. Do not create inert controls.

## 6. Port the PR #70 execution-safety correction

PR #70's dispatcher and durable wake updates are security-sensitive:
- `beforeEffect` must confirm both the durable one-shot execution seal and consumption of the exact wake approval;
- the checks run after local preflight immediately before the adapter effect;
- if the guard passed, any subsequent adapter error is ambiguous and becomes `needs_review`;
- a preflight denial is retryable only before the effect guard has succeeded;
- missing seal or approval callbacks must fail closed.

Port these specific semantics into the later Stage A implementation and keep the relevant Node tests. Preserve provider-conversation digest validation, device command settlement, durable result receipts and the existing no-blind-replay behavior.

## 7. Validation after each vertical slice

1. TypeScript and Vite production build.
2. Vitest unit tests, including existing auth, invite, theme and UI tests.
3. Complete `test:runtime`, `test:backroom`, `test:external-workspaces` and durable queue/SQL workflow.
4. PR #70 UI browser acceptance plus new assertions for task navigation, panel isolation, invite routes and Backroom Device Workspace.
5. Clean local Supabase migration replay and human/MCP/device E2E.
6. Android/Windows CI artifacts and native build checks.

These validate source contracts and build artifacts. They do not substitute for real ChatGPT/Claude account connection, a physical Android handset, a physical workstation, or a real OpenCode/Claude Code terminal client. Those remain explicit physical/provider acceptance gates.

## 8. Change and release boundaries

- No schema migration or Edge Function deployment is part of this Stage B interface work.
- No production secret, auth setting, Vercel production deployment or production data change.
- Do not merge PR #69, this branch, or PR #72 without explicit approval.
- Keep PR #72 parked and keep Stage B changes stacked on the Stage A branch until the relevant code and checks are complete.
- Report code written, committed, tested, merged and deployed separately.
