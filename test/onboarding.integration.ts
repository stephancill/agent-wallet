import { strict as assert } from "node:assert";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { consentTypedData, delegateIdentity } from "../shared/protocol";

const origin = process.env.AGENT_WALLET_URL ?? "http://127.0.0.1:8787";
const agent = privateKeyToAccount(generatePrivateKey());
const parent = privateKeyToAccount(generatePrivateKey());

async function api({
  path,
  body,
  status = 200,
}: {
  path: string;
  body?: unknown;
  status?: number;
}) {
  const response = await fetch(
    `${origin}${path}`,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const value = (await response.json()) as Record<string, any>;
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}

const challenge = await api({
  path: "/api/challenges",
  body: { agent: agent.address, purpose: "login" },
});
const signature = await agent.signMessage({ message: challenge.message });
const created = await api({
  path: "/api/login",
  body: { agent: agent.address, challengeId: challenge.id, signature },
  status: 201,
});
assert.equal(
  (
    await api({
      path: "/api/login",
      body: { agent: agent.address, challengeId: challenge.id, signature },
      status: 201,
    })
  ).id,
  created.id,
);
await api({ path: `/api/attempts/${created.id}?token=0xdead`, status: 400 });
const preview = await api({
  path: `/api/attempts/${created.id}/preview?token=${created.token}&parent=${parent.address}&chainId=1`,
});
assert.equal(preview.delegate, delegateIdentity({ parent: parent.address }).address);
assert.ok(preview.chains.some((chain: { state: string }) => chain.state === "pre-use"));
const consent = consentTypedData({ ...preview.consent, chainId: 1 });
const signed = await parent.signTypedData(consent);
await api({
  path: `/api/attempts/${created.id}/consent`,
  body: {
    token: created.token,
    parent: parent.address,
    chainId: 1,
    signature: await agent.signTypedData(consent),
  },
  status: 400,
});
const approved = await api({
  path: `/api/attempts/${created.id}/consent`,
  body: { token: created.token, parent: parent.address, chainId: 1, signature: signed },
});
assert.equal(approved.status, "awaiting_authorization");
assert.equal(
  (
    await api({
      path: `/api/attempts/${created.id}/consent`,
      body: { token: created.token, parent: parent.address, chainId: 1, signature: signed },
    })
  ).status,
  "awaiting_authorization",
);
const finalize = await api({
  path: "/api/challenges",
  body: { agent: agent.address, purpose: "finalize", attemptId: created.id },
});
const authorization = await agent.signAuthorization({
  contractAddress: preview.delegate,
  chainId: 0,
  nonce: 0,
});
const proof = await agent.signMessage({ message: finalize.message });
const authBody = {
  agent: agent.address,
  challengeId: finalize.id,
  signature: proof,
  authorization: {
    address: authorization.address,
    chainId: authorization.chainId,
    nonce: authorization.nonce,
    r: authorization.r,
    s: authorization.s,
    yParity: authorization.yParity,
  },
};
const wrongAuthorization = await parent.signAuthorization({
  contractAddress: preview.delegate,
  chainId: 0,
  nonce: 0,
});
await api({
  path: `/api/attempts/${created.id}/authorization`,
  body: {
    ...authBody,
    authorization: {
      address: wrongAuthorization.address,
      chainId: 0,
      nonce: 0,
      r: wrongAuthorization.r,
      s: wrongAuthorization.s,
      yParity: wrongAuthorization.yParity,
    },
  },
  status: 400,
});
const ready = await api({
  path: `/api/attempts/${created.id}/authorization`,
  body: authBody,
});
assert.equal(ready.status, "ready");
assert.equal(
  (await api({ path: `/api/attempts/${created.id}/authorization`, body: authBody })).status,
  "ready",
);
assert.equal((await api({ path: `/api/accounts/${agent.address}` })).status, "ready");
assert.ok(!JSON.stringify(ready).includes(authorization.r));
assert.ok(!JSON.stringify(await api({ path: `/api/accounts/${agent.address}` })).includes(signed));
console.log("Onboarding integration passed (ephemeral accounts; no private keys disclosed)");
