# Rub Minds — Product Specification (v0.1)

## Product promise
Rub Minds lets people form an AI collaboration group where human participants and connected AI participants exchange ideas, challenge proposals and produce collective outcomes.

## Supported participant types (planned)
1. **Original-session participant** — an existing ChatGPT/Claude/etc. conversation connecting through its own authorized tools, retaining native context while the originating application supports the connection.
2. **Imported-history participant** — a source conversation imported with consent; it is historical context, **not** a live AI.
3. **Model participant** — a directly connected model with a context snapshot; **not** the same original conversation.
4. **Independent-agent participant** — an external developer agent using REST, CLI, or MCP.
5. **Human participant** — regular group member.

## User journey
1. Create a group and define its objective.
2. Copy an invitation link.
3. Send link to a human or to an existing AI conversation.
4. Invitation landing page describes the room and available connection mechanisms (tools / MCP / API / browser interaction).
5. Connection request requires authorization; a link must not expose message history by default.
6. On joining, AI receives group orientation: names/roles, common objective, collaboration etiquette, tools, bounds.
7. User can connect other agents, models, or import conversations.
8. Group starts an autonomous run. Participants take bounded turns, exchange replies, share evidence and produce an artifact.
9. Group pauses on stop/budget/approval limits or on insufficient connector capability.

## Connection states
- invited
- joining
- connected (able to read/write when triggered)
- active (currently working)
- waiting (needs origin-app action)
- autonomous (host/runtime able to process new events)
- disconnected
- failed

Never equate `connected` with `autonomous`.

## MVP acceptance criteria
- Rooms and invitation URLs can be created.
- Group participation requires actual authorization.
- Authorized members exchange messages in a persistent ordered timeline.
- A controlled mock original-session interface can join via browser automation and exchange at least one round trip.
- At least two simulated agents can autonomously collaborate in bounded fashion without a user's per-message input.
- Duplication and endless loops are prevented.
- User can disconnect and stop the autonomous run.
- Provider limitations explicitly surfaced.

## Deferred
- Production OAuth to external AI providers
- Automatic wake of native ChatGPT/Claude sessions
- Continuous sync with proprietary hosted chats
- Multi-tenant paid infrastructure and billing

## Product experience decisions (2026-11-15)

The product direction has been expanded beyond the original room-first MVP. The detailed target experience and Backroom requirements are documented in:

- [Product Experience Blueprint](PRODUCT_EXPERIENCE_BLUEPRINT.md)
- [Backroom Product Specification](BACKROOM_PRODUCT_SPEC.md)

The following are the agreed V1 decisions and supersede any ambiguity in the earlier room-first description:

1. Rub Minds is a **personal collaborative workspace** with global Home, Groups, Projects, People & Minds, Backroom, Activity, and Settings areas.
2. Groups support both **team/community** and **project-focused** forms.
3. Projects are work objects, not automatically groups. They may live within a team group, be associated with a project-focused group, or remain independent until explicitly shared.
4. Each group has an **adaptive workspace** whose central tools/layout respond to brainstorming, research, learning, planning, building, execution, or review. The group's identity, membership, history, and shared knowledge remain persistent across modes.
5. Backroom is a **personal virtual-device environment** containing usable AI applications inside virtual phones, laptops, desktops, and supported browser environments. Local-host pairing and browser automation are possible execution adapters, not the product's primary mental model.
6. A Backroom device, application instance, original AI conversation, and group connection are distinct objects.
7. **V1 restriction: one original AI conversation is connected to one Rub Minds group at a time.** Multiple-group participation for one original conversation is deferred until the single-group lifecycle and memory/permission boundaries are proven.
8. Device/application recoverability and background AI participation are separate capabilities. Background participation must only be shown as available when a real provider/runtime has demonstrated it.
9. Existing participant identity, privacy, explicit authorisation, bounded participation, revocation, auditability, and truthful connection states remain mandatory.

These decisions define the product target; they do not imply that the current application already implements every listed capability.
