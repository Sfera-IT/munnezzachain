export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const versionListeners = new Set<(v: string) => void>();
export const onServerVersion = (fn: (v: string) => void) => versionListeners.add(fn);

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("content-type", "application/json");
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body, credentials: "same-origin" });
  } catch {
    // navigator.onLine can say true with no usable connection (weak signal, some browsers): report what happened.
    window.dispatchEvent(new CustomEvent("connectivity", { detail: false }));
    throw new ApiError(0, "Connessione assente o server non raggiungibile");
  }
  window.dispatchEvent(new CustomEvent("connectivity", { detail: true }));
  const serverVersion = res.headers.get("x-app-version");
  if (serverVersion) versionListeners.forEach((fn) => fn(serverVersion));
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Errore ${res.status}`);
  return data as T;
}

export interface Me {
  id: string;
  email: string;
  name: string;
  role: "operatore" | "admin";
  mustChangePassword: boolean;
}

export interface Config {
  turnstileSiteKey: string | null;
  publicAreaBbox: number[] | null;
  privacyContact: string | null;
  timestamping: boolean;
  rejectionReasons: Record<string, string>;
}

export const session: { me: Me | null; config: Config | null } = { me: null, config: null };

export async function refreshSession() {
  const [me, config] = await Promise.all([
    api<{ user: Me | null }>("/auth/me").catch(() => ({ user: null })),
    session.config ? Promise.resolve(session.config) : api<Config>("/config").catch(() => null),
  ]);
  session.me = me.user;
  session.config = config;
}

/** Logged in with a password of their own: the only state in which the server treats a request as an operator's. */
export const isOperator = () => Boolean(session.me && !session.me.mustChangePassword);
export const isAdmin = () => isOperator() && session.me!.role === "admin";
