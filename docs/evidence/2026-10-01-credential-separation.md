# Credential separation on this VM — measured 2026-10-01

**Status:** F03-AC5 and N02-AC3 are **not** enforced at the process boundary. A coding
agent this product spawns holds the owner's GitHub and Linear credentials in readable form.
The only thing that currently stops it from using them is the Codex sandbox's network
restriction, not any separation ShipLoop performs.

Nothing in this document changed a live setting, created a token or installed anything. Every
command below is read-only apart from one bounded `codex exec` run in a scratch directory,
which was asked to read files and to run one `git ls-remote` and nothing that writes.

## How this was measured

All commands ran from the task worktree `/tmp/opencode/wt/p4del-a` on the VM as the `ubuntu`
user, which is the same identity the worker and the engine subprocess run as.

The decisive experiment is section 2. Sections 1 and 3 are the live facts and the design
conclusion; section 2 is the answer to the question the specification actually asks.

---

## 1. The live facts, verified again on 2026-10-01

### 1.1 The GitHub identity is an administrator

```console
$ gh auth status
github.com
  ✓ Logged in to github.com account MORTAKI0 (/home/ubuntu/.config/gh/hosts.yml)
  - Active account: true
  - Git operations protocol: ssh
  - Token: gho_************************************
  - Token scopes: 'admin:public_key', 'gist', 'read:org', 'repo'

  X Failed to log in to github.com account abdelilahmortaki (/home/ubuntu/.config/gh/hosts.yml)
  - Active account: false
  - The token in /home/ubuntu/.config/gh/hosts.yml is invalid.
  - To re-authenticate, run: gh auth login -h github.com
  - To forget about this account, run: gh auth logout -h github.com -u abdelilahmortaki
exit=1
```

```console
$ gh repo view --json nameWithOwner,defaultBranchRef,viewerPermission
{"defaultBranchRef":{"name":"main"},"nameWithOwner":"egawilldoit/ShipLoop","viewerPermission":"ADMIN"}

$ gh api repos/:owner/:repo/branches/main/protection
{"message":"Branch not protected","documentation_url":"https://docs.github.com/rest/branches/branch-protection#get-branch-protection","status":"404"}
gh: Branch not protected (HTTP 404)

$ gh api repos/:owner/:repo/rulesets
[]
```

```console
$ gh api repos/egawilldoit/ShipLoop --jq '{allow_merge_commit,allow_squash_merge,allow_rebase_merge,allow_auto_merge,delete_branch_on_merge,default_branch}'
{"allow_auto_merge":false,"allow_merge_commit":true,"allow_rebase_merge":true,"allow_squash_merge":true,"default_branch":"main","delete_branch_on_merge":false}

$ ssh -T -o BatchMode=yes -o StrictHostKeyChecking=accept-new git@github.com
Hi MORTAKI0! You've successfully authenticated, but GitHub does not provide shell access.
ssh exit=1
```

So: `main` is unprotected, there are zero rulesets, all three merge methods are enabled, the
`ssh` transport authenticates as the same administrator account, and that account is the one
`gh` uses.

### 1.2 The environment

```console
$ for v in GH_TOKEN GITHUB_TOKEN LINEAR_API_KEY SSH_AUTH_SOCK GITHUB_PAT CODEX_API_KEY; do ...; done
GH_TOKEN=UNSET
GITHUB_TOKEN=UNSET
LINEAR_API_KEY=SET len=48
SSH_AUTH_SOCK=UNSET
GITHUB_PAT=UNSET
CODEX_API_KEY=UNSET

$ ls -la /home/ubuntu/.config/gh/ /home/ubuntu/.ssh
-rw-------  1 ubuntu ubuntu  824 Aug 12 15:15 config.yml
-rw-------  1 ubuntu ubuntu  298 Sep 13 18:19 hosts.yml      # holds the gho_ token
-rw-------  1 ubuntu ubuntu  400 Feb 28  2026 authorized_keys
-rw-------  1 ubuntu ubuntu  399 Mar 31  2026 id_ed25519     # the key ssh -T just used
```

`LINEAR_API_KEY` is a real 48-character `lin_…` key in the process environment. There is no
ssh-agent socket, so agent forwarding is not the exposure — the private key file is readable
directly, and the owner is the same uid the worker runs as.

---

## 2. What a worker spawned by this product can reach

### 2.1 The spawn passes no environment, so the child inherits everything

`packages/adapters/src/codex/client.ts:406` is the only place this product creates the
process:

```ts
export function spawnTrackedGroup(argv: readonly string[], cwd: string): Result<CodexProcess> {
  let child: CodexChildProcess;
  try {
    child = spawn(argv[0] ?? '', [...argv.slice(1)], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
```

There is no `env` option. Node's `spawn` therefore gives the child a copy of
`process.env`, and the child runs as the same uid with the same `$HOME`. The sandbox the
product requests is `workspace-write`
(`packages/adapters/src/codex/client.ts:58`, `apps/worker/src/config.ts`), which restricts
*filesystem writes*, not *reads of the credential files* and not *inherited environment
variables*.

### 2.2 What the spawned child can see and do, through the product's own spawn function

A Node script called the product's real `spawnTrackedGroup` with a probe child:

```console
$ node --experimental-strip-types packages/controller/src/__credprobe.ts
{
  "pid": 2885981,
  "env": {
    "GH_TOKEN": "ABSENT",
    "GITHUB_TOKEN": "ABSENT",
    "LINEAR_API_KEY": "PRESENT(len=48)",
    "SSH_AUTH_SOCK": "ABSENT",
    "OPENAI_API_KEY": "ABSENT",
    "GITHUB_PAT": "ABSENT"
  },
  "readable": {
    "/home/ubuntu/.config/gh/hosts.yml": "READABLE",
    "/home/ubuntu/.ssh/id_ed25519": "READABLE",
    "/home/ubuntu/.codex/auth.json": "READABLE",
    "/home/ubuntu/.codex/config.toml": "READABLE"
  }
}
```

And, from that same child, using only what it had already read:

```console
$ node --experimental-strip-types packages/controller/src/__credprobe.ts
{
  "gh auth status (full)": "github.com\n  ✓ Logged in to github.com account MORTAKI0 (/home/ubuntu/.config/gh/hosts.yml)\n  - Active account: true\n  - Git operations protocol: ssh\n  - Token: gho_************************************\n  - Token scopes: 'admin:public_key', 'gist', 'read:org', 'repo'\n",
  "git ls-remote over ssh (read-only, from spawned child)": "SUCCESS; first line: 5452c8a1ab5d6d9569b47f618197c72224b55f8f\trefs/heads/chore/agent-development-foundation",
  "LINEAR_API_KEY used for a live API call from spawned child": "{\"data\":{\"viewer\":{\"id\":\"d4cdf91d-509f-4927-8e42-b5885d6d6983\",\"name\":\"MORTAKI ABDELILAH\",\"email\":\"ab.mortaki@gmail.com\"}}}"
}
```

That is the answer to the decisive question, and it is not a maybe:

- the engine subprocess **inherits `LINEAR_API_KEY`** and made a **live authenticated Linear
  API call** as the owner;
- it **read the `gho_` token** out of `~/.config/gh/hosts.yml` and `gh` used it;
- it **authenticated to GitHub over SSH with the operator's private key** and listed the
  real repository's refs.

Nothing was blocked, because nothing was ever separated.

### 2.3 Inside a real `codex exec`, under the sandbox this product grants

The same question asked from inside the engine, with the exact argv the adapter builds
(`exec --sandbox workspace-write --cd <workspace> --json -m gpt-6-luna -- <prompt>`):

```console
$ codex exec --sandbox workspace-write --cd /tmp/opencode/credprobe/ws --json -m gpt-6-luna -- "$(cat prompt.txt)"
item_1 command_execution:
  if [ "${LINEAR_API_KEY+x}" = x ]; then printf 'LINEAR_API_KEY_SET length=%s\n' "${#LINEAR_API_KEY}"; ...
  → LINEAR_API_KEY_SET length=48
    GH_TOKEN_UNSET
    GITHUB_TOKEN_UNSET

item_2 command_execution:
  if [ -r /home/ubuntu/.config/gh/hosts.yml ]; then ... grep -q 'gho_' ...; fi
  if [ -r /home/ubuntu/.ssh/id_ed25519 ]; then printf 'id_ed25519=%s\n'; fi
  → readable=yes gho_=yes
    id_ed25519=yes

item_3 command_execution:
  git -c credential.helper= ls-remote --heads git@github.com:egawilldoit/ShipLoop.git
  → ssh: Could not resolve hostname github.com: Temporary failure in name resolution
    fatal: Could not read from remote repository.

agent_message: 1. LINEAR_API_KEY: set, length 48 … 3. Readable: yes; "gho_" appears: yes.
                4. Yes. 5. Could not resolve hostname github.com.
```

A second bounded run probed the write scope and the network:

```console
$ codex exec --sandbox workspace-write --cd /tmp/opencode/credprobe/ws --json -m gpt-6-luna -- "$(cat prompt2.txt)"
$ touch /home/ubuntu/.codex/shiploop-write-probe && echo WROTE_HOME || echo BLOCKED_HOME
  touch: cannot touch '/home/ubuntu/.codex/shiploop-write-probe': Read-only file system
  BLOCKED_HOME
$ touch /tmp/shiploop-write-probe && echo WROTE_TMP || echo BLOCKED_TMP
  WROTE_TMP
$ gh api user --jq .login
  error connecting to api.github.com
  check your internet connection or https://githubstatus.com
$ curl -s -o /dev/null -w "%{http_code}" https://api.github.com ; echo
  000
$ getent hosts api.github.com || echo NO_DNS
  NO_DNS
```

Read that carefully, because it is the whole finding:

- **What the sandbox does stop:** writes outside the workspace (`$HOME` is read-only), and
  **all network egress** — no DNS, no HTTPS, so `gh`, `git`, `curl` and the Linear API all
  fail from inside the sandbox.
- **What it does not stop:** reading the `gho_` token, reading the SSH private key, and
  inheriting `LINEAR_API_KEY` in the environment. The credentials are *present and readable*
  inside the sandbox. It is the network restriction, not credential separation, that keeps
  them unusable today.

### 2.4 What this means for F03-AC5 and N02-AC3

F03-AC5 says the coding role receives no production deployment credential and no
unrestricted release tool. N02-AC3 says a coding-stage attempt to invoke production delivery
is denied by a *tested* capability boundary.

Today the boundary is real but **partial and indirect**:

- it holds at the *type and capability* level — `PRIVILEGED_CAPABILITY_KINDS` in
  `packages/adapters/src/contracts/index.ts` removes `Git:MergeWithPrecondition` and
  `Deployment:Execute` from a `CodingSessionCapability` by construction, and the domain
  refuses a privileged grant to a non-owner role;
- it does **not** hold at the *process* level. The model is not merely denied the capability:
  it holds the credentials that would let it bypass the capability entirely, and only the
  sandbox's network isolation stands between it and a repository push or a Linear write.

Any of these converts the latent exposure into a live one: enabling network access for the
sandbox (a normal thing to want for dependency installs), a proxy the model can reach, a
sibling process it can talk to, or a future `danger-full-access` configuration on the host.
Note also `/home/ubuntu/.codex/config.toml` on this host sets `sandbox_mode =
"danger-full-access"` and `approval_policy = "never"` for trusted projects, which includes
`/home/ubuntu/projects/ShipLoop`; the adapter's `--sandbox` flag currently overrides that for
a fresh `codex exec`, but nothing in the product would stop a configuration that did not.

---

## 3. The broker design that would actually enforce F03-AC5 / N02-AC3

Three changes, and the third is the one that makes the first two sufficient.

### 3.1 A scrubbed spawn environment

`spawnTrackedGroup` must pass an explicit `env`, never inherit. The child gets an allowlist,
not a denylist:

- `PATH`, `HOME`, `LANG`, `TZ`, `TMPDIR`;
- the variables the engine itself needs to run (`CODEX_*`, and whatever `codex` reads for its
  own auth — which is the point of 3.2);
- `SHIPLOOP_WORKSPACE`, `SHIPLOOP_CORRELATION_ID`, `SHIPLOOP_OPERATION_ID` and the
  workspace's own service endpoints, which is what the engine legitimately needs.

Everything else is dropped, including `LINEAR_API_KEY`, `GH_TOKEN`, `GITHUB_TOKEN`, `GIT_*
` and `SSH_AUTH_SOCK`. A denylist of known credential names is not enough: the environment
is not the only channel.

### 3.2 A separate credential the worker never holds, plus filesystem separation

Two halves, and both are needed:

- **Separate identities.** The coding worker needs a GitHub identity scoped to *its* work:
  push to feature branches on this repository, pull requests, nothing else — and above all
  no `admin:repo_hook`, no write to `main`, no ability to bypass branch protection. Today the
  one identity on the host is `repo`-scoped, is an `ADMIN` on the repository, is authenticated
  by a key that can push to `main` directly over SSH, and is the same identity a human uses
  interactively. That identity must not be in the worker's reach.
- **A home the worker cannot read.** Because the worker runs as the same uid, no amount of
  `env` scrubbing helps: anything under `$HOME` is readable. The engine must run under a
  different uid, or with a mount namespace that hides `~/.config/gh` and `~/.ssh`, or inside a
  container that has none of them. This is the change with the largest operational cost and it
  is the one that makes 3.1 and 3.3 real.

### 3.3 A broker that performs the privileged write

The controller, not the worker, performs every privileged write — and the worker's only route
to one is an authenticated request to the broker:

- The worker gets a **short-lived, single-purpose delivery token** scoped to one operation
  (one candidate, one action, one destination), minted by the controller and invalidated when
  the operation settles. The worker never holds a GitHub token, an ssh key, a deployment
  credential, or the database.
- The **broker** — the controller's delivery use case, i.e. `delivery.ts` in this repository —
  is the only component that holds a merge or deployment credential. It re-reads live provider
  state, checks the owner authorization against the freshly read subject, records the intent,
  and performs the write. A worker request is a *request to be authorized*, never a request to
  bypass authorization.
- The broker is **outside the sandbox and outside the worker's uid**, so a model that
  compromises the worker process still has nothing to use.
- The provider side should help: `main` needs a branch protection rule or a ruleset requiring
  the review and status checks F26-AC5 describes, so a leaked `repo` token cannot merge
  without them even if it is used. Today `main` is unprotected with zero rulesets, which means
  the *only* thing standing between a leaked token and production is this product's own gate.

---

## 4. What is needed from the owner

Ordered by what unblocks the most, cheapest first. Nothing here was done as part of this
investigation.

### 4.1 Immediate, no code change, closes the worst case

1. **Decide whether this VM is a throwaway.** If the repository is private and the history has
   nothing the owner cannot reconstruct, a leaked admin-scoped token is recoverable. If not,
   treat it as already exposed: rotate the `gho_` token in `~/.config/gh/hosts.yml` and the
   `id_ed25519` key now, before anything else.
2. **Protect `main`.** Add a branch protection rule or a ruleset on `egawilldoit/ShipLoop`
   requiring pull requests, at least one approving review that is not the author, and the
   required status checks, and disallow direct pushes. Optionally disable the merge methods
   the project does not use. This does not fix F03-AC5, but it converts "a leaked admin token
   merges anything" into "a leaked admin token has to go through review".
3. **Remove the second, invalid `gh` account** from `~/.config/gh/hosts.yml` (`gh auth logout
   -u abdelilahmortaki`). It is not an exposure, but `gh` prints its failure on every
   invocation, which is exactly the kind of noise that trains people to ignore credential
   output.

### 4.2 Credential separation the product depends on

4. **Mint a separate GitHub identity for ShipLoop's coding worker**, scoped to this repository,
   with push limited to non-protected branches and no administrative scopes. The operator's
   personal admin token and ssh key stop being the worker's credential. Whether that is a
   GitHub App installation token, a fine-grained personal access token, or a dedicated
   machine user is the owner's call; the requirement is the scope, not the mechanism.
5. **Mint a separate Linear key** for ShipLoop, scoped to the operations the product actually
   needs, and remove `LINEAR_API_KEY` from the environment the worker is started with. The key
   the product's own publication path uses does not have to be the same key.
6. **Decide the process isolation model**: a dedicated uid for the engine, or a container, or a
   mount namespace. This is the decision with the largest cost and it gates 3.2's second half.
7. **Decide the network policy for the coding sandbox.** If the engine needs network access to
   install dependencies, say so explicitly and plan for it, because with network access the
   current exposure becomes a live one immediately. The options are a proxy allowlist, or
   pre-baked dependency images, or accepting the risk knowingly.

### 4.3 Product work this investigation implies (not done here)

8. Pass an explicit scrubbed `env` from `spawnTrackedGroup`.
9. Make the capability boundary deny at runtime, not only in the type: the engine request
   path should have no credential to use even if the boundary is bypassed.
10. Add a test that asserts the engine subprocess environment contains no credential-shaped
    variable and cannot read the operator's credential files. It will fail today, which is the
    point: N02-AC3 asks for a *tested* boundary and this is the test that is missing.
11. Have `packages/worker` refuse to start with `danger-full-access` in the host Codex
    configuration for a ShipLoop workspace, rather than relying on the CLI flag to win.

---

## 5. Reproducing this

The probes were scratch scripts under `/tmp/opencode/credprobe/` and are not committed. The
two commands that matter, from the task worktree:

```console
# the product's own spawn function, given a probe child
node --experimental-strip-types <probe>.ts

# the engine, with the argv the adapter builds
codex exec --sandbox workspace-write --cd <scratch-workspace> --json -m gpt-6-luna -- "<read-only probe>"
```

Both were read-only apart from `touch /tmp/shiploop-write-probe` and a
`touch /home/ubuntu/.codex/shiploop-write-probe` that the sandbox refused. The temporary
workspace and probe scripts live under `/tmp/opencode/credprobe/`; the file
`/home/ubuntu/.codex/shiploop-write-probe` does not exist, which the `Read-only file system`
error above confirms.
