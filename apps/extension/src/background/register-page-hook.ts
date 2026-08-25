const PAGE_HOOK_SCRIPT_ID = 'svelte-lens-page-hook';

const pageHookRegistration: chrome.scripting.RegisteredContentScript = {
  id: PAGE_HOOK_SCRIPT_ID,
  matches: ['<all_urls>'],
  js: ['page-hook.js'],
  runAt: 'document_start',
  world: 'MAIN',
  allFrames: false,
  persistAcrossSessions: true
};

const retryDelays = [50, 200, 800, 2_000] as const;
let activeRegistration: Promise<void> | null = null;

/** Coalesce lifecycle events and tolerate a transient MV3 worker-start race. */
export function ensurePageHookRegistered(): Promise<void> {
  if (activeRegistration) return activeRegistration;
  activeRegistration = registerWithRetry().finally(() => {
    activeRegistration = null;
  });
  return activeRegistration;
}

async function registerWithRetry(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      const existing = await chrome.scripting.getRegisteredContentScripts({
        ids: [PAGE_HOOK_SCRIPT_ID]
      });
      if (existing.length === 0) {
        await chrome.scripting.registerContentScripts([pageHookRegistration]);
      } else {
        await chrome.scripting.updateContentScripts([pageHookRegistration]);
      }
      return;
    } catch (error) {
      lastError = error;
      const delay = retryDelays[attempt];
      if (delay === undefined) break;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
