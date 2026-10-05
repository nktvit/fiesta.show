import { environment } from '../../environments/environment';

/**
 * Which deployment this build is: 'production' | 'preview' | 'development'.
 * scripts/set-env.js stamps it from VERCEL_ENV at build time. A local environment.ts
 * generated before the field existed has no value, which means local development.
 */
export const DEPLOY_ENV: string = (environment as { deployEnv?: string }).deployEnv ?? 'development';

/** True on previews and local dev, false on the production site. Gates internal-only UI. */
export const IS_PREVIEW_OR_DEV = DEPLOY_ENV !== 'production';
