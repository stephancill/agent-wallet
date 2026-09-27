# EIP-7702 protocol spike: Ethereum and Base

This document records the original `SpikeDelegate` fixture and its historical initialization-proof design. The current standalone account instead embeds the parent in CREATE2 constructor initcode and uses **no** initializer; see `production-account.md` for current verification. The nonce and factory behaviors tested here remain relevant.

## Run

Requires Bun, Foundry (`forge` and `anvil`), and RPC access to Ethereum (1) and Base (8453).

```sh
bun install
forge build
bun run typecheck
bun run lint
bun run spike
```

Override `ETHEREUM_RPC_URL` and `BASE_RPC_URL` if needed. `bun run spike` starts two local Prague Anvil forks, executes transactions on each fork, asserts all intermediate states, prints JSON, and stops the forks. It generates ephemeral local keys in memory and does not print or save them. There is no public network deployment. The contract in `src/SpikeDelegate.sol` is **only a protocol fixture**, not a production account: it demonstrates authenticated parent initialization and ETH rescue, but does not implement batch operations, replay protection, ERC-1271, token rescues, or a reviewed production storage/authorization design.

## Pinned deployment identity

| Item | Value |
| --- | --- |
| CREATE2 deployer | `0x4e59b44847b379578588920ca78fbf26c0b4956c` |
| Deployer runtime hash | `0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989` |
| Salt | 32 zero bytes |
| Initcode hash (Solc 0.8.30, Prague, optimizer 200) | `0x5402ca01dd87e53c63aa8074f626f16c779dd13164bdb018ea12b479443da495` |
| Delegate address | `0x178473Ea4dcDe2519C0D80110D2D28E301B51F42` |
| Delegate runtime hash | `0x4136f829e1a8cba34358eaf145133e7f8e5a0c3eccbe7e7105c64f7bfd70d2f0` |

The runner checks each pin before execution and compares the exact deployer runtime bytes from both upstream chains. CREATE2 uses the pinned deployer, salt, and initcode. A 7702 authorization points to the **address**, so a runtime-code check is a separate prerequisite on each chain. The EOA's `eth_getCode` after authorization is the 23-byte `0xef0100 || delegate` pointer, not the implementation bytecode.

## What the forks prove

1. At upstream Ethereum block `26070438` and Base block `51871348` (sample run), the deployer has identical code. To exercise the missing-deployer branch despite its already existing on both live chains, the runner clears its code and nonce and resets the known public deployment signer's nonce **on each fork only**. A parent-funded relayer funds that signer and replays the published chain-agnostic legacy raw transaction; the expected deployer code returns. The original raw transaction hash is `0xeddf9e61fb9d8f5111840daef55e5fde0041f5702856532cdbb5a02998033d26` on both forks.
2. The agent signs an authorization for `chainId = 0, nonce = 0` and a distinct agent-key signature over account address, parent address, and delegate identity. With no agent signing in the rescue branch, the relayer deploys the delegate with CREATE2, includes the saved authorization in a type-4 transaction and initializes with that proof. The parent can then rescue ETH to a recipient. Wrong-parent initialization reverts, but the 7702 pointer and incremented authorization nonce persist; a subsequent correct proof succeeds. A separate snapshot confirms successful authorization and initialization in the same transaction.
3. A forked-away plain agent nonce-0 transaction makes the saved nonce-0 authorization invalid. Submitting it afterward executes the outer transaction but does **not** install the pointer or initialize the account. This is a critical fail-closed state check, not a rescue success. A rescue exceeding the account balance reverts.
4. From an independent snapshot before delegate deployment, an agent-funded outer **type-4 transaction at nonce 0** includes a fresh chain-specific authorization at **nonce 1** and calls the CREATE2 deployer. Both chains leave the pointer at the agent EOA, the intended runtime code at the same delegate address, and agent nonce 2. The agent pays gas from its own balance.

### Sample local-only transaction IDs

These are local fork transaction IDs, **not public explorer transactions**. Snapshot rollback means some listed branches are mutually exclusive and no longer coexist in the final fork state. Fresh random test accounts produce different hashes each run.

| Chain | CREATE2 rescue deployment | Reverted init (pointer persists) | Parent rescue | Direct auth + init | Agent-funded nonce-0 type-4 deployment |
| --- | --- | --- | --- | --- | --- |
| Ethereum (1) | `0x07585b9dd233d5220698e86352f24fefbe9a2812e78f304188527b099ffe6596` | `0x9ea0ad343ed4123cb5a616cc6b5477121473b5b7563ac7e468a1a164c2def680` | `0x48cf2290c699cef3f3394c383f4b6531be780dfed39d8af227bca007dd9b59df` | `0x8b244f0779d961aa5e63d7486c050952a6042e4dbbaf8ee079b22c7c555d3731` | `0xfbb9d4c3c5e47993ef8f445af225a1bd44eb603aca489e081b19d0f867313e84` |
| Base (8453) | `0x9233163755c2f9401f7e8b0ca216dfa963f6d1ddff036eefb63724923f382a7d` | `0xf46ce795143ef24f3c2002c85f38753bf960a54f9e7856582f03bb425eb77c1c` | `0x7a70774dd9c156e66783022939e5615871e57fb3dd8478fc5b4af0312be3feb2` | `0xfa502be4144e26aa1d7e5a0993e89eb7fc06194d3c16a197917ed39522d8dddd` | `0xb0c176fdf8280a0412a7a1ae09a8074e13353068b08f0d72881d8bc52c04adb5` |

## Limits and next gate

The bootstrap simulation resets state with Anvil-only methods. It proves that the **published raw deployment** creates the correct factory on both chain EVMs when the factory address is empty and the one-time signer nonce is zero, but it does not prove a missing factory can be installed on an arbitrary live chain: check its signer nonce, target address, gas/pricing, and chain rules before claiming support. In the sampled live upstream states the factory already exists, so no bootstrap is needed there. The fixture source is compiled and locally bytecode-checked, **not source-verified at a public explorer**. Local EOA onboarding now has an independent integration test (`onboarding.md`); public end-to-end approval, ERC-1271 parent consent, relayer quote/settlement, and production deployment/source verification remain separate delivery gates.

References: [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702) (tuple hash `0x05 || rlp([chainId, address, nonce])`, sender nonce increment before authorizations, failed execution does not roll back delegation); [deterministic deployment proxy](https://github.com/Arachnid/deterministic-deployment-proxy) (public signed factory deployment transaction).
