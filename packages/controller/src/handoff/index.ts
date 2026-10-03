/**
 * The external-execution handoff: what an implementer outside ShipLoop is told, and
 * where the external T3 deployment is configured to be opened.
 *
 * The two pure modules are deliberately narrow. `implementation-packet.ts` renders text
 * from an approved Delivery Contract and holds no state; `t3-launch.ts` resolves one
 * configured URL and contacts nothing. Neither imports a coding runtime, a provider
 * SDK, or any T3 internal interface, because the MVP's T3 support is a fallback
 * context packet and a link (mvp-spec L02-AC3) rather than a session-control API.
 *
 * `handoff.ts` is the third file and the only one that reads storage: it loads an approved
 * revision, refuses anything else, and joins the packet with the optional T3 state into
 * the one answer a caller needs. The other two stay pure so either half can be asserted
 * without a store.
 *
 * `README.md` in this directory records how the owner UI is expected to call all three.
 */
export * from './implementation-packet.ts';
export * from './t3-launch.ts';
export * from './handoff.ts';