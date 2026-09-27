# Parent-bound agent delegate

`src/AgentAccount.sol` is a standalone EIP-7702 delegate with one constructor argument: the parent address. The parent is an immutable in the runtime code; there is no initializer, account storage, ERC-4337 dependency, or contract-level nonce. The agent EOA calls `executeBatch` on its own address with a signed transaction. The parent calls the same function to rescue ETH and tokens, including from a smart wallet. The EOA key can still authorize a different delegate, so parent access does not revoke the key.

OpenZeppelin's ERC-721 and ERC-1155 holders accept safe NFT transfers; EOA-key ERC-1271 validates raw hashes. Payable receive/fallback functions accept ordinary EOA-style transfers. A single-call batch covers single rescue operations. Every batch reverts atomically if an EVM call reverts. A token call that returns `false` without reverting is still an EVM success: the Agent Wallet service must verify actual asset balances/transfers before reporting rescue complete. This contract has no separate relayed operation-signature flow; agent operations use signed EOA transactions with chain and nonce replay protection. Agent Wallet preparation IDs/expiry are service-level checks and cannot invalidate raw signed bytes already disclosed to a third party.

## Reproduce

```sh
bun install
forge build
forge test
bun run typecheck
bun run lint
bun run account:fork
```

The fork runner uses current Ethereum and Base heads, Anvil, and RPC access (`ETHEREUM_RPC_URL` and `BASE_RPC_URL` override the defaults). It generates one ephemeral parent wallet shared across both forks and ephemeral agent/relayer/recipient wallets; it prints **only addresses and local transaction IDs, never private keys**. It verifies the factory, same parent-specific CREATE2 initcode/address and runtime code on both chains, nonce-drift rejection, a reverted outer execution leaving the pointer installed **followed by parent rescue**, pre-use parent-funded relayer activation/ETH rescue without agent signing after artifact creation, and agent-funded nonce-0/type-4 first use with authorization nonce 1 followed by a signed self-batch. Snapshot rollback separates mutually exclusive branches. No public deployment was made.

## Deployment identity is per parent

Use the same compiler settings and dependency versions from `foundry.toml` and `bun.lock` on every chain. With `factory = 0x4e59b44847b379578588920ca78fbf26c0b4956c` and 32 zero bytes of salt:

```text
initcode = AgentAccount.creationCode || abi.encode(parentAddress)
delegate = CREATE2(factory, salt, keccak256(initcode))
pointer  = 0xef0100 || delegate
```

Solc fills the runtime's zeroed immutable placeholders with the parent address at deployment. `scripts/account-fork.ts` reconstructs those bytes and compares the expected runtime hash against each fork's actual code. Before signing any cross-chain authorization, verify the exact constructor argument, initcode hash, deployer code, delegate address and runtime hash on every supported chain. **There is no universal delegate address.** Agents with the same parent can share a delegate implementation; different parents produce different delegate addresses. The account's EOA address is unaffected by which delegate it authorizes.

For one **ephemeral sample parent** `0x4Da8Be929434C6E88C24551eA45A57BBfECB5bD2` with Solc 0.8.30, optimizer 200, Prague EVM and `bun.lock` versions:

| Item | Local-fork sample value |
| --- | --- |
| Parent-specific initcode hash | `0x857a0f9cd205285333e8ca40382acd5d9ed4f2a689e87f2849981684669afb0d` |
| Parent-specific delegate address | `0x75Fd7BDe8eE7a2142845af57f52694C6B744d051` |
| Parent-specific runtime hash | `0x7114fc38fc0a23cafdd9c1283251f1f6053da52c95c3a429368a79b2bef82953` |

This sample is not a hardcoded product address. A fresh run generates a new parent and therefore new initcode/address/runtime hashes.

Sample **local-only** transactions at Ethereum block `26070714` and Base block `51873016`:

| Chain | CREATE2 deployment | Reverted activation (pointer persists) | Rescue after revert | Nonce-0 rescue activation | Parent rescue | Agent-funded first use | Agent self-batch |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Ethereum | `0x46a4e9ea7ef6568399fe7521fd0069c01e2177d9cc26df3620ae81038d96776d` | `0x04c69fa678d99cc0ade146574eeabe5274036eb96bcb749f84ee03a52e7524e4` | `0x983746171602f9194e7da659220d008a6e94cb6db7b5d3ec6b56b056a25fd739` | `0x2f3746b0771ac3efe956e01b2bffa3615d9bf711b009ffa17750c275c5bc60f7` | `0xaf2447841cd9c808522d1a2d8cdef890d9172a0a3215d6d9b65bdaa9988f5594` | `0x9096a3c4d8194b92efbb81c666601b319f3022102ec5f243dac39ce048ebab49` | `0xd02852aacfb5002f6ef1a4872ba9ddd9e5a6b665c4451dbadc501c878a13c9da` |
| Base | `0x3a62a5eb12dd2caa1e3c1e70e7e5dd89e56b804f5f9b337cadc090f5f779b83d` | `0x40a08c36d90b9ecbb922184727ede7ecbe3a2016bbe0d1acc42809d45e6a468d` | `0xc9ef19152192854a01ea08d10f584713c4982e55473285601a17a5b57eff4d90` | `0xcefc6f9d628bee7115314c356c51e5f5f7cdcb6397374476fb2f244494a5bbd3` | `0xef666cb4f9c08cc4dbc420e5790c122074bd7bb2acf32f5a9d316518dea82c15` | `0x6cd810723123993e9cf7936bb84fb84d2bd3a68fff561ae6cfe9795c303e29e6` | `0x92c4208642539d24b0852386ae993031ed40f1151bc6f9b0781ca79407243554` |

## Onboarding and rescue

1. Create and retain the local agent EOA key. Create a login attempt; **do not sign a nonce-0 7702 authorization yet** because the parent-specific delegate cannot be derived before the parent is known.
2. The parent opens the bespoke Agent Wallet approval URL and connects with a wallet distinct from the agent EOA. Compute the delegate from their address, present it in the approval, and verify fresh typed-data consent binding the parent, agent, delegate, Agent Wallet origin, attempt and expiry. Check chain support and deterministic deployability.
3. The agent signs a chain-agnostic (`chainId = 0`) nonce-0 EIP-7702 authorization to the computed delegate; the Agent Wallet API verifies and durably stores it with the consent. There is no separate initialization proof. Mark `ready` only after the artifact is stored and verified; activation remains per chain.
4. For pre-use rescue while the agent's chain nonce is still 0, the parent funds the relayer; it installs the exact parent-specific code and submits a type-4 transaction carrying the saved authorization. The parent calls `executeBatch` on the delegated agent EOA. If an authorization execution reverts, inspect the pointer/nonce: the pointer may persist. If the nonce drifted first, the saved authorization cannot activate that chain.
5. For first agent-funded use, use an outer type-4 transaction from the EOA at nonce 0 with a fresh authorization at nonce 1 and deploy the parent-specific delegate through CREATE2. After verifying the pointer/runtime/parent, subsequent agent EOA transactions call `executeBatch` on itself. Never spend nonce 0 with a plain transaction on an unactivated chain.

Before creating any new authorization, the Agent Wallet service must inspect the account's existing delegation and nonce. In particular, the old shared/delegated account addresses and initialization proofs from earlier local prototypes do **not** apply; no public accounts used them. The user cannot change the parent without the agent EOA key signing a new authorization for a new delegate address. Treat onchain code/nonce checks, consent verification, transaction preparation, funded rescue relaying, and receipt confirmation as service gates, not properties conferred by a stored signature alone.

## Remaining release gates

This standalone contract is unit-tested and exercised on two local chain forks, but has **not** been independently audited, source-verified at a public explorer, or publicly deployed. The dedicated Agent Wallet frontend/API now have a local onboarding path through durable association/artifact storage and EOA parent-consent verification; see `onboarding.md`. Live ERC-1271 onboarding, broader chain/wallet support, exact raw transaction preparation/verification, receipt/state verification, and funded rescue relaying remain release gates. Review the delegate and integrations before using valuable assets.
