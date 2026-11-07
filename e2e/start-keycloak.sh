#!/usr/bin/env bash
# Starts a throwaway Keycloak for the end-to-end test: HTTPS with a self-signed
# certificate on https://localhost:8443<prefix>, the "e2e" realm from
# realm.json, and admin/admin in the master realm.
#
# Usage: e2e/start-keycloak.sh [path-prefix]     e.g. "" or "/auth"
# Stop:  docker rm -f kc-logout-e2e
set -euo pipefail

cd "$(dirname "$0")"
prefix="${1:-}"
image="${KEYCLOAK_IMAGE:-quay.io/keycloak/keycloak:26.8.1}"
name="kc-logout-e2e"

# The certificate is copied into the container, so the local copy is removed
# right away.
certs="$(mktemp -d)"
trap 'rm -rf "${certs}"' EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost" \
  -keyout "${certs}/key.pem" -out "${certs}/cert.pem" 2>/dev/null
# Keycloak runs as a non-root user inside the container.
chmod 644 "${certs}"/*.pem

docker rm -f "${name}" >/dev/null 2>&1 || true
# Published on 127.0.0.1 only: the test credentials stay off the network.
docker create --name "${name}" -p 127.0.0.1:8443:8443 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  -v "${PWD}/realm.json:/opt/keycloak/data/import/realm.json:ro" \
  "${image}" start-dev --import-realm \
  --https-certificate-file=/opt/keycloak/conf/e2e-cert.pem \
  --https-certificate-key-file=/opt/keycloak/conf/e2e-key.pem \
  ${prefix:+--http-relative-path="${prefix}"} >/dev/null
docker cp -q "${certs}/cert.pem" "${name}:/opt/keycloak/conf/e2e-cert.pem"
docker cp -q "${certs}/key.pem" "${name}:/opt/keycloak/conf/e2e-key.pem"
docker start "${name}" >/dev/null

url="https://localhost:8443${prefix}/realms/e2e/.well-known/openid-configuration"
for _ in $(seq 1 90); do
  if curl -ksf "${url}" >/dev/null; then
    echo "Keycloak is ready on https://localhost:8443${prefix}"
    exit 0
  fi
  sleep 2
done

echo "Keycloak did not start in time" >&2
docker logs "${name}" >&2
exit 1
