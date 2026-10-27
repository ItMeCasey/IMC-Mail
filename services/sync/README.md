# Sync server

Relays encrypted settings records between one person's devices (desktop and phone) at
`https://sync.itmecasey.com`. It stores ciphertext only: the key that opens a record exists on
your devices and never reaches this server. Mail is never sent here.

- One file once built, no packages to install on the droplet. Needs **Node 22.13 or newer** (it uses the built-in `node:sqlite`). The droplet has no system Node; the service runs on a copy of the Node binary kept in `/opt/imc-sync/node`.
- Storage: one SQLite file.
- No accounts or passwords. A device joins a group with a proof derived from a key shown as a QR code on desktop, and then signs every request (ECDSA P-256).
- Limits: 5 new groups per address per hour, 20 join attempts per address per hour, 120 requests a minute per device, 10 devices and 20,000 records per group, 5,000 groups, 4 MB per request.
- API: `POST /v1/groups`, `POST /v1/groups/join`, then signed `POST /v1/sync`, `GET /v1/devices`, `DELETE /v1/devices/:id`, and `GET /healthz`. The wire format lives in `packages/core/src/sync-protocol.ts`.

## 1. Build (on your computer)

```bash
pnpm --filter @imc/sync build
```

This makes `services/sync/dist/server.mjs`.

## 2. Put it on the droplet

```bash
# The droplet has no system Node. Reuse the copy the report relay carries (22.13 or newer is needed):
/opt/imc-report-relay/node/bin/node --version
sudo mkdir -p /opt/imc-sync /var/lib/imc-sync
sudo cp /opt/imc-report-relay/node/bin/node /opt/imc-sync/node
sudo useradd --system --no-create-home --shell /usr/sbin/nologin imcsync
sudo chown imcsync:imcsync /var/lib/imc-sync
```

Copy `dist/server.mjs` to `/opt/imc-sync/server.mjs` (for example with `scp`).

## 3. Run it as a service

Create `/etc/systemd/system/imc-sync.service`:

```ini
[Unit]
Description=IMC-Mail sync server
After=network.target

[Service]
User=imcsync
ExecStart=/opt/imc-sync/node /opt/imc-sync/server.mjs
Environment=PORT=8788
Environment=DB_PATH=/var/lib/imc-sync/sync.sqlite
Environment=TRUST_PROXY=1
Environment=NODE_NO_WARNINGS=1
WorkingDirectory=/var/lib/imc-sync
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/imc-sync

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now imc-sync
curl http://127.0.0.1:8788/healthz        # {"ok":true}
```

## 4. Put nginx and HTTPS in front

`/etc/nginx/sites-available/sync.itmecasey.com`:

```nginx
server {
  server_name sync.itmecasey.com;
  client_max_body_size 5m;
  location / {
    proxy_pass http://127.0.0.1:8788;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Host $host;
  }
}
```

`$remote_addr` (not `$proxy_add_x_forwarded_for`) is deliberate: it overwrites anything a caller sent, so the limits cannot be dodged by faking the header.

```bash
sudo ln -s /etc/nginx/sites-available/sync.itmecasey.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d sync.itmecasey.com
curl https://sync.itmecasey.com/healthz   # {"ok":true}
```

## Where it runs

Deployed on the droplet (reached with `ssh itmecasey-droplet`) as the service `imc-sync`, user `imcsync`, port 8788 behind nginx, with its own certificate for `sync.itmecasey.com`. The `itmecasey.com` site and the report relay (port 8787) are separate and untouched.

## Updating

Build again, copy the new `server.mjs` over the old one, and `sudo systemctl restart imc-sync`. The
database is not touched.

## Backups and moving

Everything is in `/var/lib/imc-sync/sync.sqlite` (plus its `-wal` and `-shm` files while running).
To move to another host: stop the service, copy that folder, start it there, and point the
`sync.itmecasey.com` DNS record at the new address. Devices keep working because they only know the hostname.

## Not handled yet

- Deleted records (tombstones) are kept forever, so a device that was offline for months still learns about deletions. They are small; a clean-up job can come later.
- A removed device loses access at once, but it still holds the data key. Rotating the key to lock it out of future records is a later step.
- Changes are found by asking (every few minutes and on change). A push ping through FCM comes with the Android app.
