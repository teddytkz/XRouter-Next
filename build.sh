#!/usr/bin/env bash
set -e

echo "🧹 Cleaning build artifacts..."
rm -rf .next/ .next-cli-build

echo "📦 Building Next.js app..."
npm run build

echo "📋 Running post-build tasks..."
npm run postbuild

echo "📦 Packing CLI..."
npm run cli:pack

echo "✅ Build complete!"
