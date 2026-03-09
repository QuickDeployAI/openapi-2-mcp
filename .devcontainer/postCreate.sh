#!/usr/bin/env bash
set -euo pipefail

echo "==> Installing project dependencies..."
npm install

echo "==> Installing act (GitHub Actions local runner) v0.2.84..."
# Pin to a specific release to avoid unexpected breakage
ACT_VERSION="0.2.84"
ACT_ARCHIVE="act_Linux_x86_64.tar.gz"
curl -fsSL "https://github.com/nektos/act/releases/download/v${ACT_VERSION}/${ACT_ARCHIVE}" \
  | sudo tar -xzf - -C /usr/local/bin act

echo "==> Verifying act installation..."
act --version

echo "==> Dev container setup complete."
echo ""
echo "Run 'act -j build-and-test' to locally emulate the CI build-and-test job."
echo "Run 'npm test' to run the test suite directly."
