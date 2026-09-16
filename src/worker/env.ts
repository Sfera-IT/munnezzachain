export interface Env {
  DB: D1Database;
  EVIDENCE: R2Bucket;
  ASSETS: Fetcher;
  PUBLIC_SUBMIT_LIMITER: RateLimit;
  LOGIN_LIMITER: RateLimit;
  /** Set at deploy time; the PWA compares it with its own build to detect a stale copy. */
  APP_VERSION?: string;
  TSA_URL: string;
  TSA_USERNAME?: string;
  TSA_PASSWORD?: string;
  /** "minLon,minLat,maxLon,maxLat": public reports outside it are refused. Empty means anywhere. */
  PUBLIC_AREA_BBOX?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** Contact shown in the privacy notice; set by the data controller. */
  PRIVACY_CONTACT?: string;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: "operatore" | "admin";
  mustChangePassword: boolean;
}

export type AppEnv = { Bindings: Env; Variables: { user: SessionUser | null } };
