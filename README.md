# homey-udp-proxy

A tiny UDP relay that fixes Govee LAN discovery for bulbs whose firmware
omits the `ip` field from scan replies (notably the **H60B2**), and that
sit on a different VLAN from your Homey Pro.

## Why this exists

Govee's LAN protocol is multicast-based:

1. The controller (Homey) sends a `scan` packet to `239.255.255.250:4001`.
2. Each bulb replies on UDP `4002` with its model, MAC, and IP.
3. Homey reads `data.ip` from the reply and starts talking to the bulb directly.

Two things break that on certain setups:

- **H60B2 firmware** sends the scan reply *without* the `ip` field. Homey
  drops the device because it doesn't know where to send follow-up traffic.
- **Cross-VLAN multicast** doesn't traverse most consumer routers. The
  bulbs on the IoT VLAN never hear Homey's scan, and even if they did, the
  reply wouldn't reach Homey.

This proxy listens on UDP 4002, scans the IoT-side bulbs itself, injects the
source IP into any reply that's missing one, and forwards the corrected
reply to Homey. Homey thinks it discovered the bulb directly via multicast.

## Two modes

There are two entry files; pick one based on your network:

### `index.ts` — multicast mode

For when the proxy lives on the **same VLAN as the bulbs** (or your router
forwards multicast across VLANs). It joins the `239.255.255.250` group on
the chosen interface, sends scans every 30s, and rewrites replies.

```sh
HOMEY_IP=192.168.1.222 IFACE_IP=192.168.3.10 bun run index.ts
```

### `unicast.ts` — unicast / sweep mode

For when the proxy is on a **different VLAN** from the bulbs and multicast
won't reach. Instead of multicasting, it sends scan packets directly to
every host in a subnet (or a fixed list of IPs).

Sweep an entire subnet (no IPs needed):

```sh
HOMEY_IP=192.168.1.222 BULB_SUBNET=192.168.3.0/24 bun run unicast.ts
```

Or pin a known list of bulbs:

```sh
HOMEY_IP=192.168.1.222 BULB_IPS=192.168.3.96,192.168.3.97 bun run unicast.ts
```

In sweep mode it does a full subnet scan on startup and once every ~5
minutes (every 10th scan interval) to catch new/relocated bulbs. Between
those, it only re-scans IPs that have already responded — keeping ambient
LAN traffic minimal.

## Configuration

All via environment variables:

| Var | Required | Default | Notes |
| --- | --- | --- | --- |
| `HOMEY_IP` | yes | — | LAN IP of your Homey Pro. |
| `BULB_SUBNET` | unicast.ts only* | — | CIDR like `192.168.3.0/24`. |
| `BULB_IPS` | unicast.ts only* | — | Comma-separated bulb IPs. |
| `IFACE_IP` | no | `0.0.0.0` | Bind a specific local interface. |
| `SCAN_INTERVAL_MS` | no | `30000` | How often to re-scan. |
| `SCAN_BATCH_SIZE` | no | `32` | Hosts per batch (sweep mode). |
| `SCAN_BATCH_DELAY_MS` | no | `50` | Delay between batches. |

*One of `BULB_SUBNET` or `BULB_IPS` is required for `unicast.ts`.

## Network prerequisites (UniFi-specific)

If running across VLANs, the path needs three things to work:

1. The proxy must be reachable from the IoT VLAN on UDP 4002 (so bulb
   replies can come back).
2. The proxy must be able to send to the IoT VLAN on UDP 4001 (so it can
   scan).
3. Homey (on the trusted VLAN) must accept UDP 4002 from the proxy host.

UniFi's zone-based firewall does session-aware return-path matching that
fails for the asymmetric `4001 → 4002` flow. Add three explicit allow
policies *above* any blanket "Block IoT to Trusted" rule:

- Allow IoT → proxy host, UDP 4001
- Allow proxy host → IoT, UDP 4001
- Allow proxy host → Homey, UDP 4002

## Logs

You'll see one of these per scan reply:

- `passthrough <SKU> <ip> ← <ip>:<port>` — bulb's own reply already had `ip`,
  forwarded as-is.
- `patched <SKU> <ip> ← <ip>:<port>` — `ip` was missing; we injected the
  source address before forwarding.
- `new responder: <SKU> @ <ip>` — first time we've seen a particular IP
  reply (sweep mode only).

## Running it as a service

There's no built-in supervisor. Run it under launchd / systemd /
docker / pm2 / whatever fits — it has no state and crashes are safe to
restart from cold.
