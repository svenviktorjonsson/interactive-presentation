export function applyDataBindings(template: string, data: Record<string, string | number>) {
  const s = String(template ?? "");
  return s.replace(/\{\{\s*([a-zA-Z_]\w*)\s*\}\}/g, (_m, key) => {
    const v = (data as any)[key];
    return v == null ? "" : String(v);
  });
}

