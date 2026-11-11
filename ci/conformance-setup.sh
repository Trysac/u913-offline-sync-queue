#!/usr/bin/env bash
set -euo pipefail

# Install Chromium browser for Playwright CI conformance tests
npx playwright install --with-deps chromium
