---
title: Remote Access
description: Reach your self-hosted lynox from your phone, laptop, or anywhere — without opening ports or shipping data through third parties.
sidebar:
  order: 90
---

If you self-host lynox on a home server or office machine, you'll want to reach the PWA from your phone on the train or your laptop at a café. Three sovereignty-preserving paths, ordered by simplicity:

## Option A — Tailscale (Recommended for individuals)

Tailscale gives every device a stable private IP on a mesh VPN. Zero port-forwarding, end-to-end encrypted, traffic never leaves your devices (no relay unless the direct path fails).

**Setup (~5 minutes):**

1. `curl -fsSL https://tailscale.com/install.sh | sh` on the lynox host
2. `sudo tailscale up` — accept the auth URL in your browser
3. On every device that should reach lynox: install the Tailscale app, sign in with the same account
4. Find the lynox host's Tailscale IP: `tailscale ip -4` (e.g. `100.x.y.z`)
5. From your phone: open `http://100.x.y.z:3000` in the browser, install as PWA

**Optional polish:** [MagicDNS](https://tailscale.com/kb/1081/magicdns/) gives you `http://lynox-host:3000` instead of an IP.

**What you get:**
- Direct WireGuard tunnel between your phone and lynox host
- Works behind CGNAT, mobile carriers, hotel WiFi
- Free for personal use (up to 100 devices)
- No data through Tailscale's servers (coordinator only exchanges keys)

## Option B — Cloudflare Tunnel (When you want a public hostname)

If you want `lynox.your-domain.com` from any browser, no app install needed, but still no inbound port on your home router: Cloudflare Tunnel runs an outbound connection from your lynox host to Cloudflare's edge.

**Prerequisites:**
- A domain on Cloudflare (free)
- `cloudflared` installed on the lynox host

**Setup:**

1. `cloudflared tunnel login` — pick the zone (`your-domain.com`)
2. `cloudflared tunnel create lynox` — note the tunnel ID
3. Create `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: <tunnel-id>
   credentials-file: /home/you/.cloudflared/<tunnel-id>.json
   ingress:
     - hostname: lynox.your-domain.com
       service: http://localhost:3000
     - service: http_status:404
   ```
4. `cloudflared tunnel route dns lynox lynox.your-domain.com`
5. Run as a service: `sudo cloudflared service install` → starts on boot

**Lock it down — critical:**

Cloudflare Tunnel by default makes your lynox PWA reachable to anyone who knows the URL. **Add [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/) policies in front:**

- Zero Trust dashboard → Access → Applications → Add application → "Self-hosted"
- Application domain: `lynox.your-domain.com`
- Policy: require `Email` matches your Google/email identity provider
- Optional: require a hardware key (YubiKey/Passkey) for stronger 2FA

Without an Access policy, your engine's HTTP secret is the only thing between the public internet and your data — fine, but Access adds a clean auth-layer your browser remembers.

**Privacy note:** Cloudflare sees the TLS-terminated traffic between your browser and the tunnel. If that's a concern, use Option A (Tailscale) instead — traffic stays peer-to-peer.

## Option C — Direct reverse proxy with Let's Encrypt (Advanced)

Static public IP, port-forwarding on your router, dedicated subdomain. Caddy is the simplest:

```caddy
# /etc/caddy/Caddyfile
lynox.your-domain.com {
    reverse_proxy localhost:3000
    # Caddy auto-provisions a Let's Encrypt cert
}
```

Then:
- Forward `:443` from your router to the Caddy host
- DNS `A` record `lynox.your-domain.com` → your public IP
- `sudo caddy reload`

Add [HTTP basic auth](https://caddyserver.com/docs/caddyfile/directives/basicauth) or [Authelia](https://www.authelia.com/) in front for a second factor.

This is the most "self-host" path but requires the most operations work: cert renewal, DDNS if you don't have a static IP, firewall hygiene, log rotation. Most users are better off with Tailscale or CF Tunnel.

## Why not Telegram?

lynox used to ship a Telegram bot as the mobile-access companion. We removed it because:

- **Data sovereignty** — every voice message, photo, and reply went through Telegram (Meta-adjacent infrastructure) before reaching your engine. The PWA + the options above keep traffic end-to-end on infrastructure you control.
- **Attack surface** — a Telegram bot token is a public webhook endpoint with stable URL; mistakes there can't be quickly contained.
- **Feature parity** — the PWA covers everything the bot did (chat, voice, mail, push notifications), better.

If you specifically need a *messenger-style* interface to lynox, see the [Unified Inbox](/features/unified-inbox/) which routes WhatsApp Business messages alongside mail in the same triage UI.

## Troubleshooting

**PWA install doesn't appear on iOS Safari over Tailscale IP**
iOS Safari only offers "Add to Home Screen" on HTTPS or on `localhost`. Use Tailscale MagicDNS + a self-signed cert, or use Cloudflare Tunnel (auto-HTTPS).

**Cloudflare Tunnel: 502 Bad Gateway**
Check the engine is bound to `0.0.0.0:3000` (default in Docker) not just `127.0.0.1`. The `cloudflared` daemon needs to reach it from the same host.

**Tailscale: connection works on WiFi but not mobile data**
Some carriers block WireGuard's UDP port. Enable [Tailscale's DERP relay](https://tailscale.com/kb/1232/derp-servers/) — happens automatically when direct fails, expect ~30-100ms extra latency.
