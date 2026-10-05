/**
 * The shell's navigation contract, as data rather than as JSX.
 *
 * ## Why this is a module and not a constant inside `App.tsx`
 *
 * Because it is a product promise rather than a layout detail. The owner was promised four primary
 * areas and Home as the default; that promise is checkable without a browser, and a list buried in
 * a component's body is not checkable without one. Keeping it here means a test can assert what the
 * navigation *is* — and, just as importantly, that the nine orchestration-heavy sections the shell
 * used to offer are not in it (mvp-spec 3).
 */

/**
 * The four primary areas.
 *
 * Closed on purpose. The shell switches on this union, so a fifth area cannot be rendered by
 * primary navigation without widening the union first — which is the point at which it becomes
 * visible that it is being added. That structural half plus the list below is what makes "four, not
 * nine" a property rather than a hope.
 */
export type PrimarySection = 'home' | 'request' | 'review' | 'settings';

/** The four primary areas, in the order the owner meets them. */
export const PRIMARY_SECTIONS: readonly { readonly id: PrimarySection; readonly label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'request', label: 'New Request' },
  { id: 'review', label: 'Review' },
  { id: 'settings', label: 'Settings' },
];

/** The section the shell starts on. Home, because the product opens on what needs attention. */
export const DEFAULT_SECTION: PrimarySection = 'home';

/**
 * The labels the shell must not offer.
 *
 * Kept as an explicit denylist rather than derived, because the failure mode is a *missing* entry:
 * a check written as "the list does not contain X" passes for every section nobody thought to name.
 * Each one here is a real section this shell used to expose, so its absence is a decision someone
 * can see rather than an omission nobody can.
 */
export const RETIRED_FROM_PRIMARY_NAVIGATION: readonly string[] = [
  'Profiles',
  'Connectors',
  'Intake',
  'Brief',
  'Runs',
  'Review card',
  'Needs you',
  'Plan',
  'Publication',
];