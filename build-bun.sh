#!/usr/bin/env bash
set -e

echo "🧹 Cleaning build artifacts..."
rm -rf .next/ .next-cli-build

echo "📦 Building Next.js app..."
bun run build:bun

echo "📋 Running post-build tasks..."
bun run postbuild:bun

echo "📦 Packing CLI..."
bun run cli:pack

echo "✅ Build complete!"
