export { shouldShowBanner } from './regions.js';
export type { JurisdictionInput } from './regions.js';

export {
  CONSENT_KEY,
  defaultConsent,
  loadConsent,
  saveConsent,
  shouldRePrompt,
} from './storage.js';
export type {
  StorageAdapter,
  ConsentChoice,
  ConsentRecord,
  SaveOptions,
  RePromptOptions,
} from './storage.js';

export { initConsentBanner } from './banner.js';
export type { InitOptions } from './banner.js';
