# Deploying Pebble Diagnostics to exe.dev

The service expects an exe.dev VM named `pebble`, Node.js 22.16 or newer,
`age`, `curl`, and systemd. Deployment contains no endpoint keys, error data, or
private backup material.

## One-time VM setup

Creating the VM and changing its proxy are external writes; run these only after
the user authorizes them:

```sh
ssh exe.dev new --name=pebble --comment='Pebble Diagnostics' --json
ssh exe.dev share port pebble 8000
ssh exe.dev share set-public pebble
```

The proxy must be public so native clients can reach it without exe.dev's
interactive login. The service still rejects every data request without its own
role-limited key. Only `GET /healthz` is anonymous.

Verify the runtime before copying a release:

```sh
ssh pebble.exe.xyz 'id -un; node --version; node -e "if(typeof require(\"node:sqlite\").backup!==\"function\")process.exit(1)"; command -v age; systemctl --version | head -1'
```

The expected SSH login user is `exedev`. The release installer creates a
separate locked `pebble-diagnostics` service account with no supplementary
groups; the public service and backup job never run with the login account's
Docker or administrative groups. Install Node 22 and `age` if either check
fails.

## Upload and activate one immutable release

Hash and upload the exact tested service files. This works from an uncommitted
worktree and deliberately excludes databases, tests, and other local files:

```sh
SERVICE_DIR=services/pebble-diagnostics
RELEASE_FILES=(package.json admin.mjs http.mjs security.mjs server.mjs store.mjs \
  deploy/install-release.sh deploy/pebble-diagnostics.service \
  deploy/pebble-diagnostics-backup.service \
  deploy/pebble-diagnostics-backup.timer)
RELEASE_MANIFEST="$(
  cd "$SERVICE_DIR"
  for file in "${RELEASE_FILES[@]}"; do shasum -a 256 "$file"; done
)"
RELEASE="$(printf '%s\n' "$RELEASE_MANIFEST" | shasum -a 256 | cut -c1-16)"
ssh pebble.exe.xyz "test ! -e /opt/pebble-diagnostics/releases/${RELEASE} && sudo install -d -m 0755 /opt/pebble-diagnostics/releases/${RELEASE}"
(cd "$SERVICE_DIR" && tar -cf - "${RELEASE_FILES[@]}") \
  | ssh pebble.exe.xyz "sudo tar -x -C /opt/pebble-diagnostics/releases/${RELEASE}"
ssh pebble.exe.xyz "sudo /opt/pebble-diagnostics/releases/${RELEASE}/deploy/install-release.sh /opt/pebble-diagnostics/releases/${RELEASE}"
```

The content hash names an immutable release. The activation script makes every
release file root-owned and read-only to the dedicated service account. Before
activation it recomputes the documented ten-file manifest and requires its
16-character hash to match the release directory name. It then points
`/opt/pebble-diagnostics/current` at the release, restarts the systemd service,
and checks local health. If activation fails, it restores both the previous
symlink and the previous systemd unit files before reloading systemd and
restarting the prior release.
SQLite state remains at
`/var/lib/pebble-diagnostics/errors.sqlite3` across releases.

## Configure administrator access and keys

The activation script creates a root-only session-signing credential if one
does not already exist. Set the standalone administrator password through
stdin so it never appears in shell history or process arguments. Keep the raw
password in macOS Keychain; SQLite stores only its salted scrypt hash.

```sh
read -s 'PEBBLE_ADMIN_PASSWORD?Pebble Diagnostics administrator password: '
printf '%s' "$PEBBLE_ADMIN_PASSWORD" | security add-generic-password -U \
  -a "$USER" -s pebble-diagnostics-admin -w
printf '%s\n' "$PEBBLE_ADMIN_PASSWORD" | ssh pebble.exe.xyz \
  'sudo -u pebble-diagnostics env PEBBLE_DIAGNOSTICS_DB=/var/lib/pebble-diagnostics/errors.sqlite3 node /opt/pebble-diagnostics/current/admin.mjs admin set-password'
unset PEBBLE_ADMIN_PASSWORD
```

Then sign in at `https://pebble.exe.xyz/diagnostics`. Create the diagnostic key
and copy that same write-only value into Agents, CPAP, Air Quality, and Hubitat. The raw
key is shown only in the creation response. Recreating it invalidates the
previous shared key immediately, so update every app after rotation.

The Codex query key remains a separate read-only capability. Issue it from a
private terminal and store it in macOS Keychain:

```sh
PEBBLE_DIAGNOSTICS_READ_JSON="$(ssh pebble.exe.xyz \
  'sudo -u pebble-diagnostics env PEBBLE_DIAGNOSTICS_DB=/var/lib/pebble-diagnostics/errors.sqlite3 node /opt/pebble-diagnostics/current/admin.mjs key issue --role read --label codex')"
PEBBLE_DIAGNOSTICS_READ_KEY="$(printf '%s' "$PEBBLE_DIAGNOSTICS_READ_JSON" | jq -r .token)"
printf '%s' "$PEBBLE_DIAGNOSTICS_READ_KEY" | security add-generic-password -U \
  -a "$USER" -s pebble-diagnostics-read -w
unset PEBBLE_DIAGNOSTICS_READ_KEY
unset PEBBLE_DIAGNOSTICS_READ_JSON
```

Revoke by the non-secret fingerprint returned during issuance:

```sh
ssh pebble.exe.xyz sudo -u pebble-diagnostics env \
  PEBBLE_DIAGNOSTICS_DB=/var/lib/pebble-diagnostics/errors.sqlite3 \
  node /opt/pebble-diagnostics/current/admin.mjs key revoke \
  --fingerprint FINGERPRINT
```

## Encrypted daily backups

Keep the SSH private key off the VM. Copy only the existing public key as the
age recipient, then enable the timer:

```sh
test -f ~/.ssh/id_ed25519.pub
ssh pebble.exe.xyz 'sudo tee /etc/pebble-diagnostics/age-recipient.txt >/dev/null' \
  < ~/.ssh/id_ed25519.pub
ssh pebble.exe.xyz 'sudo chmod 0644 /etc/pebble-diagnostics/age-recipient.txt && sudo systemctl enable --now pebble-diagnostics-backup.timer'
```

The timer makes an online SQLite snapshot, encrypts it before final placement,
retains 30 days of matching snapshots, and records success only after
encryption succeeds. Check it with:

```sh
ssh pebble.exe.xyz 'sudo systemctl start pebble-diagnostics-backup.service && sudo systemctl status --no-pager pebble-diagnostics-backup.service'
ssh pebble.exe.xyz 'sudo systemctl list-timers pebble-diagnostics-backup.timer --no-pager'
```

Backups land in `/var/backups/pebble-diagnostics`. Copy them to a separate
failure domain; same-VM snapshots alone are not disaster recovery.

## Health and host diagnostics

```sh
curl --fail --silent https://pebble.exe.xyz/healthz
ssh pebble.exe.xyz 'sudo systemctl status --no-pager pebble-diagnostics.service'
ssh pebble.exe.xyz 'sudo journalctl -u pebble-diagnostics.service --since today --no-pager'
tools/pebble-errors status
```
