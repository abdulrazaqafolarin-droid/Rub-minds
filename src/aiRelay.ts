export type RelayMessage = {
  sender: string;
  body: string;
  createdAt?: string;
};

export function buildExistingAiJoinPrompt(invitationUrl: string): string {
  return [
    "I want this existing AI conversation to help me participate in a Rub Minds collaborative group.",
    "",
    "GROUP INVITATION",
    invitationUrl,
    "",
    "IMPORTANT: Opening or reading this URL does not automatically connect you to the group or grant tools. Do not claim you have joined, sent a message, or synchronized anything unless a supported tool actually confirms it.",
    "",
    "PRESERVE THIS CONVERSATION'S CONTINUITY",
    "First prepare a concise Rub Minds Context Packet using relevant context already available in this conversation:",
    "- Current project or task and its objective",
    "- Important decisions and why they were made",
    "- Constraints, preferences, and working style relevant to this group",
    "- Current progress and next steps",
    "- Open questions where other people or AIs could help",
    "",
    "PRIVACY RULES",
    "Do not include passwords, API keys, credentials, private URLs, sensitive personal details, or unrelated private conversation content. If a detail may be private or inappropriate to share with the group, omit it and ask me before sharing it.",
    "",
    "HOW TO COLLABORATE",
    "If you have a real, authorized Rub Minds connector/tool available, explain what it can do and ask for my approval before joining or sending a message. Otherwise, use a guided manual relay: give me the Context Packet to review and paste into the group, then wait for me to bring group messages back here. Help draft thoughtful replies that preserve this conversation's context. Never pretend manual copy/paste is automatic synchronization.",
    "",
    "Start by preparing the Context Packet. Keep it useful and compact, and mark anything I should review before sharing."
  ].join("\n");
}

export function buildGroupRelayPrompt(groupTitle: string, objective: string, messages: RelayMessage[]): string {
  // Bound prompt size to protect the user's context window and token budget.
  const transcript = messages.slice(-20).map((message) => {
    const time = message.createdAt ? " [" + message.createdAt + "]" : "";
    const body = message.body.length > 1200 ? message.body.slice(0, 1200) + "… [message truncated]" : message.body;
    return message.sender + time + ": " + body;
  }).join("\n");
  return [
    "I am relaying messages from my Rub Minds group into this existing AI conversation. Continue using the relevant context and working style already established here.",
    "",
    "GROUP: " + groupTitle,
    "OBJECTIVE: " + (objective.trim() || "Collaborate on the group's current goal."),
    "",
    "RECENT GROUP MESSAGES (newest messages are at the bottom):",
    transcript || "(No messages included.)",
    "",
    "Before responding, treat this pasted transcript as group-shared content, but do not repeat credentials or sensitive personal data. Please identify what is relevant to our existing work, then draft a concise contribution or question for the group. Do not claim you posted it; I will review and paste your response into Rub Minds. Keep private context from this original conversation out of the group unless I explicitly approve sharing it."
  ].join("\n");
}
