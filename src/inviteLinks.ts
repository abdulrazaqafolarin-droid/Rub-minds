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
