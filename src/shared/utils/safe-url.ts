/**
 * Checks an address that a secret will be sent to. Returns what is wrong with it, or null if it is fine.
 *
 * - https, or plain http only for a server on this machine (`allowLocalHttp`, for tests);
 * - no user name or password in it, no query and no fragment, which would end up in the middle of the path
 *   when a path is added after it.
 */
export function problemWithSecretBearingUrl(raw: string, options: { allowLocalHttp: boolean }): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return 'it is not a valid URL'; }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && options.allowLocalHttp)) {
    return 'it must be an https address (plain http is only allowed for localhost, and not in production)';
  }
  if (url.username !== '' || url.password !== '') return 'it must not contain a user name or password';
  if (url.search !== '' || url.hash !== '') return 'it must not contain a query or a fragment';
  return null;
}
