// Shared error type for every network-backed integration (providers, ScamBusters,
// URLScan, RDAP). Errors cross the worker -> panel boundary as plain objects via
// toPlainError(), so only `code`, `message`, `status`, `retryAfterMs`, `guidance`
// and `details` survive.

/**
 * Error codes:
 *  no_key         - the service needs an API key and none is saved
 *  invalid_key    - the service rejected the key (401 / "Invalid API Key")
 *  expired_key    - ScamBusters 403 expired
 *  not_approved   - ScamBusters 403 not approved to submit
 *  rate_limited   - 429 or provider-specific rate-limit body; see retryAfterMs
 *  network        - fetch failed / timeout / offline
 *  bad_request    - 400 (details may hold a list of strings)
 *  server         - 5xx
 *  unavailable    - ScamBusters 503 approval check unavailable
 *  not_supported  - no lookup implemented for this chain
 *  not_found      - 404 / no data
 *  bad_response   - response could not be parsed / unexpected shape
 */
export class ServiceError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    Object.assign(this, extra); // status, retryAfterMs, guidance, details
  }
}

/** Convert any thrown value into a structured-clone-safe object. Never includes keys. */
export function toPlainError(err) {
  if (err && err.name === 'ServiceError') {
    const out = { code: err.code, message: err.message };
    for (const k of ['status', 'retryAfterMs', 'guidance', 'details']) {
      if (err[k] !== undefined) out[k] = err[k];
    }
    return out;
  }
  return { code: 'internal', message: (err && err.message) || String(err) };
}
