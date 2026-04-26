import dgram from "node:dgram";

const HOMEY_IP = process.env.HOMEY_IP;
const BULB_IPS = (process.env.BULB_IPS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const IFACE_IP = process.env.IFACE_IP ?? "0.0.0.0";
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS ?? 30_000);
const SCAN_PORT = 4001;
const REPLY_PORT = 4002;

if (!HOMEY_IP || BULB_IPS.length === 0) {
  console.error(
    "error: set HOMEY_IP and BULB_IPS (comma-separated list of bulb IPs)",
  );
  process.exit(1);
}

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

sock.bind(REPLY_PORT, IFACE_IP, () => {
  console.log(
    `proxy listening on ${IFACE_IP}:${REPLY_PORT}, forwarding to ${HOMEY_IP}:${REPLY_PORT}`,
  );
  console.log(`unicast scanning ${BULB_IPS.length} bulb(s) every ${SCAN_INTERVAL_MS}ms`);
  scan();
  setInterval(scan, SCAN_INTERVAL_MS);
});

function scan() {
  for (const ip of BULB_IPS) {
    sock.send(scanPacket, SCAN_PORT, ip, (err) => {
      if (err) console.error(`scan send error (${ip}):`, err);
    });
  }
}
