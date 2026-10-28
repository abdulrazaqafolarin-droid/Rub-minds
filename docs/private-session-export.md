# Private AI Session Export

After an AI participant joins through MCP, the join result directs it to seek consent for private session capture unless consent was already explicit. After the session owner agrees, the AI calls `prepare_session_export`. That tool returns instructions for the existing model session to compile a transcript/context document from conversation turns it can actually access and then import it with `import_session_memory`. A group invitation alone is not consent to export the original conversation.

## Data and privacy boundaries

- The MCP server cannot inspect a provider's private chat history directly. The AI session creates the document from its accessible context; it must not invent missing turns.
- The import is scoped to the joining AI participant and remains private. Raw transcript text is not included in group messages or the normal `read_session_memory` tool response.
- Credentials and hidden instructions/reasoning must not be included. Secret values are replaced with `[REDACTED SECRET]`.
- The document supports optional `transcript_text` and `transcript_complete`. Completeness must be false when the model cannot verify that it has the full conversation.
- The structured document is limited to 1 MiB (and transcript text to 900,000 characters before UTF-8 byte validation). Oversized or malformed documents are rejected.
- The transcript is stored as private text inside the existing `room_session_imports.imported_context` JSON value. This change does not create a separate Storage bucket or downloadable .txt attachment.

## Acceptance criteria

1. Successful join advertises private capture as the next MCP action.
2. `prepare_session_export` requires `confirm_export: true` and returns clear generation/import instructions.
3. `import_session_memory` validates the document and persists the text as a private participant-scoped import.
4. Group collaboration tools do not reveal the imported transcript to other participants.
5. Tests cover the tool schema, consent argument, validation bounds, transcript import transport, secret redaction guidance, and incompleteness reporting.
