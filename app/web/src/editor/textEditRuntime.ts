import type { Store } from "../core/store";

export type TextAlign = "left" | "center" | "right";

export type TextEditSnapshot = {
  model: { nodes: Array<{ id?: string; align?: string }> };
};

export type PersistTextPayload = {
  id: string;
  viewId: string;
  text: string;
  align?: TextAlign;
  bgColor?: string;
  bgAlpha?: number;
  bgPadding?: number;
  bgRadius?: number;
  doc?: "presentation" | "notes";
  space?: "world" | "screen" | "group";
  groupId?: string | null;
};

export type PersistBulletsPayload = {
  id: string;
  viewId: string;
  text: string;
  bullets?: string;
  align?: TextAlign;
  bgColor?: string;
  bgAlpha?: number;
  bgPadding?: number;
  bgRadius?: number;
  doc?: "presentation" | "notes";
  space?: "world" | "screen" | "group";
  groupId?: string | null;
};

export type ActiveTextEditor = {
  nodeId: string;
  el: HTMLTextAreaElement;
  errEl: HTMLDivElement;
  alignEl: HTMLDivElement;
  alignDots: Record<TextAlign, HTMLButtonElement>;
  prevText: string;
  currentAlign: TextAlign;
  everEntered: boolean;
  startSnapshot: TextEditSnapshot;
};

export const normalizeAlign = (value: unknown): TextAlign => {
  if (value === "left" || value === "center" || value === "right") return value;
  return "left";
};

export const updateEditorAlignUi = (editor: ActiveTextEditor, align: TextAlign) => {
  editor.currentAlign = align;
  editor.el.style.textAlign = align;
  (["left", "center", "right"] as TextAlign[]).forEach((key) => {
    editor.alignDots[key].classList.toggle("is-current", key === align);
  });
};

export const editorStartAlignForNode = (snapshot: TextEditSnapshot, nodeId: string): TextAlign => {
  const snapNode = snapshot.model.nodes.find((node) => String(node?.id ?? "") === String(nodeId));
  return normalizeAlign(snapNode?.align);
};

export const applyNodeAlign = (
  store: Store,
  nodeId: string,
  align: TextAlign,
  deps: {
    activeEditor: ActiveTextEditor | null;
    persistViewIdForNode: (node: any, activeViewId: string) => string;
    docForNode: (node: any) => "presentation" | "notes";
    bgPayload: (node: any) => Record<string, unknown>;
    persistText: (payload: PersistTextPayload) => Promise<unknown> | void;
    persistBullets: (payload: PersistBulletsPayload) => Promise<unknown> | void;
  },
) => {
  const node: any = store.model.nodes.find((n: any) => n.id === nodeId);
  if (!node || (node.type !== "text" && node.type !== "bullets")) return;
  node.align = align;
  if (deps.activeEditor && deps.activeEditor.nodeId === nodeId) {
    updateEditorAlignUi(deps.activeEditor, align);
  }
  const groupId = node.groupId ? String(node.groupId) : null;
  const persistViewId = deps.persistViewIdForNode(node, store.activeViewId);
  if (node.type === "text") {
    void deps.persistText({
      id: String(node.id),
      viewId: persistViewId,
      text: String(node.text ?? ""),
      doc: deps.docForNode(node),
      space: groupId ? "group" : node.space,
      align,
      ...deps.bgPayload(node),
      groupId,
    });
  } else {
    void deps.persistBullets({
      id: String(node.id),
      viewId: persistViewId,
      text: String(node.rawText ?? ""),
      bullets: String(node.bullets ?? ""),
      doc: deps.docForNode(node),
      space: groupId ? "group" : node.space,
      align,
      ...deps.bgPayload(node),
      groupId,
    });
  }
};
