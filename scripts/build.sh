#!/usr/bin/env bash
# Builds the release files into dist/:
#   keycloak-logout.zip   the extension folder with the version from VERSION
#   checksums.sha256      SHA-256 of the zip
# The asset name never changes, so releases/latest/download/keycloak-logout.zip
# always points to the newest release.
set -euo pipefail

cd "$(dirname "$0")/.."

version="$(tr -d '[:space:]' < VERSION)"
if ! [[ "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "VERSION must contain X.Y.Z, got '${version}'" >&2
  exit 1
fi

rm -rf dist
mkdir -p dist/keycloak-logout
cp -R extension/. dist/keycloak-logout/
cp VERSION LICENSE dist/keycloak-logout/

# manifest.json in the repository carries 0.0.0; the real version comes only
# from VERSION.
node -e '
  const fs = require("fs");
  const file = process.argv[1];
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  manifest.version = process.argv[2];
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
' dist/keycloak-logout/manifest.json "${version}"

(
  cd dist
  zip -qrX keycloak-logout.zip keycloak-logout -x '*.DS_Store'
  rm -rf keycloak-logout
  if command -v sha256sum >/dev/null; then
    sha256sum keycloak-logout.zip > checksums.sha256
  else
    shasum -a 256 keycloak-logout.zip > checksums.sha256
  fi
)

echo "Built dist/keycloak-logout.zip (version ${version})"
