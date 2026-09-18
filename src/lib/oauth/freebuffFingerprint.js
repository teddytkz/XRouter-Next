/**
 * Freebuff device fingerprint — mirrors the official CLI's
 * cli/src/utils/fingerprint.ts.
 *
 * Upstream fingerprints the *machine* (machineId + SMBIOS serial/uuid + CPU +
 * MAC addresses), and the Codebuff backend keys multi-account-abuse detection
 * on it. A random uuid per login sends the exact signal that system exists to
 * catch, so this must be stable per machine and per OS user, not per login.
 *
 * Same fallback ladder as upstream: enhanced (sha256 of the machine digest) →
 * legacy (`codebuff-cli-<random>`), cached for the process lifetime so every
 * login step ships one fingerprint.
 *
 * Raw id comes from the shared machineId util: it persists the value on disk
 * so CLI/server/middleware (and every process restart) agree on one id.
 */

import { createHash, randomBytes } from "node:crypto";
import { getRawMachineId } from "@/shared/utils/machineId";
import { networkInterfaces, hostname } from "node:os";

let cachedFingerprint = null;

async function calculateEnhancedFingerprint() {
  const id = await getRawMachineId();
  if (!id || id === "unknown" || id.length < 8) throw new Error("invalid machine id");

  const macs = Object.values(networkInterfaces())
    .flat()
    .filter((iface) => iface && !iface.internal && iface.mac && iface.mac !== "00:00:00:00:00:00")
    .map((iface) => iface.mac)
    .sort();

  const digest = JSON.stringify({
    machineId: id,
    macs,
    platform: process.platform,
    arch: process.arch,
    release: process.release?.name || "",
    hostname: hostname(),
    fingerprintVersion: "2.0",
  });

  return `enhanced-${createHash("sha256").update(digest).digest("base64url")}`;
}

function calculateLegacyFingerprint() {
  return `codebuff-cli-${randomBytes(6).toString("base64url").substring(0, 8)}`;
}

export async function getFreebuffFingerprintId() {
  if (cachedFingerprint) return cachedFingerprint;
  try {
    cachedFingerprint = await calculateEnhancedFingerprint();
  } catch {
    cachedFingerprint = calculateLegacyFingerprint();
  }
  return cachedFingerprint;
}
