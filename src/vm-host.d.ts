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
  /** Host-side HTTP routes exposed to the guest at http://api.vm/... */
  vmRoutes?: Record<string, unknown>;
}

/** Boot the VM and install window.vm. Idempotent: later calls return the same promise. */
export function startVM(opts?: StartVMOptions): Promise<void>;

/** Fire-and-forget startVM for early warmup; swallows boot errors. */
export function preloadVM(opts?: StartVMOptions): void;
