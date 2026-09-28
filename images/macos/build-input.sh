#!/bin/sh
# Builds proofbox's macOS input helper on this Mac and prints its sha256,
# which src/tool-bundle.ts pins. Run it from the repo root.
set -eu

swiftc -O -target arm64-apple-macos14 -o images/macos/input/proofbox-input images/macos/input/main.swift &&
  shasum -a 256 images/macos/input/proofbox-input
