# Phase 9 — VPS Deploy via Cloudflare Tunnel

**Date:** 2026-07-25
**Target:** `https://app.shabro2a.com` → VPS at `162.35.169.123` → localhost:3000
**Stack:** Docker Compose on Ubuntu 26.04 + cloudflared + Cloudflare Tunnel
**Skips:** Coolify (deferred to later)

---

## Pre-flight (verify VPS is up)

**1. Verify VPS responds** (run from your Windows cmd.exe):

```cmd
ping -n 3 162.35.169.123
```

Should get replies under 300ms.

**2. Verify Coolify is up** (web UI on port 8000):

Open in your browser: `http://162.35.169.123:8000/`

If Coolify is up, you should see the login page. (You previously registered an admin there.)

---

## Step 1 — SSH into VPS

From Windows cmd.exe (NOT PowerShell):

```cmd
ssh root@162.35.169.123
```

If it asks for password, use the password you set when you first provisioned. (Original was `M7r$5r#e` from the welcome email — if you changed it, use whatever you set it to.)

**If SSH hangs without prompting**: your OpenSSH client needs a TTY. Try **Windows Terminal** instead of cmd.exe, or use the Cloudify terminal from the web UI.

**Alternative: use Coolify's terminal**

If you can't get SSH working, Coolify's web UI has a built-in terminal for the running containers. But you need shell access to the VPS host, not just to containers. Skip if SSH is broken.

---

## Step 2 — Install Docker + verify (VPS)

Once SSH'd in:

```bash
# Check if Docker is already installed
docker --version

# If not, install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh
systemctl enable docker
systemctl start docker

# Verify Docker works
docker run hello-world
```

If `docker --version` already shows something like `Docker version 26.x.x`, skip installation.

---

## Step 3 — Clone the repo

```bash
# Create app directory
mkdir -p /opt/ems && cd /opt/ems

# Clone your repo
git clone https://github.com/shabro2a-store/ems.git .

# Check what we got
ls -la
git log --oneline -3
```

Should show 22+ commits.

---

## Step 4 — Create .env on VPS

```bash
cat > .env << 'EOF'
DATABASE_URL=postgresql://ems:ems_prod_password_change_me@db:5432/ems
NODE_ENV=production
JWT_SECRET=GENERATE_ME_WITH_openssl_rand_-hex_32
PUBLIC_APP_URL=https://app.shabro2a.com
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
ENABLE_DEV_ENDPOINTS=false
NEXT_PUBLIC_ENABLE_DEV_ENDPOINTS=false
EOF

# Generate a real JWT_SECRET
NEW_SECRET=$(openssl rand -hex 32)
sed -i "s|GENERATE_ME_WITH_openssl_rand_-hex_32|$NEW_SECRET|" .env

# Verify the file
cat .env
```

**IMPORTANT**: choose a different DB password (`ems_prod_password_change_me` is the placeholder — change it). Then update `docker-compose.yml` on the VPS to match. Or use the same dev password `ems_dev_password` for now (it's a staging environment, not production).

---

## Step 5 — Update docker-compose.yml to use the prod password

```bash
# If you used a different password, update compose
sed -i 's/ems_dev_password/YOUR_ACTUAL_PASSWORD/' docker-compose.yml
```

Verify:
```bash
grep -A1 POSTGRES_PASSWORD docker-compose.yml | head -3
```

---

## Step 6 — Start the services

```bash
cd /opt/ems
docker compose up -d
```

Watch it build. First build takes 3-5 min (downloads base images, installs deps). 

Wait 30 sec, then:
```bash
docker compose ps
```

All 3 services should show `Up (healthy)`.

Check health:
```bash
curl -s http://localhost:3000/api/health | head -200
```

Should return `{"ok":true,"data":{"uptime_s":...}}`.

---

## Step 7 — Run migrations and seed

```bash
docker compose run --rm -w /app/packages/db web node_modules/.bin/prisma migrate deploy
docker compose run --rm -w /app/packages/db web node_modules/.bin/tsx prisma/seed.ts
```

This creates the database tables and seeds admin + 3 branches + 2 employees.

**For VPS, change the seed to use the real password**:

The default seed sets admin password to `change-me`. To use a custom one:
```bash
# (in a Node script)
docker compose exec -w /app/packages/db web node -e '
import("bcryptjs").then(async ({default: bcrypt}) => {
  const {PrismaClient} = await import("@prisma/client");
  const p = new PrismaClient();
  const hash = await bcrypt.hash("YOUR_CUSTOM_PASSWORD", 12);
  await p.user.update({where:{username:"owner"}, data:{password_hash: hash}});
  await p.$disconnect();
  console.log("done");
});
'
```

Or just use `change-me` and change it after first login (the page forces password change on first login if `mustChangePassword: true`).

---

## Step 8 — Install cloudflared

```bash
# Download cloudflared for Linux amd64
curl -L --output cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x cloudflared
mv cloudflared /usr/local/bin/
cloudflared --version
```

Should show version.

---

## Step 9 — Login to Cloudflare from VPS

```bash
cloudflared tunnel login
```

This prints a URL. **You** open that URL in YOUR LOCAL browser, log in to your Cloudflare account (`shabro2a-store`), select `shabro2a.com` domain, authorize.

After authorizing, the VPS is logged in.

---

## Step 10 — Create a named tunnel

```bash
cloudflared tunnel create ems-staging
```

This prints:
- Tunnel ID (UUID)
- Path to credentials file: `/root/.cloudflared/<UUID>.json`

**Save the Tunnel ID** — you'll need it.

---

## Step 11 — Configure the tunnel routing

```bash
mkdir -p /etc/cloudflared
cat > /etc/cloudflared/config.yml << EOF
tunnel: <TUNNEL_ID_FROM_STEP_10>
credentials-file: /root/.cloudflared/<TUNNEL_ID_FROM_STEP_10>.json

ingress:
  - hostname: app.shabro2a.com
    service: http://localhost:3000
  - service: http_status:404
EOF
```

Replace `<TUNNEL_ID>` with your actual tunnel ID.

---

## Step 12 — Route DNS for the tunnel

```bash
cloudflared tunnel route dns ems-staging app.shabro2a.com
```

This creates a CNAME record in your Cloudflare dashboard pointing `app.shabro2a.com` to the tunnel.

---

## Step 13 — Run cloudflared as a service

```bash
cloudflared service install
systemctl enable cloudflared
systemctl start cloudflared
systemctl status cloudflared
```

Should show `active (running)`. The tunnel is now persistent — survives reboots.

---

## Step 14 — Add Cloudflare Access policy (CRITICAL FOR SECURITY)

This makes it so only YOUR email can log in, not the whole internet.

1. Open Cloudflare Zero Trust dashboard: https://one.dash.cloudflare.com/
2. Go to **Access → Applications → Add an application → Self-hosted**
3. Name: `EMS Login`
4. Domain: `app.shabro2a.com`
5. Path: `/login` (or `/api/auth/login` for the API)
6. Policy: **Allow** → **Emails** → add `rashidakkari@gmail.com` (your email)
7. Save

Now anyone trying to log in to `app.shabro2a.com` gets an email OTP gate first. Only your email passes.

**Repeat for the API**: another application for `app.shabro2a.com/api/*` with the same email policy.

---

## Step 15 — Test from your phone

1. Open `https://app.shabro2a.com` on your phone
2. Cloudflare Access prompts for email → enter your email → get OTP
3. After OTP, see the EMS login page
4. Login as `owner` / `change-me` (or whatever password you set)
5. Should see admin dashboard

**Geolocation works on phone** because:
- URL is HTTPS ✓
- Browser allows geolocation over HTTPS ✓

---

## Step 16 — Capture branch locations

For the 2 branches (Home Office + Tarek Jdedi), use the Record Location button from your phone or laptop while at the actual physical location.

**Important**: phone GPS gives real accuracy (5-30m), laptop gives bad accuracy (150m+). Use phone for Record Location.

---

## Step 17 — Test employee punch from phone

1. Open incognito on your phone
2. Go to `https://app.shabro2a.com/login`
3. Cloudflare Access: enter your email + OTP
4. Login as `emp1 / change-me`
5. Click "Get GPS" → should show "GPS ready (±10m)" (phone has real GPS)
6. Click "CHECK IN" → should succeed
7. Check admin dashboard on your laptop → see emp1 as IN

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `docker compose up` fails | Check `docker compose logs web` |
| Health endpoint returns 500 | Check `docker compose logs web` for stack trace |
| Cloudflare tunnel not connecting | `cloudflared tunnel info ems-staging` + `journalctl -u cloudflared -f` |
| Phone can't reach app | Check VPS is up + tunnel running: `systemctl status cloudflared` |
| Phone geolocation denied | Make sure you're using HTTPS (Cloudflare provides this) |
| Forgot VPS password | Use Coolify web UI to reset, or reinstall VPS via Interserver |

---

## Cleanup

After successful deploy, commit the .env template (without secrets!) to the repo:

```bash
# Back on laptop
cd C:\Users\Admin\Desktop\SH
# Add a .env.example entry for new vars
```

Already done — `.env.example` exists in the repo with all needed keys.

---

## Status: 17 steps. ~30-45 min total.

Most of this is straightforward. The hardest parts:
1. SSH auth on Windows (use Windows Terminal or Coolify terminal if cmd.exe hangs)
2. Cloudflare Access setup (security critical)
3. First GPS test from phone (might need permission granted)

Tell me when each step is done.
