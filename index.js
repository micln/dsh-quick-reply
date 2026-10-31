/**
 * Host half of `dsh-quick-reply`. The feature is browser-only, so the host
 * plugin body is empty; it exists so the plugin is registered in the Loader.
 *
 * @module dsh-quick-reply
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'quick-reply'

/** Host plugin body — no host-side behavior. */
export function apply() {}
