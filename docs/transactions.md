# Local agent transaction flow

The CLI accepts an ordered atomic batch for a requested EVM chain ID, subject to its live EIP-7702 and deterministic deployment prerequisites. For example, save `[{"to":"0x...","value":"1000000000000000","data":"0x"}]` to `calls.json` and run:

```sh
bun cli/index.ts send 8453 calls.json
# Or pipe JSON to: bun cli/index.ts send 8453 -
# Optional last argument caps the maximum transaction gas cost in wei.
bun cli/index.ts resume op_<id>
```

`value` is a decimal wei string, `data` defaults to `0x`, and `value` defaults to `0`. The CLI uses only its owner-only local EOA key. It prints the operation ID and saves the original calls, challenge and chain in an owner-only local file under `AGENT_WALLET_HOME/operations/` before signing. `resume` looks up that file by ID so it can independently verify the backend's preparation without requiring the calls file again. Keep the same `AGENT_WALLET_HOME` when resuming. `AGENT_WALLET_URL` has the same meaning as during login.

## Preparation and submission

1. `POST /api/operations/challenge` accepts `{ agent, chainId, calls }` and returns an operation ID, challenge and canonical message. The CLI verifies the message against its own calls and signs it. `POST /api/operations/:id/prepare` verifies agent control and produces a five-minute exact transaction preparation. A single live prepared/broadcast operation per agent and chain prevents concurrent nonce reservations.
2. On a pre-use chain, the first preparation is a chain-specific nonce-1 authorization and an outer nonce-0 type-4 transaction. The outer transaction deploys the parent-bound delegate through the verified CREATE2 factory when absent, or activates an existing deployment. The CLI checks parent/delegate identity, deployment calldata, chain, nonce, and gas bound before signing the authorization and raw transaction. The onboarding **chain-agnostic nonce-0 rescue authorization is not used**. A missing factory, unexpected delegation, or nonce drift fails preparation.
3. `POST /api/operations/:id/submit` recovers the EOA signer, validates every signed field and authorization against the durable preparation, and stores signed bytes/hash privately before broadcasting. Duplicate requests with identical raw bytes are retryable; another signed transaction is rejected. `GET /api/operations/:id` returns public status and unsigned current-phase preparation, never stored signed bytes or the rescue artifact. Its random ID is not parent or agent authority.
4. After a successful activation receipt, the service verifies the pointer, runtime code and immutable parent, and prepares a fresh `executeBatch` transaction at the live nonce. The CLI checks the encoded calls against its original JSON and signs the raw EOA transaction locally. An already active chain starts at this step. Each batch executes atomically at the delegate level; service status reports inclusion or revert from the receipt, not from a submission hash.

An activation execution revert can still leave a delegation pointer. This is recorded as `partial` and never automatically advances to the batch. An unverified pointer, missing delegate or wrong parent likewise stops execution. If the agent runs out of gas between activation and batch preparation, the operation reports the required funding and can be resumed using its ID on the original host. A preparation expires after five minutes; its expiry is an API submission gate, not an onchain cancellation of raw bytes that were already signed.

Interruption handling is deliberately narrow: run `resume <id>` to read the recorded state and continue the same operation. An uncertain submission can only resend the identical signed bytes; a pending transaction is left pending, without automatic gas replacement. Included batches are reported without another transfer. Reverted, partial, failed or expired operations stop with an explicit result; starting a new `send` is a separate decision after inspecting the chain state.

## Bridging from the agent

The agent can bridge or swap its own balances by calling an onchain application interface adapter. Prepare the call with the adapter's `prepare` capability for the agent account and chain, then pass the returned calls (target, value, calldata) to `send` as a normal batch. The relay bridge adapter on Base is `0x4Ab46c803B53EF51E9813C512De7CceF6214Ea92`; a Base-to-Optimism native bridge prepared one deposit call to the relay router. The first agent transaction on a chain is still the type-4 activation, so a bridge from a pre-use agent deploys and activates the delegate in the same operation before the deposit executes. A quote carries a `validUntil`; prepare and send promptly, and re-prepare if it expires.

## Verify locally

```sh
bun run format
bun run lint
bun run typecheck
bun run test:operations
```

`test:operations` uses ephemeral agent/parent keys, a temporary D1 database, the real CLI and Ethereum, Base and Optimism Anvil forks. It exercises nonce-1 first use, CREATE2 deployment, receipt-verified batch execution, active-chain batches, ID-only CLI resume after activation submission with locally stored calls, wrong agent proof, wrong authorization nonce, altered signed transaction fields, duplicate submission and a reverted atomic batch. The Optimism run verifies the chain-ID-based RPC/factory path and the real CLI's type-4 activation plus batch on a third fork; its transaction hashes are **local-only**. Agent-funded first use and batch execution have also been verified on public Base and Optimism, including a relay bridge batch. A separate published-npm-CLI live Base test exposed a post-activation stale-RPC race: after an included activation advanced the nonce to 2, the Worker briefly prepared the batch at nonce 1 and correctly rejected its submission. The Worker now waits for the known post-activation nonce before preparing the batch, and re-prepares an unbroadcast batch in place only if its signed nonce has been **mined**; a fork regression holds an intervening transaction pending, verifies the stale plan cannot skip it, then mines it and verifies `resume` completes the original calls. The already-expired live operation could not be resumed, but a fresh published-CLI batch on the active agent succeeded after this Worker deployment. Fee policy, broader replica/reorg handling, and further chain validation remain release gates.
