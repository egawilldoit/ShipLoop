/**
 * Whether a configured external address is one a browser may be sent to.
 *
 * A URL that reaches this file came from outside the browser — it is whatever an operator stored
 * in project settings — so it is untrusted input at the moment a page is about to put it in an
 * `href`. Two questions have to be answered separately, and this file answers only the first:
 *
 *   1. **Is it a scheme this page is willing to navigate to?** `http:` and `https:` and nothing
 *      else. A stored `javascript:`, `data:`, `file:` or `vbscript:` URL in an anchor is script
 *      execution with an owner's click behind it, and the owner has no way to see the scheme
 *      through a button labelled "Open T3" (N02-AC2).
 *   2. **Does it carry a credential in its userinfo?** `https://user:token@host` is a secret that
 *      would be rendered into the DOM, copied out of the page, and left in the browser history the
 *      moment the owner clicked. The settings route refuses such a value before it is stored, so
 *      reaching one means the boundary moved; refusing it here keeps the secret out of the document
 *      rather than relying on that refusal never being weakened (L02-AC2, N02-AC2).
 *
 * This is deliberately not a URL parser. It is a gate on a value that has already been validated by
 * the server that stored it, and its whole job is to be small enough that a reader can see every
 * way it says no.
 */

/** The schemes this app is willing to navigate a browser to from a stored address. */
const OPENABLE_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * Whether a character is one that must never appear inside a stored address.
 *
 * C0 controls and DEL. A newline above all is how a stored `https://good.example` becomes
 * `https://good.example` followed by something else in a header or a log line, and a NUL truncates
 * a value the moment it reaches a C string somewhere downstream. Written as a code-point comparison
 * rather than a literal range so the source file stays plain text and readable in a diff.
 */
function isControlCharacter(codePoint: number): boolean {
  return codePoint <= 0x1f || codePoint === 0x7f;
}

/**
 * Whether `value` is an absolute `http(s)` URL with no userinfo and no control character.
 *
 * Returns false rather than throwing on anything malformed, because every caller has the same
 * answer to a malformed address: there is nothing to link to, and the packet or card it sits beside
 * is still worth showing.
 */
export function isHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return false;
  for (const character of trimmed) {
    if (isControlCharacter(character.codePointAt(0) ?? 0)) return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (!OPENABLE_SCHEMES.has(parsed.protocol)) return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  // `URL` resolves a scheme with no host — `https:///path` — to a URL whose `host` is empty. A link
  // with no destination is not a link, so it is refused rather than rendered as one.
  return parsed.host !== '';
}