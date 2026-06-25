/**
 * kill_order.cjs
 * ==============
 * Shared kill-order signing + verification for the remote kill switch.
 *
 * WHY THIS MODULE EXISTS:
 *   The canonical HMAC string format was previously duplicated — built inline in
 *   hermes_render_api.js (signer) and supabase_sync_bridge.cjs (verifier). Duplicated
 *   canonicalization is a drift hazard: if either side changes the field order or
 *   delimiter, sign→verify silently breaks and ALL legitimate kill orders are
 *   rejected (fail-closed). This module makes the canonical string live in ONE place.
 *
 *   It also isolates the verifier's secret + nonce store behind a factory so tests
 *   get a fresh, controlled verifier per case (the old module-level `seenNonces`
 *   Set + module-load-time secret read made replay tests non-isolatable).
 *
 * CANONICAL FORMAT (do not change without updating BOTH signer and verifier —
 *   they share this code so that's automatic now):
 *   canonical = agent + "\n" + reason + "\n" + String(issued_at) + "\n" + nonce
 *   signature = HMAC_SHA256(secret, canonical) as hex
 *
 * FRESHNESS / REPLAY:
 *   - Verifier rejects orders older than maxAgeMs (default 5 min) — capture/replay defense.
 *   - Verifier rejects future-timestamped orders.
 *   - Verifier tracks seen nonces; rejects replays within the store.
 */

'use strict';

const crypto = require('crypto');

/**
 * Build the canonical message string. Single source of truth.
 * @param {string} agent
 * @param {string} reason
 * @param {number|string} issuedAt   epoch ms
 * @param {string} nonce
 * @returns {string}
 */
function buildCanonical(agent, reason, issuedAt, nonce) {
  return [agent, reason, String(issuedAt), nonce].join('\n');
}

/**
 * Compute the HMAC-SHA256 signature (hex) for a kill order.
 */
function computeSignature(secret, agent, reason, issuedAt, nonce) {
  return crypto
    .createHmac('sha256', secret)
    .update(buildCanonical(agent, reason, issuedAt, nonce), 'utf8')
    .digest('hex');
}

/**
 * Generate a fresh 16-byte hex nonce.
 */
function generateNonce() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Sign a kill order. Used by the cloud API (hermes_render_api.js).
 *
 * @param {object} params
 * @param {string} params.agent
 * @param {string} params.reason
 * @param {string} params.secret    KILL_ORDER_HMAC_SECRET
 * @param {number} [params.issuedAt]  defaults to Date.now()
 * @param {string} [params.nonce]     defaults to a fresh random nonce
 * @returns {{agent,reason,issuedAt,nonce,signature,ordered_by}}
 */
function signKillOrder({ agent, reason, secret, issuedAt, nonce }) {
  if (!agent) throw new Error('signKillOrder: agent is required');
  if (reason === undefined || reason === null) throw new Error('signKillOrder: reason is required');
  if (!secret) throw new Error('signKillOrder: secret is required');
  const ts = issuedAt ?? Date.now();
  const n = nonce ?? generateNonce();
  const signature = computeSignature(secret, agent, reason, ts, n);
  return {
    agent,
    reason,
    issuedAt: ts,
    nonce: n,
    signature,
    ordered_by: 'goose-cloud-api',
  };
}

/**
 * Create an isolated verifier instance. Used by the bridge (supabase_sync_bridge.cjs)
 * AND by tests (each test gets its own nonce store + clock + secret).
 *
 * @param {object} opts
 * @param {string} opts.secret          KILL_ORDER_HMAC_SECRET (required for verify to pass)
 * @param {number} [opts.maxAgeMs]      default 5 min
 * @param {() => number} [opts.now]     injectable clock
 * @param {number} [opts.nonceStoreMax] clear store when it exceeds this (default 1024)
 */
function createKillOrderVerifier(opts) {
  const secret = opts && opts.secret;
  const maxAgeMs = (opts && opts.maxAgeMs) ?? 5 * 60 * 1000;
  const now = (opts && opts.now) ?? (() => Date.now());
  const nonceStoreMax = (opts && opts.nonceStoreMax) ?? 1024;
  const seenNonces = new Set();

  /**
   * Verify a kill-order row. Returns { ok: true } or { ok: false, reason }.
   * Fail-closed: if the secret isn't configured, ALL orders are rejected.
   *
   * Accepts BOTH field naming conventions:
   *   - camelCase (from signKillOrder): { issuedAt, ... }  — used in tests + direct calls
   *   - snake_case (from Supabase row): { issued_at, ... } — used by the realtime bridge
   * This avoids the field-name drift that previously broke the round-trip.
   *
   * @param {object} row  { agent, reason, issuedAt|issued_at, nonce, signature }
   */
  function verifyKillOrder(row) {
    if (!secret) {
      return { ok: false, reason: 'bridge misconfigured (no secret)' };
    }
    const issuedAt = row && (row.issued_at !== undefined ? row.issued_at : row.issuedAt);
    const { agent, reason, nonce, signature } = row || {};
    if (!agent || reason === undefined || issuedAt === undefined || !nonce || !signature) {
      return { ok: false, reason: 'missing signature fields' };
    }
    // Replay guard.
    if (seenNonces.has(nonce)) {
      return { ok: false, reason: `replayed nonce ${nonce}` };
    }
    // Freshness: reject stale or future orders.
    const age = now() - Number(issuedAt);
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) {
      return { ok: false, reason: `stale/future order (age=${age}ms)` };
    }
    // Constant-time signature comparison.
    const expected = computeSignature(secret, agent, reason, issuedAt, nonce);
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return { ok: false, reason: 'bad signature' };
    }
    seenNonces.add(nonce);
    if (seenNonces.size > nonceStoreMax) seenNonces.clear();
    return { ok: true };
  }

  /** Test/maintenance helper: clear the nonce store. */
  function resetSeenNonces() {
    seenNonces.clear();
  }

  return { verifyKillOrder, resetSeenNonces, maxAgeMs };
}

module.exports = {
  buildCanonical,
  computeSignature,
  generateNonce,
  signKillOrder,
  createKillOrderVerifier,
};
