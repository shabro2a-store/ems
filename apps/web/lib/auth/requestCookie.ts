/**
 * A cookie's value from the request's Cookie header, wherever it sits in it.
 *
 * Replaces `new RegExp(\`(?:^|;\s*)${name}=...\`)`: in a template string `\s`
 * is just `s`, so that pattern only found a cookie sent FIRST - and a browser
 * that sent csrf first was signed out instead of renewed.
 */
export function requestCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value || undefined;
    }
  }
  return undefined;
}
