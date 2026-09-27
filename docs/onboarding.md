# Local onboarding implementation

The first implementation slice has a Bun CLI (`cli/index.ts`), a separate Vite/React approval page (`web/`), a Cloudflare Worker (`service/worker.ts`), and D1 tables in `migrations/`. It supports login attempts, EIP-712 parent consent, locally signed EIP-7702 rescue authorizations, and read-only per-chain state for Ethereum (1) and Base (8453). The proposed public URL is `https://agent-wallet.stupidtech.net/approve/<attempt-id>?token=...`; no public service or package has been deployed.

## Run locally

```sh
bun install
# First build the existing Foundry contract artifact outside a sandbox if needed.
bun run generate:delegate
bun run db:local
bun run build
bun run dev:api
```

In another terminal:

```sh
bun cli/index.ts status
bun cli/index.ts login
```

The CLI defaults to `http://127.0.0.1:8787`, and accepts `AGENT_WALLET_URL` and `AGENT_WALLET_HOME` overrides. It stores its private key in an owner-only directory/file and the pending approval URL in an owner-only file; the key never leaves the host. `login` keeps polling after displaying the complete link. Restarting it reuses the pending key/attempt, or creates a new attempt after expiry. The page supports injected EIP-1193 wallets and Base Account; it asks for EIP-712 consent and does not request `wallet_addSubAccount`.

For development, Vite (`bun run dev`) proxies `/api` to Wrangler on port 8787, while the approval URL points to Wrangler's built static assets. Rebuild the static assets after editing the page. The checked-in D1 ID in `wrangler.jsonc` is **local-only**; create a real D1 database, replace the ID, apply migrations remotely, configure the deployment domain, and review production RPC availability before deploying.

## State and authority

1. `POST /api/challenges` issues a short-lived agent-key challenge for `login` or `finalize`. The CLI signs an origin-bound message; `POST /api/login` verifies it and returns a reproducible, retryable short-lived approval link.
2. The page reads only the attempt's public fields. Its `/preview` request computes the parent-specific CREATE2 address and expected runtime hash, inspects Ethereum/Base nonce, pointer, delegate and factory code, and shows chain-specific failures.
3. `POST /api/attempts/:id/consent` verifies a request-bound EIP-712 signature from the claimed EOA or ERC-1271 account on the selected chain before saving parent consent. Link-token possession alone cannot complete consent.
4. The CLI verifies the parent-bound delegate locally, signs the chain-agnostic nonce-0 authorization, signs a fresh finalize challenge, and posts both to `/authorization`. The API recovers the agent EOA signer, rechecks chain state and parent consent, and atomically stores the association and authorization. Signed artifacts are absent from attempt and account GET responses.
5. `GET /api/accounts/:agent` reports `ready` for a stored verified association and separately computes `pre-use`, `active`, or `unavailable` on each chain. `pre-use` means eligibility subject to live nonce/code checks, not that a lost-key rescue has executed. A plain nonce-0 transaction on an unactivated chain is still prohibited.

The account table is durable; login attempts expire after 30 minutes. The stored nonce-0 tuple is retained independently of per-chain activation. A parent reassignment flow, agent transaction preparation/broadcasting, funded relayer rescue, and public contract deployment/source verification remain release gates. The ERC-1271 verification path uses viem's onchain typed-data verification; the local end-to-end integration currently exercises EOA parents, not a live ERC-1271 parent.

## Checks

```sh
bun run format
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:integration # with bun run dev:api running and the local D1 migration applied
```

The unit test pins the same parent-specific identity as `production-account.md`. The integration scripts exercise failed signatures, duplicate consent, private-artifact response boundaries, an EOA approval through `ready`, and the real CLI's pending-to-ready flow against the local Worker/D1 and live Ethereum/Base read endpoints. They use ephemeral accounts and do not broadcast transactions.
