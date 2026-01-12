export function parseInlineParams(s: string): Record<string, string> {
  // Parse "a=b,c=d,labels=[x,y]" (no nested brackets beyond one level).
  const out: Record<string, string> = {};
  let buf = "";
  let depth = 0;
  let inQuotes = false;
  const push = (part: string) => {
    const t = part.trim();
    if (!t) return;
    const eq = t.indexOf("=");
    if (eq < 0) return;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (k) out[k] = v;
  };
  for (const ch of s) {
    if (ch === '"') inQuotes = !inQuotes;
    if (!inQuotes) {
      if (ch === "[") depth += 1;
      if (ch === "]") depth = Math.max(0, depth - 1);
    }
    if (ch === "," && !inQuotes && depth === 0) {
      push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  push(buf);
  return out;
}

export function parseList(v: string | undefined): string[] {
  if (!v) return [];
  let s = v.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const out: string[] = [];
  let buf = "";
  let inQuotes = false;
  let brace = 0;
  for (const ch of s) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      buf += ch;
      continue;
    }
    if (!inQuotes) {
      if (ch === "{") brace += 1;
      else if (ch === "}") brace = Math.max(0, brace - 1);
    }
    if (ch === "," && !inQuotes && brace === 0) {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.map((x) => {
    let t = x.trim();
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
    return t;
  });
}

