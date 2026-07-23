// Types for vm-host.js — picked up automatically by TypeScript integrators
// importing the sibling .js file. The full window.vm contract this installs
// is documented in README.md ("The window.vm contract").

export interface StartVMOptions {
  /** Cache identity for the FS snapshot; defaults to the manifest buildId. */
  baseEtag?: string;
  /** Base URL the worker fetches blink.js/blink.wasm/manifest assets from. */
  cdnBase?: string;
  /** URL of vm-worker.js (same-origin, or its source is inlined via blob). */
  workerUrl?: string;
  /**
   * Host-side HTTP routes exposed to the guest, keyed by hostname. No hostname
   * is special-cased — any entry (e.g. `api.vm`) is seeded into /etc/hosts and
   * routed the same way. Unknown hosts get a 403.
   */
  vmRoutes?: Record<string, unknown>;
  /**
   * Cap on a guest HTTP request before the bridge synthesizes a 504.
   * Defaults to the worker's 300000 ms.
   */
  proxyTimeoutMs?: number;
}

/** Boot the VM and install window.vm. Idempotent: later calls return the same promise. */
export function startVM(opts?: StartVMOptions): Promise<void>;

/** Fire-and-forget startVM for early warmup; swallows boot errors. */
export function preloadVM(opts?: StartVMOptions): void;
