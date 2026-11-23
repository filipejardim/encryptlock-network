// EncryptLock network snapshot for outside tools (Cosmos chain-registry,
// cosmos.directory, explorers). Every 10 minutes GitHub Actions reads the
// public network data straight from a LockKeeper door and writes it here as
// static files on GitHub Pages: free, without a request limit, and nothing
// outside can make the EncryptLock Cloudflare account spend requests
// (23 Nov 2026: registry tools asking the live fixed addresses ran out its
// free 100,000 requests a day). One request a run to the address book
// (~144 a day); the doors are Cloudflare quick tunnels, which do not count.
//
// Layout: site/rest/<Cosmos REST path>, site/rpc/<CometBFT RPC path>.
// A path that also has children (validators/<address>) is written as
// <path>/index.html; GitHub Pages serves it at <path>/ (redirect from <path>).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const CHAIN = "encryptlock-1";
const BOOK = `https://encryptlock-arbitro.ncrypt-ock.workers.dev/doors?chain=${CHAIN}`;
const OUT = "site";

const REST = [
  "cosmos/base/tendermint/v1beta1/node_info",
  "cosmos/base/tendermint/v1beta1/blocks/latest",
  "cosmos/base/tendermint/v1beta1/syncing",
  "cosmos/base/tendermint/v1beta1/validatorsets/latest",
  "cosmos/staking/v1beta1/pool",
  "cosmos/staking/v1beta1/params",
  "cosmos/bank/v1beta1/supply",
  "cosmos/bank/v1beta1/denoms_metadata",
  "cosmos/slashing/v1beta1/params",
  "cosmos/distribution/v1beta1/params",
  "cosmos/auth/v1beta1/params",
];
const RPC = ["status", "abci_info", "health", "validators"];

async function get(url) {
  const r = await fetch(url, { headers: { "user-agent": "Go-http-client/2.0" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const text = await r.text();
  JSON.parse(text); // only JSON goes out
  return text;
}

async function put(path, text) {
  const file = join(OUT, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

async function fromDoor(d) {
  const rest = d.address.replace(/\/$/, ""), rpc = d.rpc.replace(/\/$/, "");
  const status = JSON.parse(await get(`${rpc}/status`));
  if (status.result.node_info.network !== CHAIN) throw new Error("another network");
  const files = {};
  for (const p of RPC) files[`rpc/${p}`] = await get(`${rpc}/${p}`);
  for (const p of REST) files[`rest/${p}`] = await get(`${rest}/${p}`);
  // The newest block also under its number, the list endpoints with their items.
  const latest = JSON.parse(files["rest/cosmos/base/tendermint/v1beta1/blocks/latest"]);
  files[`rest/cosmos/base/tendermint/v1beta1/blocks/${latest.block.header.height}`] = files["rest/cosmos/base/tendermint/v1beta1/blocks/latest"];
  const vals = await get(`${rest}/cosmos/staking/v1beta1/validators?pagination.limit=500`);
  files["rest/cosmos/staking/v1beta1/validators/index.html"] = vals;
  for (const v of JSON.parse(vals).validators || []) {
    if (/^lockvaloper1[0-9a-z]{30,60}$/.test(v.operator_address)) files[`rest/cosmos/staking/v1beta1/validators/${v.operator_address}`] = JSON.stringify({ validator: v });
  }
  const infos = await get(`${rest}/cosmos/slashing/v1beta1/signing_infos?pagination.limit=500`);
  files["rest/cosmos/slashing/v1beta1/signing_infos/index.html"] = infos;
  for (const i of JSON.parse(infos).info || []) {
    if (/^lockvalcons1[0-9a-z]{30,60}$/.test(i.address)) files[`rest/cosmos/slashing/v1beta1/signing_infos/${i.address}`] = JSON.stringify({ val_signing_info: i });
  }
  return { files, height: latest.block.header.height, time: latest.block.header.time };
}

const book = JSON.parse(await get(BOOK));
const doors = (book.doors || []).filter((d) => d.address && d.rpc).sort((a, b) => (b.at || 0) - (a.at || 0));
let snap;
for (const d of doors) {
  try { snap = await fromDoor(d); break; } catch (e) { console.log("door skipped:", e.message); }
}
if (!snap) { console.log("no door answered: the last snapshot stays online"); process.exit(1); }
for (const [p, t] of Object.entries(snap.files)) await put(p, t);
await put("index.html", `<!doctype html><meta charset="utf-8"><title>EncryptLock network data</title>
<p>Snapshot of the EncryptLock network (${CHAIN}) for outside tools, refreshed about every 10 minutes.</p>
<p>Block ${snap.height} at ${snap.time}. REST: <code>/rest</code>, RPC: <code>/rpc</code>.</p>
<p>EncryptLock: <a href="https://encryptlock.pages.dev">encryptlock.pages.dev</a></p>`);
await put(".nojekyll", "");
console.log(`snapshot of block ${snap.height} (${snap.time}), ${Object.keys(snap.files).length} files`);
