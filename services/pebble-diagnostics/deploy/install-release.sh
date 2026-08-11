#!/usr/bin/env bash
set -euo pipefail

APP_ROOT=/opt/pebble-diagnostics
SERVICE=pebble-diagnostics.service
SERVICE_USER=pebble-diagnostics
SERVICE_GROUP=pebble-diagnostics
RELEASE="${1:-}"
RELEASE_FILES=(
  package.json admin.mjs http.mjs security.mjs server.mjs store.mjs
  deploy/install-release.sh deploy/pebble-diagnostics.service
  deploy/pebble-diagnostics-backup.service deploy/pebble-diagnostics-backup.timer
)
UNITS=(
  pebble-diagnostics.service
  pebble-diagnostics-backup.service
  pebble-diagnostics-backup.timer
)

if [[ "${EUID}" -ne 0 ]]; then
  echo "run as root: sudo $0 /opt/pebble-diagnostics/releases/<content-hash>" >&2
  exit 2
fi
if [[ -z "${RELEASE}" ]]; then
  echo "release directory is required" >&2
  exit 2
fi
RELEASE="$(readlink -f "${RELEASE}")"
[[ -d "${RELEASE}" && "${RELEASE%/*}" == "${APP_ROOT}/releases" ]] || {
  echo "release must be a directory directly below ${APP_ROOT}/releases" >&2
  exit 2
}
RELEASE_NAME="${RELEASE##*/}"
[[ "${RELEASE_NAME}" =~ ^[0-9a-f]{16}$ ]] || {
  echo "release directory name must be a 16-character content hash" >&2
  exit 2
}
for FILE in "${RELEASE_FILES[@]}"; do
  [[ -f "${RELEASE}/${FILE}" && ! -L "${RELEASE}/${FILE}" ]] || {
    echo "release is missing regular file ${FILE}" >&2
    exit 2
  }
done
ACTUAL_HASH="$(
  cd "${RELEASE}"
  /usr/bin/node -e '
    const {createHash} = require("node:crypto");
    const {readFileSync} = require("node:fs");
    const manifest = process.argv.slice(1).map((file) =>
      `${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${file}`
    ).join("\n") + "\n";
    process.stdout.write(createHash("sha256").update(manifest).digest("hex").slice(0, 16));
  ' "${RELEASE_FILES[@]}"
)"
[[ "${ACTUAL_HASH}" == "${RELEASE_NAME}" ]] || {
  echo "release hash mismatch: expected ${RELEASE_NAME}, computed ${ACTUAL_HASH}" >&2
  exit 2
}
/usr/bin/node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<16)||typeof require('node:sqlite').backup!=='function')process.exit(1)"

if ! getent group "${SERVICE_GROUP}" >/dev/null; then
  groupadd --system "${SERVICE_GROUP}"
fi
if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --gid "${SERVICE_GROUP}" --home-dir /var/lib/pebble-diagnostics \
    --no-create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
fi
[[ "$(id -g "${SERVICE_USER}")" == "$(getent group "${SERVICE_GROUP}" | cut -d: -f3)" ]] || {
  echo "${SERVICE_USER} must use ${SERVICE_GROUP} as its primary group" >&2
  exit 2
}
[[ "$(id -G "${SERVICE_USER}")" == "$(id -g "${SERVICE_USER}")" ]] || {
  echo "${SERVICE_USER} must not belong to supplementary groups" >&2
  exit 2
}

chown -R root:root "${RELEASE}"
chmod -R u=rwX,go=rX "${RELEASE}"
install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 0700 /var/lib/pebble-diagnostics
install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 0700 /var/backups/pebble-diagnostics
chown -R "${SERVICE_USER}:${SERVICE_GROUP}" /var/lib/pebble-diagnostics /var/backups/pebble-diagnostics
install -d -o root -g root -m 0755 /etc/pebble-diagnostics
if [[ ! -s /etc/pebble-diagnostics/session-secret ]]; then
  umask 077
  /usr/bin/node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))" \
    > /etc/pebble-diagnostics/session-secret
fi
chown root:root /etc/pebble-diagnostics/session-secret
chmod 0600 /etc/pebble-diagnostics/session-secret
ROLLBACK_DIR="$(mktemp -d)"
trap 'rm -rf -- "${ROLLBACK_DIR}"' EXIT
for UNIT in "${UNITS[@]}"; do
  UNIT_PATH="/etc/systemd/system/${UNIT}"
  if [[ -e "${UNIT_PATH}" || -L "${UNIT_PATH}" ]]; then
    cp -a -- "${UNIT_PATH}" "${ROLLBACK_DIR}/${UNIT}"
  fi
done
if [[ -L "${APP_ROOT}/current" ]]; then
  HAD_PREVIOUS=1
  PREVIOUS="$(readlink "${APP_ROOT}/current")"
elif [[ -e "${APP_ROOT}/current" ]]; then
  echo "${APP_ROOT}/current must be a symlink" >&2
  exit 2
else
  HAD_PREVIOUS=0
  PREVIOUS=""
fi

activate() {
  local unit
  for unit in "${UNITS[@]}"; do
    install -m 0644 "${RELEASE}/deploy/${unit}" /etc/systemd/system/ || return 1
  done
  ln -sfn "${RELEASE}" "${APP_ROOT}/current.next" || return 1
  mv -Tf "${APP_ROOT}/current.next" "${APP_ROOT}/current" || return 1
  systemctl daemon-reload || return 1
  systemctl enable "${SERVICE}" || return 1
  systemctl restart "${SERVICE}" || return 1
  for _ in {1..20}; do
    if curl --fail --silent --show-error http://127.0.0.1:8000/healthz >/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

rollback() {
  local failed=0 unit unit_path
  rm -f -- "${APP_ROOT}/current.next" "${APP_ROOT}/current.rollback" || failed=1
  for unit in "${UNITS[@]}"; do
    unit_path="/etc/systemd/system/${unit}"
    rm -f -- "${unit_path}" || failed=1
    if [[ -e "${ROLLBACK_DIR}/${unit}" || -L "${ROLLBACK_DIR}/${unit}" ]]; then
      cp -a -- "${ROLLBACK_DIR}/${unit}" "${unit_path}" || failed=1
    fi
  done
  if (( HAD_PREVIOUS )); then
    ln -sfn "${PREVIOUS}" "${APP_ROOT}/current.rollback" || failed=1
    mv -Tf "${APP_ROOT}/current.rollback" "${APP_ROOT}/current" || failed=1
  else
    rm -f -- "${APP_ROOT}/current" || failed=1
  fi
  systemctl daemon-reload || failed=1
  if (( HAD_PREVIOUS )); then
    systemctl restart "${SERVICE}" || failed=1
  else
    systemctl disable --now "${SERVICE}" || failed=1
  fi
  return "${failed}"
}

if activate; then
  echo "activated ${RELEASE}"
  exit 0
fi

echo "activation or health check failed; rolling back" >&2
if ! rollback; then
  echo "rollback was incomplete; inspect systemd and ${APP_ROOT}/current" >&2
fi
exit 1
