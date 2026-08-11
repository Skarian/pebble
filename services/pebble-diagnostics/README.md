# Pebble Diagnostics

Pebble Diagnostics is an opt-in, append-only error journal for the Pebble apps
in this repository. It stores the original sanitized source error, not success
events, inferred categories, UI states, or translated messages.

The service has no production dependencies beyond Node.js 22.16 or newer and
its built-in `node:sqlite` module.

## Record and ingestion contract

Clients send one bounded batch with the shared write-only diagnostic key:

```http
POST /v1/errors
X-Pebble-Diagnostics-Key: pdiag_d_...
Content-Type: application/json

{
  "records": [{
    "id": "stable-local-record-id",
    "at": "2026-08-10T15:42:18.231Z",
    "source": "cpap/pkjs@0.1.0",
    "while": "refreshing CPAP scores",
    "error": {
      "name": "HttpError",
      "message": "400 Bad Request",
      "status": 400,
      "body": {"error": "invalid_grant"},
      "stack": "..."
    }
  }]
}
```

The ACK is exactly:

```json
{"accepted":["stable-local-record-id"]}
```

Clients remove only IDs present in `accepted`. Repeating the same ID and
content is safe and returns the ID again. Reusing an ID for different content
returns HTTP 409. A batch is validated, source-checked, capacity-checked, and
committed as one unit, so there is no ambiguous partial ACK.

`id` is upload bookkeeping only. `at` must be canonical millisecond UTC text
(`YYYY-MM-DDTHH:mm:ss.sssZ`) and is returned unchanged. Read APIs return the
exact four public fields: `at`, `source`, `while`, and `error`.

## Authentication

The password-protected page at `/diagnostics` creates one 256-bit diagnostic
key for every Pebble app and shows it once. Recreating it atomically revokes
the previous shared key. SQLite stores only its SHA-256 hash. This key can
write errors but cannot read them or administer the service. A separate
read-only key is used by `tools/pebble-errors`.

Administrator access follows the same standalone model as the Aranet service:
the password is scrypt-hashed in SQLite, browser sessions use signed 12-hour
`Secure`, `HttpOnly`, `SameSite=Strict` cookies, and mutating forms require a
same-origin CSRF token. The initial password and later password resets are
accepted only over the SSH administration command, never through a public
first-run page.

The service assumes reporters have already applied surgical redaction. It does
not rewrite, classify, or broadly remove error data. Never send credentials,
authorization headers, cookies, dictation transcripts, or user message bodies.

## Read API

Every read API route requires the separate read key in
`X-Pebble-Diagnostics-Key`. Ingestion uses the diagnostic key; browser
administration uses the standalone password.

- `GET /healthz` — anonymous process/database readiness, with no journal detail.
- `GET /v1/errors?since=30d&source=agents/watch&limit=100&before=CURSOR`
- `GET /v1/errors/search?q=invalid_grant&since=30d&limit=100&before=CURSOR`
- `GET /v1/status` — record range, database/ceiling bytes, capacity rejections,
  and last successful backup.

Search uses a SQLite full-text index over the preserved record JSON. Pages
contain `{ "records": [...], "next": CURSOR_OR_NULL }`. `limit` is at
most 500. `source` matches an app or runtime prefix and `since` accepts an ISO
timestamp or a duration ending in `m`, `h`, `d`, or `w`.

## Capacity and retention

Accepted records are not automatically removed. SQLite is capped at 512 MiB
and requests are preflighted before a transaction. When the journal cannot
accept a complete batch, POST returns HTTP 507, no record in that batch is
accepted, and `GET /v1/status` exposes the rejection count. Explicit purging is
an administrative action:

```sh
PEBBLE_DIAGNOSTICS_DB=./data/errors.sqlite3 \
node admin.mjs purge --before 180d
```

Encrypted VM snapshots are separate from journal retention. The daily backup
job removes only its own matching snapshots after 30 days.

## Local development

```sh
npm test
printf '%s\n' 'local-administrator-password' | env \
  PEBBLE_DIAGNOSTICS_DB=./data/errors.sqlite3 node admin.mjs admin set-password
PEBBLE_DIAGNOSTICS_DB=./data/errors.sqlite3 \
  node admin.mjs key issue --role read --label local-reader
PEBBLE_DIAGNOSTICS_SESSION_SECRET=local-development-session-secret-change-me \
  npm start
```

Environment variables:

- `PEBBLE_DIAGNOSTICS_HOST` (default `127.0.0.1`)
- `PEBBLE_DIAGNOSTICS_PORT` (default `8000`)
- `PEBBLE_DIAGNOSTICS_DB` (default `./data/errors.sqlite3`)
- `PEBBLE_DIAGNOSTICS_MAX_BYTES` (default `536870912`)
- `PEBBLE_DIAGNOSTICS_PUBLIC_URL` (default `https://pebble.exe.xyz`)
- `PEBBLE_DIAGNOSTICS_SESSION_SECRET` (local development only; production uses
  a systemd credential)

See [deploy/README.md](deploy/README.md) for the secret-free exe.dev release,
systemd, rollback, and encrypted-backup procedure. Use
`../../tools/pebble-errors` for read-only queries.
