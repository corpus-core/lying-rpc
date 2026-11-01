// Lying RPC -- a JSON-RPC proxy that returns the same wrong answer in four
// different ways. Built for the "Swap Your RPC" Devcon workshop.
//
// Everything is scoped to a single demo address. Every other request passes
// through untouched, so a Colibri client in hybrid mode can still verify all
// the surrounding data (block headers, other accounts, logs, ...) against the
// honest state root.
//
// Mode is picked by URL path:
//   /honest   - pass-through, nothing changed
//   /plain    - rewrite only eth_getBalance   (wrong without any proof)
//   /field    - plain + rewrite the `balance` field in the eth_getProof answer
//               but leave the Merkle nodes alone                 (proof mismatch)
//   /forged   - field + rebuild the account leaf and re-hash all parent nodes
//               up to the state root                       (root mismatch)
//   /         - alias for /forged
//
// Start with:
//   UPSTREAM_RPC=https://ethereum.publicnode.com node server.js
// Listens on PORT (default 8545).

import http from "node:http";
import { RLP } from "@ethereumjs/rlp";
import { keccak_256 } from "@noble/hashes/sha3.js";

// The lie is small on purpose: +1000 ETH to one specific account. Easy to spot
// on screen, easy to explain, and small enough that the account RLP changes
// only slightly.
const DEMO_ADDRESS   = "0x7d8eb200c45c273e3bef1bc55c09f76805158e96";
const FAKE_EXTRA_WEI = 1000n * 10n ** 18n;

const UPSTREAM = process.env.UPSTREAM_RPC;
const PORT     = Number(process.env.PORT || 8545);
if (!UPSTREAM) {
  console.error("Set UPSTREAM_RPC to a real Ethereum JSON-RPC endpoint.");
  process.exit(1);
}

// ---- helpers --------------------------------------------------------------
const hex0x       = b => "0x" + Buffer.from(b).toString("hex");
const fromHex0x   = s => Buffer.from(s.replace(/^0x/, ""), "hex");
const bytesEqual  = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const addrEqual   = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
const keccak      = bytes => keccak_256(bytes);

// Strip leading zero bytes -- RLP integers are canonical, no leading zeros.
function trimLeadingZeros(bytes) {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  return bytes.slice(i);
}

// Encode a big integer as a minimal big-endian Uint8Array (zero -> empty).
function bigIntToBytes(n) {
  if (n === 0n) return new Uint8Array(0);
  let h = n.toString(16);
  if (h.length % 2) h = "0" + h;
  return Uint8Array.from(Buffer.from(h, "hex"));
}

// ---- the forgery ----------------------------------------------------------
//
// `eth_getProof` returns a Patricia Merkle proof from the state root down to
// the account leaf. The leaf is RLP([encodedPath, accountRlp]), and the
// account is RLP([nonce, balance, storageRoot, codeHash]).
//
// To get past the verifier's leaf check we must replace `balance` inside the
// account AND inside the leaf, then re-hash the path upwards: every parent
// node has a slot that references the child by keccak256(childEncoding), so
// if the child's encoding changes, the slot in the parent must be updated,
// which changes the parent's hash, and so on up to the state root.
//
// What this does NOT fix: the state root itself. The honest state root sits
// in the block header which is signed by the sync committee. Colibri computes
// the root of our forged proof and compares -- that is where /forged dies.
function forgeAccountProof(proofResult, fakeBalanceWei) {
  // Replace the top-level `balance` field so a plain eth_getBalance verifier
  // and the leaf-check verifier see the same (lying) value.
  proofResult.balance = "0x" + fakeBalanceWei.toString(16);

  // Decode the whole proof: list of RLP-encoded trie nodes, root first.
  const nodes = proofResult.accountProof.map(fromHex0x);
  const decoded = nodes.map(n => RLP.decode(n));

  // Leaf = last node = [encodedPath, accountRlp]. Account = [nonce, balance,
  // storageRoot, codeHash]. Rebuild it with the fake balance (minimal BE).
  const last = decoded.length - 1;
  const leaf = decoded[last];
  if (!Array.isArray(leaf) || leaf.length !== 2)
    throw new Error("accountProof: last node is not a 2-item leaf");
  const account = RLP.decode(leaf[1]);
  if (!Array.isArray(account) || account.length !== 4)
    throw new Error("accountProof: account RLP is not [nonce,balance,storageRoot,codeHash]");
  account[1] = bigIntToBytes(fakeBalanceWei);
  const newAccountRlp = RLP.encode(account);
  const newLeafEnc    = RLP.encode([leaf[0], newAccountRlp]);
  let oldHash = keccak(nodes[last]);
  let newHash = keccak(newLeafEnc);
  const newNodes = [...nodes];
  newNodes[last] = newLeafEnc;

  // Walk upwards. Each parent is either a branch (17 items) or an extension
  // (2 items). In both cases the pointer to our child is a 32-byte hash of
  // the previous encoding. Replace that hash and re-encode.
  for (let i = last - 1; i >= 0; i--) {
    const parent = decoded[i];
    if (!Array.isArray(parent))
      throw new Error(`accountProof: node ${i} is not an array`);
    let replaced = false;
    for (let j = 0; j < parent.length; j++) {
      const slot = parent[j];
      if (slot instanceof Uint8Array && bytesEqual(slot, oldHash)) {
        parent[j] = newHash;
        replaced = true;
        break;
      }
    }
    if (!replaced)
      throw new Error(`accountProof: parent node ${i} has no 32-byte reference`
        + ` to child; forgery cannot continue (inlined child?)`);
    const parentEnc = RLP.encode(parent);
    oldHash = keccak(nodes[i]);
    newHash = keccak(parentEnc);
    newNodes[i] = parentEnc;
  }

  proofResult.accountProof = newNodes.map(hex0x);
  return proofResult;
}

// ---- per-request manipulation ---------------------------------------------
//
// Modes are additive: /plain is a subset of /field is a subset of /forged.
async function manipulate(mode, req, response) {
  if (mode === "honest" || !response || !("result" in response)) return;
  const { method, params = [] } = req;

  if (method === "eth_getBalance") {
    if (!addrEqual(params[0], DEMO_ADDRESS)) return;
    const real = BigInt(response.result || "0x0");
    response.result = "0x" + (real + FAKE_EXTRA_WEI).toString(16);
    return;
  }

  if ((mode === "field" || mode === "forged") && method === "eth_getProof") {
    if (!addrEqual(params[0], DEMO_ADDRESS)) return;
    const r = response.result;
    if (!r || !r.balance || !Array.isArray(r.accountProof)) return;
    const fakeBalance = BigInt(r.balance) + FAKE_EXTRA_WEI;
    if (mode === "field") {
      r.balance = "0x" + fakeBalance.toString(16);
    } else {
      forgeAccountProof(r, fakeBalance);
    }
  }
}

// ---- upstream + HTTP boilerplate ------------------------------------------
async function callUpstream(payload) {
  const r = await fetch(UPSTREAM, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json();
}

function logRpc(mode, call) {
  const p = JSON.stringify(call.params ?? []);
  console.log(`[${mode}] ${call.method}(${p.length > 100 ? p.slice(0, 97) + "..." : p})`);
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age":       "86400",
};

const MODES = new Set(["honest", "plain", "field", "forged"]);

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS_HEADERS); res.end(); return; }
  if (req.method !== "POST")    { res.writeHead(405, CORS_HEADERS); res.end(); return; }

  const path = (req.url || "/").split("?")[0].replace(/^\/+/, "");
  const mode = path === "" ? "forged" : path;
  if (!MODES.has(mode)) {
    res.writeHead(404, CORS_HEADERS); res.end(`unknown mode: ${path}`); return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { res.writeHead(400, CORS_HEADERS); res.end("invalid json"); return; }

  const isBatch = Array.isArray(payload);
  const calls   = isBatch ? payload : [payload];
  calls.forEach(c => logRpc(mode, c));

  let answers;
  try {
    answers = await callUpstream(payload);
    const arr = isBatch ? answers : [answers];
    for (let i = 0; i < calls.length; i++) await manipulate(mode, calls[i], arr[i]);
  } catch (e) {
    const err = { jsonrpc: "2.0", id: null, error: { code: -32603, message: e.message } };
    res.writeHead(502, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify(isBatch ? [err] : err));
    return;
  }

  res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
  res.end(JSON.stringify(answers));
});

server.listen(PORT, () => {
  console.log(`lying-rpc listening on :${PORT}`);
  console.log(`upstream: ${UPSTREAM}`);
  console.log(`demo address: ${DEMO_ADDRESS}  (+${FAKE_EXTRA_WEI / 10n**18n} ETH)`);
});
