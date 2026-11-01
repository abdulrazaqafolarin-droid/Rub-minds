export type TerminalDraftMessage = Readonly<{
  requestId: string;
  sessionId: string;
  data: string;
}>;

export type TerminalSubmitMessage = Readonly<{
  requestId: string;
  sessionId: string;
}>;

export type TerminalExitedMessage = Readonly<{
  kind: "terminal_exited";
  sessionId: string;
}>;

export type TerminalActionRequestDecision = "invalid" | "duplicate" | "limit" | "accepted";

export function validateTerminalDraftMessage(
  message: unknown,
  expectedSessionId: string,
): TerminalDraftMessage | null;

export function validateTerminalSubmitMessage(
  message: unknown,
  expectedSessionId: string,
): TerminalSubmitMessage | null;

export function createTerminalActionRequestGuard(
  maxRequests?: number,
): (requestId: string) => TerminalActionRequestDecision;

export function validateTerminalExitedMessage(
  message: unknown,
  expectedSessionId: string,
): TerminalExitedMessage | null;
