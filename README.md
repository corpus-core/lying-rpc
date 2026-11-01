# lying-rpc

A tiny JSON-RPC proxy that returns the **same wrong answer in four different
ways**. Built for the ["Swap Your RPC"](https://github.com/corpus-core/workshop)
Devcon 8 workshop.

Everything it manipulates is scoped to a single demo address
(`DEMO_ADDRESS` in [`server.js`](server.js)). All other requests pass through
untouched, so a Colibri client in hybrid mode can still verify the surrounding
data (block headers, logs, other accounts) against the honest state root.

## Modes

The mode is chosen by URL path, so one host can serve all variants:

| Path       | What is manipulated                                                      | Without Colibri | With Colibri (hybrid)                                                         |
| ---------- | ------------------------------------------------------------------------ | --------------- | ----------------------------------------------------------------------------- |
| `/honest`  | nothing                                                                  | correct         | `verified`                                                                    |
| `/plain`   | only `eth_getBalance`                                                    | wrong value     | correct value, `verified` -- Colibri does `eth_getProof`, not `eth_getBalance` |
| `/field`   | `/plain` + rewrite `balance` field in `eth_getProof`; proof nodes intact | wrong value     | `rejected` -- the account inside the leaf no longer matches the stated balance |
| `/forged`  | `/field` + rebuild the leaf and re-hash every parent up to the root      | wrong value     | `rejected` -- the computed state root does not match the signed block header   |
| `/`        | alias for `/forged`                                                      |                 |                                                                               |

The lie is always the same: `+1000 ETH` for `DEMO_ADDRESS`. Easy to spot on
stage, easy to explain, small enough that the account RLP changes only
slightly.

## Running it locally

```sh
# Native
UPSTREAM_RPC=https://ethereum.publicnode.com node server.js
```

```sh
# Docker Compose
docker compose up --build
```

The server listens on `:8545` by default (`PORT` env var to override).

Smoke test:

```sh
curl -s http://localhost:8545/plain -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance",
       "params":["0x7d8eb200c45c273e3bef1bc55c09f76805158e96","latest"]}'
```

Compare the result to `/honest` with the same body -- the `/plain` answer is
higher by `1000 * 10^18`.

## Why `hybrid` matters for the workshop

Colibri has three relevant proof modes:

- `remote` -- the Colibri prover builds the proof itself. It talks to its own
  Ethereum backend, so this lying RPC is never consulted and the workshop has
  nothing to show.
- `local` -- the client builds the entire proof. It needs a beacon API and a
  full execution-layer RPC; too much setup for a 50-minute slot.
- `hybrid` -- the block-header proof comes from the Colibri prover (small,
  cacheable), but account and storage data is fetched from the configured RPC
  and verified locally. That is where this lying RPC gets to lie, and where
  Colibri gets to catch the lie.

The workshop therefore configures `prover_mode: "hybrid"` in step 1.

## What this is *not*

Not a general-purpose RPC. Not a security tool. Not a production proxy. It is
a teaching aid that exists so participants can watch a verifying client reject
a specific, well-chosen forgery.
