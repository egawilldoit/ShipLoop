/**
 * Which owner surface the browser is currently on, and how that is written down.
 *
 * The MVP navigation is exactly four surfaces — Home, New Request, Review, Settings — so this
 * module has one job beyond that: it is the single place a surface is named. Every deep link,
 * every navigation control and every assertion about "which page is this" is written here, so
 * that the retired surfaces can be addressed for verification without appearing in the product's
 * primary navigation.
 *
 * Hash routing rather than component state, for two reasons the previous state-only shell could
 * not satisfy:
 *
 *   - A surface the owner must be able to return to needs an address. `Request -> Contract` ends
 *     with a contract in hand, and a reload, a shared link or a back button must not silently
 *     land on Home with that contract unreached.
 *   - A retired surface that only exists as component state has to be reachable through the
 *     navigation in order to be driven, which is exactly how implementation-oriented sections end
 *     back in primary navigation. Addressing them by hash keeps every browser spec that proves
 *     them honest while leaving four buttons in the header (see `PRIMARY_SURFACES`).
 *
 * An unrecognised address resolves to Home rather than to a blank screen. A stale bookmark must
 * land somewhere an owner can act from, and it must not land somewhere that claims to show work
 * it cannot address.
 */

/** The four surfaces the MVP navigation offers, in the order the journey runs. */
export const PRIMARY_SURFACES: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'new-request', label: 'New Request' },
  { id: 'review', label: 'Review' },
  { id: 'settings', label: 'Settings' },
];

/**
 * The surfaces that exist but are not part of the MVP product.
 *
 * Kept as data rather than deleted: each one still has browser evidence behind it, and deleting a
 * page while its spec remains would turn a green suite into a lie about what was verified. They
 * are reachable only by address, never from the header.
 */
export const LEGACY_SECTIONS = [
  'profiles',
  'connectors',
  'intake',
  'brief',
  'runs',
  'review-card',
  'dashboard',
  'plan',
  'publication',
] as const;

export type LegacySection = (typeof LEGACY_SECTIONS)[number];

export type Route =
  | { readonly kind: 'home' }
  | { readonly kind: 'new-request' }
  | { readonly kind: 'contract'; readonly contractId: string }
  | { readonly kind: 'handoff'; readonly contractId: string }
  | { readonly kind: 'review'; readonly candidateId: string | null }
  | { readonly kind: 'settings' }
  | { readonly kind: 'legacy'; readonly section: LegacySection };

export const HOME_ROUTE: Route = { kind: 'home' };

function isLegacySection(value: string): value is LegacySection {
  return (LEGACY_SECTIONS as readonly string[]).includes(value);
}

/**
 * Reads a `location.hash` into a route.
 *
 * Segments are percent-decoded one at a time and an address whose identity segment is missing or
 * empty falls back to Home. Falling back is the honest answer: the hash says "show me a contract"
 * without saying which one, and rendering a contract page with no contract would show an empty
 * editor that reads as a contract with no requirements.
 */
export function parseRoute(hash: string): Route {
  const withoutHash = hash.startsWith('#') ? hash.slice(1) : hash;
  const segments = withoutHash
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => decodeURIComponent(segment));
  const head = segments[0];

  if (head === undefined) return HOME_ROUTE;
  switch (head) {
    case 'home':
      return { kind: 'home' };
    case 'new-request':
      return { kind: 'new-request' };
    case 'settings':
      return { kind: 'settings' };
    case 'review':
      return { kind: 'review', candidateId: segments[1] ?? null };
    case 'contracts':
      return segments[1] === undefined || segments[1] === ''
        ? HOME_ROUTE
        : { kind: 'contract', contractId: segments[1] };
    case 'handoff':
      return segments[1] === undefined || segments[1] === ''
        ? HOME_ROUTE
        : { kind: 'handoff', contractId: segments[1] };
    case 'legacy':
      return segments[1] !== undefined && isLegacySection(segments[1])
        ? { kind: 'legacy', section: segments[1] }
        : HOME_ROUTE;
    default:
      return HOME_ROUTE;
  }
}

/** The address a route is written to, so navigation and deep links cannot disagree. */
export function routeHash(route: Route): string {
  switch (route.kind) {
    case 'home':
      return '#/home';
    case 'new-request':
      return '#/new-request';
    case 'settings':
      return '#/settings';
    case 'review':
      return route.candidateId === null ? '#/review' : `#/review/${encodeURIComponent(route.candidateId)}`;
    case 'contract':
      return `#/contracts/${encodeURIComponent(route.contractId)}`;
    case 'handoff':
      return `#/handoff/${encodeURIComponent(route.contractId)}`;
    case 'legacy':
      return `#/legacy/${encodeURIComponent(route.section)}`;
  }
}

/**
 * The hash for one of the four primary surfaces.
 *
 * A separate function from `routeHash` on purpose: it only answers for a surface that is in the
 * header, so a control cannot be built from the address of a retired surface.
 */
export function primaryHash(id: string): string | null {
  const surface = PRIMARY_SURFACES.find((entry) => entry.id === id);
  return surface === undefined ? null : routeHash(parseRoute(`#/${surface.id}`));
}

/**
 * Whether a route is one of the four primary surfaces.
 *
 * The header marks the current tab with `aria-current="page"`, and a tab that highlights itself
 * while a retired surface is on screen would tell the owner they are somewhere they are not.
 */
export function isPrimary(route: Route, id: string): boolean {
  if (route.kind === 'legacy') return false;
  if (id === 'home') return route.kind === 'home';
  if (id === 'new-request') return route.kind === 'new-request';
  if (id === 'review') return route.kind === 'review';
  if (id === 'settings') return route.kind === 'settings';
  return false;
}