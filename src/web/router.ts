export type ViewResult = HTMLElement | { el: HTMLElement; cleanup?: () => void };
type Route = { pattern: RegExp; view: (...params: string[]) => ViewResult | Promise<ViewResult> };

const routes: Route[] = [];
let cleanup: (() => void) | undefined;
let outlet: HTMLElement;

export function route(path: string, view: Route["view"]) {
  routes.push({ pattern: new RegExp(`^${path.replace(/:[a-z]+/g, "([^/]+)")}$`), view });
}

export function navigate(hash: string) {
  if (location.hash === hash) void render();
  else location.hash = hash;
}

export async function render() {
  const path = location.hash.replace(/^#/, "") || "/";
  const match = routes.map((r) => ({ r, m: r.pattern.exec(path) })).find((x) => x.m);
  cleanup?.();
  cleanup = undefined;
  if (!match) {
    location.hash = "#/";
    return;
  }
  outlet.setAttribute("aria-busy", "true");
  try {
    const result = await match.r.view(...match.m!.slice(1).map(decodeURIComponent));
    const el = result instanceof HTMLElement ? result : result.el;
    cleanup = result instanceof HTMLElement ? undefined : result.cleanup;
    outlet.replaceChildren(el);
  } catch (e) {
    const div = document.createElement("div");
    div.className = "card notice notice-bad";
    div.textContent = (e as Error).message;
    outlet.replaceChildren(div);
  } finally {
    outlet.removeAttribute("aria-busy");
    window.scrollTo(0, 0);
    outlet.querySelector("h1")?.setAttribute("tabindex", "-1");
    (outlet.querySelector("h1") as HTMLElement | null)?.focus({ preventScroll: true });
  }
}

export function startRouter(el: HTMLElement) {
  outlet = el;
  window.addEventListener("hashchange", () => void render());
  void render();
}
