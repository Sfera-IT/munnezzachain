export let passed = 0;

export function ok(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FALLITO: ${msg}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}

export const section = (title: string) => console.log(`\n${title}`);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
