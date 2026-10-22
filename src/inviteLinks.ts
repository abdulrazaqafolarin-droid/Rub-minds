export function readInviteToken(search: string, pathname: string): string {
  const queryToken = new URLSearchParams(search).get('invite');
  const pathToken = pathname.match(/^\/invite=([^/]+)\/?$/i)?.[1];
  return queryToken || pathToken || '';
}

export function isValidInviteToken(token: string): boolean {
  return /^[0-9a-f]{64}$/i.test(token);
}

/** Builds the post-email-confirmation URL while preserving a pending invite. */
export function buildInviteRedirectUrl(origin: string, inviteToken: string): string {
  const redirect = new URL('/', origin);
  if (isValidInviteToken(inviteToken)) {
    redirect.searchParams.set('invite', inviteToken);
  }
  return redirect.toString();
}

/** Consistent, explicit invitation status text for both route selection and auth. */
export function getInviteStatusMessage(token: string): string {
  return isValidInviteToken(token)
    ? 'Group invitation detected. Your invite will be kept while you sign in.'
    : 'This invitation link is incomplete or invalid. Ask the group owner for a fresh link.';
}
