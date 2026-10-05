/**
 * The surfaces the shell can show, as data rather than as a switch statement in the render.
 *
 * Primary navigation is exactly four surfaces: Home, New Request, Review, Settings. Home is
 * the default signed-in surface, because the first question an owner has after signing in is
 * "what needs me", and answering it is a read of facts rather than a place to configure
 * something.
 *
 * The legacy surfaces are declared here too, and they are declared rather than deleted on
 * purpose. Profiles, Connectors, Runs, Plan, Publication and the old Needs-you board are
 * working screens; the MVP cut hides them from primary navigation, and hiding is not the same
 * as removing code someone still has to be able to reach. They keep their own labels so a
 * test or a runbook written against them still finds them where they were.
 *
 * Both lists are typed from their own contents, so a surface id cannot be spelled here and
 * missed in the render: adding an id to a list is what makes it a surface, and the compiler
 * finds the switch arm that has to handle it.
 */

/** The four primary surfaces, in navigation order. */
export const PRIMARY_SURFACES = [
  { id: 'home', label: 'Home' },
  { id: 'new-request', label: 'New Request' },
  { id: 'review', label: 'Review' },
  { id: 'settings', label: 'Settings' },
] as const;

export type PrimarySurfaceId = (typeof PRIMARY_SURFACES)[number]['id'];

/**
 * The advanced screens, kept reachable outside primary navigation.
 *
 * Each label is the one the screen already uses in its own heading, because these are the
 * names the browser tests and the runbooks refer to. Nothing here is part of the minimal
 * journey; the row is labelled as such in the shell so an owner who lands on it knows they
 * have left the MVP path.
 */
export const LEGACY_SURFACES = [
  { id: 'profiles', label: 'Profiles' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'brief', label: 'Brief' },
  { id: 'runs', label: 'Runs' },
  { id: 'dashboard', label: 'Needs you' },
  { id: 'plan', label: 'Plan' },
  { id: 'publication', label: 'Publication' },
] as const;

export type LegacySurfaceId = (typeof LEGACY_SURFACES)[number]['id'];

export type SurfaceId = PrimarySurfaceId | LegacySurfaceId;

/** The surface a signed-in owner lands on. */
export const DEFAULT_SURFACE: PrimarySurfaceId = 'home';