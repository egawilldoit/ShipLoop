# Verification tooling

Read root [AGENTS.md](../AGENTS.md) and [TESTING.md](../TESTING.md).
These Node ESM tools have no runtime dependencies and run on Linux/Node 24.

- Keep doctor usable without pnpm or application dependencies.
- Spawn argument arrays without a shell. Validate positive bounded timeouts/output limits.
- Track owned process groups at spawn; preserve deadlines even when descendants retain pipes.
- Never inherit provider credentials into offline checks. Reports must not dump environment values.
- Missing executable/configuration is Blocked; nonzero exit/timeout is Failed.
- Never report a foundation pass as application verification.
- Test the registered CLI/report behavior as well as the subprocess helper.
- Process tests use real owned subprocesses and temporary files; do not fake host OS support.
- Keep artifacts out of Git. Preserve a failed run before trying a diagnosed repair.
