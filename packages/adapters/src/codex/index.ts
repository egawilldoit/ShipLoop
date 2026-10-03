/**
 * The Codex coding-engine adapter surface.
 *
 * Exported as a subpath so a consumer can import the Codex adapter without pulling in every
 * adapter. `README.md` beside these files records exactly which behaviour was proven against the
 * live `codex` binary on this host and which is proven only against captured output, which is the
 * distinction a provider claim has to make (mvp-spec 9, N05-AC2).
 */

export {
  CODEX_RESULT_CHANNEL_VERSION,
  CODEX_SANDBOX_MODES,
  CODEX_SEPARATE_CREDENTIAL_VERSION,
  CODEX_VERIFIED_VERSION,
  CodexClient,
  ENGINE_CREDENTIAL_FILE,
  ENGINE_CREDENTIAL_PROVISION_COMMAND,
  MAX_RESULT_BYTES,
  MINIMUM_CODEX_VERSION,
  buildArgv,
  checkCodexVersion,
  defaultEngineStateRoot,
  engineStateLayout,
  parseCodexVersion,
  prepareEngineState,
  resolveEngineAuthentication,
  resolveSandboxMode,
  stopCodexProcess,
  type CodexClientOptions,
  type CodexCredentialMode,
  type CodexEngineAuthentication,
  type CodexInvocation,
  type CodexProcess,
  type CodexResultChannel,
  type CodexResultRead,
  type CodexSandboxMode,
  type CodexSpawnRequest,
  type CodexStopReport,
  type CodexVersionVerdict,
  type EngineStateLayout,
} from './client.ts';

export {
  CODEX_MODELLED_EVENT_TYPES,
  codexUsageOf,
  finalizeCodexStream,
  initialCodexStreamState,
  readCodexUsage,
  translateCodexLine,
  translateCodexStream,
  type CodexFinalizeInput,
  type CodexLineTranslation,
  type CodexMalformedLine,
  type CodexStreamInterruption,
  type CodexStreamState,
  type CodexTerminal,
  type CodexTokenUsage,
  type CodexTranslationOptions,
} from './events.ts';

export {
  classifyCodexFailure,
  codexBlockedOutcome,
  codexBlockerFor,
  codexDiagnosticRetry,
  isCodexBlocker,
  mapCodexFailure,
  mapCodexVersionProbeFailure,
  type CodexBlocker,
  type CodexFailureInput,
} from './errors.ts';

export {
  CodexEngineAdapter,
  missingRolloutDetail,
  renderPrompt,
  type CodexEngineAdapterOptions,
} from './adapter.ts';
