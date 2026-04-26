import dgram from "node:dgram";

const HOMEY_IP = process.env.HOMEY_IP;
const BULB_SUBNET = process.env.BULB_SUBNET; // e.g. "192.168.3.0/24"
const BULB_IPS = (process.env.BULB_IPS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const IFACE_IP = process.env.IFACE_IP ?? "0.0.0.0";
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS ?? 30_000);
const SCAN_BATCH_SIZE = Number(process.env.SCAN_BATCH_SIZE ?? 32);
const SCAN_BATCH_DELAY_MS = Number(process.env.SCAN_BATCH_DELAY_MS ?? 50);
const SCAN_PORT = 4001;
const REPLY_PORT = 4002;

if (!HOMEY_IP || (!BULB_SUBNET && BULB_IPS.length === 0)) {
  console.error(
    "error: set HOMEY_IP, plus either BULB_SUBNET (e.g. 192.168.3.0/24) or BULB_IPS (comma-separated)",
  );
  process.exit(1);
}

const targetIps: string[] = BULB_SUBNET ? expandSubnet(BULB_SUBNET) : BULB_IPS;
// Track responders so the steady-state scan can stay tight after the initial
// sweep — we only re-sweep the full subnet periodically to pick up new bulbs.
const knownResponders = new Set<string>();

const scanPacket = Buffer.from(
  JSON.stringify({ msg: { cmd: "scan", data: { account_topic: "reserve" } } }),
);

const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });

sock.on("message", (msg, rinfo) => {
  if (rinfo.address === HOMEY_IP) return;

  let parsed: any;
  try {
    parsed = JSON.parse(msg.toString());
  } catch {
    return;
  }

  const data = parsed?.msg?.data;
  const sku = data?.sku;
  if (!data || !sku) return;

  const hadIp = typeof data.ip === "string" && data.ip.length > 0;
  if (!hadIp) data.ip = rinfo.address;

  if (!knownResponders.has(rinfo.address)) {
    knownResponders.add(rinfo.address);
    console.log(`new responder: ${sku} @ ${rinfo.address}`);
  }

  const tag = hadIp ? "passthrough" : "patched";
  console.log(`${tag} ${sku} ${data.ip} ← ${rinfo.address}:${rinfo.port}`);

  const rewritten = Buffer.from(JSON.stringify(parsed));
  sock.send(rewritten, REPLY_PORT, HOMEY_IP, (err) => {
    if (err) console.error("forward error:", err);
  });
});

sock.on("error", (err) => {
  console.error("socket error:", err);
  process.exit(1);
});

sock.bind(REPLY_PORT, IFACE_IP, async () => {
  console.log(
    `proxy listening on ${IFACE_IP}:${REPLY_PORT}, forwarding to ${HOMEY_IP}:${REPLY_PORT}`,
  );
  if (BULB_SUBNET) {
    console.log(
      `sweep scanning ${targetIps.length} hosts in ${BULB_SUBNET} (batch ${SCAN_BATCH_SIZE}, ${SCAN_BATCH_DELAY_MS}ms apart)`,
    );
  } else {
    console.log(`unicast scanning ${targetIps.length} bulb(s) every ${SCAN_INTERVAL_MS}ms`);
  }

  await sweep();
  // After the first sweep, alternate between cheap "known IPs only" scans and
  // periodic full sweeps. This keeps regular traffic low but still picks up
  // bulbs that came online or got new DHCP leases.
  let sweepCounter = 0;
  setInterval(async () => {
    sweepCounter++;
    const fullSweep = !BULB_SUBNET || knownResponders.size === 0 || sweepCounter % 10 === 0;
    if (fullSweep) await sweep();
    else await scanKnown();
  }, SCAN_INTERVAL_MS);
});

async function sweep() {
  await sendBatched(targetIps);
}

async function scanKnown() {
  if (knownResponders.size === 0) return;
  await sendBatched([...knownResponders]);
}

async function sendBatched(ips: string[]): Promise<void> {
  for (let i = 0; i < ips.length; i += SCAN_BATCH_SIZE) {
    const batch = ips.slice(i, i + SCAN_BATCH_SIZE);
    for (const ip of batch) {
      sock.send(scanPacket, SCAN_PORT, ip, (err) => {
        // Suppress per-host errors during sweeps — most subnet hosts won't
        // exist and ICMP unreachables are expected noise.
        if (err && BULB_IPS.includes(ip)) {
          console.error(`scan send error (${ip}):`, err);
        }
      });
    }
    if (i + SCAN_BATCH_SIZE < ips.length) {
      await sleep(SCAN_BATCH_DELAY_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Expands "192.168.3.0/24" into all usable host IPs (skips network + broadcast). */
function expandSubnet(cidr: string): string[] {
  const [base, prefixStr] = cidr.split("/");
  if (!base || !prefixStr) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  const prefix = Number(prefixStr);
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`invalid prefix in CIDR: ${cidr}`);
  }
  const baseInt = ipToInt(base);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const network = (baseInt & mask) >>> 0;
  const hostBits = 32 - prefix;
  const total = 1 << hostBits;
  const out: string[] = [];
  // Skip .0 (network) and .255 (broadcast) for /24 and similar; for /31 and
  // /32, include all addresses.
  const start = hostBits >= 2 ? 1 : 0;
  const end = hostBits >= 2 ? total - 1 : total;
  for (let i = start; i < end; i++) {
    out.push(intToIp((network + i) >>> 0));
  }
  return out;
}

function ipToInt(ip: string): number {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
    throw new Error(`invalid IPv4 address: ${ip}`);
  }
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function intToIp(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
}
