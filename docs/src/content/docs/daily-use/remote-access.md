---
title: Remote Access
description: Use lynox on your phone — from home or anywhere.
sidebar:
  order: 4
---

lynox runs on your server or laptop. This guide shows how to use it on your phone — on the same WiFi or from anywhere.

## Same network (QR code)

If your phone is on the same WiFi as lynox, this takes 10 seconds:

1. Open **Settings → Mobile Zugang** (or tap the phone icon in the status bar)
2. Scan the QR code with your phone camera
3. You're logged in — no token to type
4. **Install as PWA:** iOS: Share → Add to Home Screen. Android: Menu → Install app.

The QR code contains a one-time login link (valid 5 minutes, single use). Your session lasts 7 days.

## From anywhere

If you want to use lynox from outside your home network (mobile data, travel, other WiFi), you need to make your instance reachable from the internet. Two recommended options:

### Option 1: Tailscale (recommended)

Private mesh VPN. Simplest setup, no public exposure.

**On your server:**

```bash
# Install (Debian/Ubuntu)
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

**On your phone:**

1. Install [Tailscale](https://tailscale.com/download) from App Store / Play Store
2. Sign in with the same account
3. Open `http://<your-server-tailscale-ip>:3000` in your phone browser

Your Tailscale IP is shown after `tailscale up` or in the Tailscale app. It looks like `100.x.y.z` and never changes.

Then use the QR code in Settings → Mobile Zugang to log in, or enter your access token manually.

**Why Tailscale:**
- 2 minute setup
- Encrypted, private — no public URL
- Stable IP that never changes
- Free for personal use (up to 100 devices)
- Works on all platforms

### Option 2: Cloudflare Tunnel (public URL)

If you want a public URL like `lynox.example.com` — for sharing with others or accessing without a VPN app.

**Prerequisites:** A domain on Cloudflare (free plan works).

**Setup:**

```bash
# Install cloudflared
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare-archive-keyring.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install cloudflared

# Authenticate
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create lynox

# Route DNS
cloudflared tunnel route dns lynox lynox.example.com

# Run
cloudflared tunnel run --url http://localhost:3000 lynox
```

Or as a Docker sidecar (recommended for always-on):

```yaml
# docker-compose.yml
services:
  lynox:
    image: ghcr.io/lynox-ai/lynox:webui
    # ... your config ...

  tunnel:
    image: cloudflare/cloudflared:latest
    command: tunnel run --token ${TUNNEL_TOKEN}
    depends_on:
      lynox:
        condition: service_healthy
```

Get the tunnel token from the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/) → Tunnels → Create.

**Why Cloudflare Tunnel:**
- Public HTTPS URL on your own domain
- No port forwarding, no firewall changes
- Optional: Cloudflare Access for additional auth (email OTP, SSO)
- Free

## Security

Regardless of how you expose lynox:

- **LYNOX_HTTP_SECRET** protects the Web UI (required for all access)
- **Rate limiting** prevents brute-force attacks (5 attempts per 15 minutes)
- **Session cookies** are `httpOnly`, `secure` (HTTPS), `sameSite: strict`
- **QR login codes** are one-time use, 256-bit random, expire in 5 minutes

Never expose lynox without `LYNOX_HTTP_SECRET` set. The setup wizard and Docker entrypoint auto-generate one if not provided.
