export function assert(cond: unknown, msg: string): asserts cond {
  if (cond) return;
  // Make failures maximally visible in dev.
  const err = new Error(`[assert] ${msg}`);
  console.error(err);
  throw err;
}

