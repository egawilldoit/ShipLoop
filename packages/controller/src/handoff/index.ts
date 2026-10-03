/**
 * The external-execution handoff: what an implementer outside ShipLoop is told, and
 * where the external T3 deployment is configured to be opened.
 *
 * Both modules here are deliberately narrow. `implementation-packet.ts` renders text
 * from an approved Delivery Contract and holds no state; `t3-launch.ts` resolves one
 * configured URL and contacts nothing. Neither imports a coding runtime, a provider
 * SDK, or any T3 internal interface, because the MVP's T3 support is a fallback
 * context packet and a link (mvp-spec L02-AC3) rather than a session-control API.
 *
 * `README.md` in this directory records how the owner UI is expected to call both.
 */
export * from './implementation-packet.ts';
export * from './t3-launch.ts';