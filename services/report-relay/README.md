# Report relay

Receives a problem report from IMC-Mail and files it as an issue on GitHub, so people can report
problems without a GitHub account and without a token ever being inside the app.

- Zero dependencies. Needs Node 20 or newer.
- One endpoint: `POST /report` with `{ "title", "body", "version", "platform" }`.
- Removes email addresses, user names in file paths and token-like strings again on the server.
- Limits: 5 reports per address per hour, 200 per day for everyone, 24 KB per report.
- A report with the same title as an open issue is added to it as a comment instead of opening a duplicate.
- Issues get the labels `bug` and `from-app`.

## 1. Make a GitHub token (once)

GitHub does not let a script use your login, so make a limited token instead. It can do one thing
in one repository, and you can revoke it any time.

1. GitHub, your avatar, **Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token**.
2. Name `imc-mail-report-relay`. Expiration: your choice (a year is fine; put a reminder in your calendar).
3. **Repository access: Only select repositories**, then `IMC-Mail`.
4. **Repository permissions: Issues: Read and write.** Leave everything else at "No access".
5. Generate, and copy the token (starts with `github_pat_`). You will paste it on the server in step 3 and nowhere else.

## 2. Put the files on the droplet

```bash
sudo mkdir -p /opt/imc-report-relay
sudo cp relay.mjs server.mjs package.json /opt/imc-report-relay/
sudo useradd --system --no-create-home --shell /usr/sbin/nologin imcrelay
```

## 3. Run it as a service

Create `/etc/systemd/system/imc-report-relay.service`:

```ini
[Unit]
Description=IMC-Mail report relay
After=network.target

[Service]
User=imcrelay
WorkingDirectory=/opt/imc-report-relay
ExecStart=/usr/bin/node server.mjs
Environment=PORT=8787
Environment=TRUST_PROXY=1
Environment=GITHUB_REPO=ItMeCasey/IMC-Mail
# The token goes in a file only root can read, not in this unit:
EnvironmentFile=/etc/imc-report-relay.env
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Create `/etc/imc-report-relay.env` with one line, then lock it down:

```bash
echo 'GITHUB_TOKEN=github_pat_PASTE_YOURS_HERE' | sudo tee /etc/imc-report-relay.env >/dev/null
sudo chmod 600 /etc/imc-report-relay.env
sudo systemctl daemon-reload
sudo systemctl enable --now imc-report-relay
sudo systemctl status imc-report-relay
```

## 4. Put it behind nginx on your site

Inside the `server { ... }` block for your site (it must be served over HTTPS):

```nginx
location = /imc-mail/report {
    proxy_pass http://127.0.0.1:8787/report;
    proxy_set_header X-Forwarded-For $remote_addr;   # overwrite, so callers cannot fake their address
    client_max_body_size 32k;
    limit_except POST { deny all; }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 5. Try it

```bash
curl -s -X POST https://YOUR-SITE/imc-mail/report \
  -H 'Content-Type: application/json' \
  -d '{"title":"Relay test","body":"Testing the relay, please close this issue.","version":"0","platform":"test"}'
```

You should get `{"ok":true,"url":"https://github.com/ItMeCasey/IMC-Mail/issues/N",...}` and see the
issue on GitHub. Close it.

## 6. Tell the app where it is

Put the address in `REPORT_RELAY_URL` in `packages/core/src/report.ts` (for example
`https://YOUR-SITE/imc-mail/report`) and rebuild. Until it is set, the app only offers
"Open on GitHub". For a quick try on one computer, set the `IMC_REPORT_URL` environment variable
instead.

## Notes

- Anyone who finds the address can post to it. That is unavoidable for an app people install, so
  the protections are the limits above, not a secret. If it is ever abused, rotate the token and
  change the path.
- The token can only touch issues in this one repository. Do not give it more.
- Logs: `journalctl -u imc-report-relay`.
