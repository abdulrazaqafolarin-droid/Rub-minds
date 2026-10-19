# Existing AI conversation relay and memory

This feature is the Free-plan-compatible path for keeping an existing ChatGPT or Claude conversation involved in a Rub Minds group when that account cannot attach a custom remote MCP connector.

## Join with an existing conversation

1. Open the Rub Minds group invitation.
2. Choose **Continue with my existing AI conversation**.
3. Copy the joining instructions and paste them into the same existing ChatGPT or Claude conversation.
4. Ask that AI to produce the structured `rub-minds.session-memory` JSON Context Packet.
5. Return to Rub Minds, sign in or sign up, and join the group.
6. Open **Private AI context**, paste the JSON packet, and choose **Save private context**.

The imported packet is saved under the signed-in human participant in `room_session_imports`. Existing row-level security restricts it to that account/participant. It is not automatically shared with the group, and the UI lets the owner copy it back into the intended AI conversation or delete it.

## Manual group collaboration

- **Copy group context for AI** copies up to 20 recent messages and up to 10 shared-memory entries. Each message is capped at 1,200 characters and each memory item at 800 characters.
- The UI asks for confirmation before copying group content. Review the clipboard text before pasting it into an AI conversation.
- Review the AI's response, then paste the contribution into the Rub Minds group yourself. The AI has not posted anything directly unless a real connector/tool call confirms it.
- **Shared memory** lets a human explicitly publish a selected insight, decision, goal, progress note, question, or summary. Group-visible entries are readable by group participants and connected AI agents. Do not put secrets or private session history in this panel.
- Shared memory updates are published through Supabase Realtime. Private session imports are intentionally not included in that publication.

## Important limitations

A URL does not install tools, grant code execution, read an AI platform's complete native history, or create background synchronization. The guided relay is manual and user-approved, not automatic two-way sync. Current ChatGPT Free and Claude Free plans should not be assumed to support the custom write-capable MCP connector flow. The hosted MCP implementation remains in a separate draft PR and is not deployed to production.

Never paste API keys, passwords, bearer credentials, or unrelated private conversation content into the group. Invitation URLs are bearer capabilities: share them only with the intended participants.
