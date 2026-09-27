import { expect, test } from "bun:test";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { recoverAuthorizationAddress } from "viem/utils";
import { consentTypedData, delegateIdentity } from "../shared/protocol";

test("parent-specific delegate matches independently verified Ethereum/Base fork identity", () => {
  const identity = delegateIdentity({ parent: "0x4Da8Be929434C6E88C24551eA45A57BBfECB5bD2" });
  expect(identity.address).toBe("0x75Fd7BDe8eE7a2142845af57f52694C6B744d051");
  expect(identity.initcodeHash).toBe(
    "0x857a0f9cd205285333e8ca40382acd5d9ed4f2a689e87f2849981684669afb0d",
  );
  expect(identity.runtimeHash).toBe(
    "0x7114fc38fc0a23cafdd9c1283251f1f6053da52c95c3a429368a79b2bef82953",
  );
});

test("local EOA signs a parent-bound chain-agnostic nonce-0 authorization", async () => {
  const agent = privateKeyToAccount(generatePrivateKey());
  const parent = privateKeyToAccount(generatePrivateKey());
  const delegate = delegateIdentity({ parent: parent.address }).address;
  const authorization = await agent.signAuthorization({
    contractAddress: delegate,
    chainId: 0,
    nonce: 0,
  });
  expect(authorization.address).toBe(delegate);
  expect(authorization.chainId).toBe(0);
  expect(authorization.nonce).toBe(0);
  expect(await recoverAuthorizationAddress({ authorization })).toBe(agent.address);
  const consent = consentTypedData({
    origin: "https://agent-wallet.stupidtech.net",
    id: "aw_test",
    challenge: `0x${"ab".repeat(32)}`,
    agent: agent.address,
    parent: parent.address,
    delegate,
    chainId: 1,
    expiresAt: 2_000_000_000,
  });
  const signature = await parent.signTypedData(consent);
  expect(await parent.signTypedData(consent)).toBe(signature);
});
