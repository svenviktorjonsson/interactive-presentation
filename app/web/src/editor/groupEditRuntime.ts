import type { Store } from "../core/store";
import { normalizeAlign } from "./textEditRuntime";

export type GroupEditSnapshot = {
  model: any;
  activeViewId: string;
  selectedId: string | null;
  selectedIds: string[];
};

type PersistDoc = "presentation" | "notes";

type GroupEditDeps = {
  store: Store & {
    activeGroupId?: string | null;
    selectedId: string | null;
    selectedIds: string[];
    activeViewId: string;
    model: { nodes: any[] };
  };
  newId: (prefix?: string) => string;
  clearSelection: () => void;
  updateHandles: () => void;
  setSingleSelection: (id: string | null) => void;
  setMultiSelection: (ids: string[], preferredPrimary?: string | null) => void;
  snapshotNow: () => GroupEditSnapshot;
  pushUndo: (snap: GroupEditSnapshot) => void;
  aabbForNodeInSpace: (node: any) => { minX: number; minY: number; maxX: number; maxY: number };
  anchorFrac: (anchor: any) => { ax: number; ay: number };
  docForNode: (node: any) => PersistDoc;
  persistViewIdForNode: (node: any, activeViewId: string) => string;
  bgPayload: (node: any) => Record<string, unknown>;
  normalizeTransformForPersist: (
    store: Store,
    transform: any,
    viewId: string,
    space: string | undefined,
    groupId?: string | null
  ) => any;
  normalizePointForPersist: (
    store: Store,
    point: { x: number; y: number },
    viewId: string,
    space: string | undefined,
    groupId?: string | null
  ) => { x: number; y: number };
  persistText: (payload: any) => Promise<unknown> | void;
  persistBullets: (payload: any) => Promise<unknown> | void;
  persistImage: (payload: any) => Promise<unknown> | void;
  persistJoin: (payload: any) => Promise<unknown> | void;
  persistArrow: (payload: any) => Promise<unknown> | void;
  persistGeometry: (payload: any) => Promise<unknown> | void;
  persistElement: (payload: any) => Promise<unknown> | void;
  persistGroup: (payload: any) => Promise<unknown> | void;
  persistDelete: (payload: any) => Promise<unknown> | void;
};

export const createGroupEditRuntime = (deps: GroupEditDeps) => {
  const groupChildren = (groupId: string) =>
    (deps.store.model.nodes as any[]).filter((n) => String(n?.groupId ?? "") === String(groupId));

  const groupDescendants = (groupId: string) => {
    const gid = String(groupId);
    const byId = new Map((deps.store.model.nodes as any[]).map((n) => [String(n?.id ?? ""), n]));
    const out: any[] = [];
    for (const n of deps.store.model.nodes as any[]) {
      if (!n) continue;
      let cursor = String(n.groupId ?? "");
      while (cursor) {
        if (cursor === gid) {
          out.push(n);
          break;
        }
        const parent = byId.get(cursor);
        cursor = parent ? String(parent.groupId ?? "") : "";
      }
    }
    return out;
  };

  const getCompositeTypeForGroup = (nodes: any[], groupId: string) => {
    const gid = String(groupId ?? "");
    if (!gid) return null;
    for (const child of nodes) {
      if (String((child as any)?.groupId ?? "") !== gid) continue;
      for (const [key, value] of Object.entries(child as any)) {
        if (key === "groupId" || !key.endsWith("Id")) continue;
        if (String(value ?? "") === gid) return key.slice(0, -2);
      }
    }
    return null;
  };

  const buildCompositeAttrs = (node: any, type: string) => {
    const attrs: Record<string, unknown> = {};
    const prefix = String(type ?? "");
    if (node?.bgColor) attrs.bgColor = node.bgColor;
    if (node?.bgAlpha != null) attrs.bgAlpha = node.bgAlpha;
    if (node?.bgPadding != null) attrs.bgPadding = node.bgPadding;
    if (node?.bgRadius != null) attrs.bgRadius = node.bgRadius;
    if (!prefix) return attrs;
    for (const [key, value] of Object.entries(node ?? {})) {
      if (!key.startsWith(prefix) || key.length <= prefix.length) continue;
      const suffix = key.slice(prefix.length);
      if (suffix === "Id" || suffix === "Role") continue;
      const attrKey = suffix[0]!.toLowerCase() + suffix.slice(1);
      if (value === undefined || value === null) continue;
      attrs[attrKey] = value;
    }
    return attrs;
  };

  const persistNodeToParent = (node: any, parentGroupId: string | null) => {
    const doc = deps.docForNode(node);
    const viewId = parentGroupId ? "group" : deps.persistViewIdForNode(node, deps.store.activeViewId);
    const groupId = parentGroupId;
    if (node.type === "text") {
      void deps.persistText({
        id: String(node.id),
        viewId,
        text: String(node.text ?? ""),
        doc,
        space: groupId ? "group" : node.space,
        align: normalizeAlign(node.align),
        ...deps.bgPayload(node),
        groupId,
      });
    } else if (node.type === "bullets") {
      void deps.persistBullets({
        id: String(node.id),
        viewId,
        text: String(node.rawText ?? ""),
        bullets: String(node.bullets ?? ""),
        doc,
        space: groupId ? "group" : node.space,
        align: normalizeAlign(node.align),
        ...deps.bgPayload(node),
        groupId,
      });
    } else if (node.type === "image") {
      void deps.persistImage({ id: String(node.id), viewId, src: node.src, doc, space: groupId ? "group" : node.space, groupId, ...deps.bgPayload(node) });
    } else if (node.type === "join") {
      void deps.persistJoin({
        id: String(node.id),
        viewId,
        text: String(node.text ?? ""),
        fields: Array.isArray(node.fields) ? node.fields : [],
        doc,
        space: groupId ? "group" : node.space,
        ...deps.bgPayload(node),
        groupId,
      });
    } else if (node.type === "arrow") {
      const start = deps.normalizePointForPersist(deps.store, node.start ?? { x: 0, y: 0.5 }, viewId, node.space, groupId);
      const end = deps.normalizePointForPersist(deps.store, node.end ?? { x: 1, y: 0.5 }, viewId, node.space, groupId);
      const color = typeof node.color === "string" && node.color.includes(",") ? "white" : node.color;
      void deps.persistArrow({
        id: String(node.id),
        viewId,
        start,
        end,
        color,
        strokePx: node.strokePx,
        doc,
        space: groupId ? "group" : node.space,
        ...deps.bgPayload(node),
        groupId,
      });
      return;
    } else if (node.type === "group") {
      const compositeType = getCompositeTypeForGroup(deps.store.model.nodes as any[], String(node.id ?? ""));
      if (compositeType) {
        void deps.persistElement({
          id: String(node.id),
          type: compositeType,
          viewId,
          attrs: buildCompositeAttrs(node, compositeType),
          doc,
          space: node.space,
          groupId,
        });
      } else {
        void deps.persistGroup({ id: String(node.id), viewId, doc, space: node.space, groupId });
      }
    } else {
      return;
    }
    if (node.type !== "arrow") {
      void deps.persistGeometry({
        id: String(node.id),
        viewId,
        transform: deps.normalizeTransformForPersist(deps.store, node.transform, viewId, node.space, groupId),
        fontPx: node.type === "text" || node.type === "bullets" ? node.fontPx : undefined,
        doc,
        space: groupId ? "group" : node.space,
        groupId,
      });
    }
  };

  const enterGroupEdit = (groupId: string) => {
    deps.store.activeGroupId = String(groupId);
    deps.clearSelection();
    deps.updateHandles();
  };

  const exitGroupEdit = () => {
    const gid = String(deps.store.activeGroupId ?? "");
    if (gid) {
      const group = deps.store.model.nodes.find((n: any) => String(n.id) === gid) as any;
      const children = groupChildren(gid);
      if (group && children.length) {
        const bounds = children.map((n) => deps.aabbForNodeInSpace(n));
        const minX = Math.min(...bounds.map((b) => b.minX));
        const minY = Math.min(...bounds.map((b) => b.minY));
        const maxX = Math.max(...bounds.map((b) => b.maxX));
        const maxY = Math.max(...bounds.map((b) => b.maxY));
        const w = Math.max(1e-9, maxX - minX);
        const h = Math.max(1e-9, maxY - minY);
        const { ax, ay } = deps.anchorFrac(group.transform.anchor);
        group.transform = {
          ...group.transform,
          x: minX + w * ax,
          y: minY + h * ay,
          w,
          h,
        };
        const doc = deps.docForNode(group);
        const parentGroupId = group.groupId ? String(group.groupId) : null;
        const persistViewId = deps.persistViewIdForNode(group, deps.store.activeViewId);
        const compositeType = getCompositeTypeForGroup(deps.store.model.nodes as any[], String(group.id ?? ""));
        if (compositeType) {
          void deps.persistElement({
            id: String(group.id),
            type: compositeType,
            viewId: persistViewId,
            attrs: buildCompositeAttrs(group, compositeType),
            doc,
            space: group.space,
            groupId: parentGroupId,
          });
        } else {
          void deps.persistGroup({
            id: String(group.id),
            viewId: persistViewId,
            doc,
            space: group.space,
            groupId: parentGroupId,
          });
        }
        void deps.persistGeometry({
          id: String(group.id),
          viewId: persistViewId,
          transform: deps.normalizeTransformForPersist(deps.store, group.transform, persistViewId, group.space, parentGroupId),
          doc,
          space: group.space,
          groupId: parentGroupId,
        });
        for (const child of children) {
          const childId = String(child.id);
          const childDoc = deps.docForNode(child);
          const groupViewId = "group";
          const groupIdPayload = gid;
          if (child.type === "arrow") {
            const start = deps.normalizePointForPersist(deps.store, child.start ?? { x: 0, y: 0.5 }, groupViewId, child.space, groupIdPayload);
            const end = deps.normalizePointForPersist(deps.store, child.end ?? { x: 1, y: 0.5 }, groupViewId, child.space, groupIdPayload);
            const color = typeof child.color === "string" && child.color.includes(",") ? "white" : child.color;
            void deps.persistArrow({
              id: childId,
              viewId: groupViewId,
              start,
              end,
              color,
              strokePx: child.strokePx,
              doc: childDoc,
              space: "group",
              ...deps.bgPayload(child),
              groupId: groupIdPayload,
            });
          } else {
            void deps.persistGeometry({
              id: childId,
              viewId: groupViewId,
              transform: deps.normalizeTransformForPersist(deps.store, child.transform, groupViewId, child.space, groupIdPayload),
              fontPx: child.type === "text" || child.type === "bullets" ? child.fontPx : undefined,
              doc: childDoc,
              space: "group",
              groupId: groupIdPayload,
            });
          }
        }
      }
    }
    deps.store.activeGroupId = null;
    deps.clearSelection();
    deps.updateHandles();
  };

  const createGroupFromSelection = () => {
    const selectedIds = (deps.store.selectedIds?.length ? deps.store.selectedIds : deps.store.selectedId ? [deps.store.selectedId] : []).filter(Boolean);
    const selected = selectedIds
      .map((id) => deps.store.model.nodes.find((n: any) => String(n.id) === String(id)))
      .filter((n): n is any => !!n && n.type !== "group");
    if (selected.length < 2) return;
    const base = selected[0]!;
    const parentGroupId = deps.store.activeGroupId ? String(deps.store.activeGroupId) : null;
    const sameParent = selected.every((n) => String(n.groupId ?? "") === String(parentGroupId ?? ""));
    const sameSpace = selected.every((n) => n.space === base.space);
    const sameDoc = selected.every((n) => deps.docForNode(n) === deps.docForNode(base));
    if (!sameParent || !sameSpace || !sameDoc) return;

    const bounds = selected.map((n) => deps.aabbForNodeInSpace(n));
    deps.pushUndo(deps.snapshotNow());
    const minX = Math.min(...bounds.map((b) => b.minX));
    const minY = Math.min(...bounds.map((b) => b.minY));
    const maxX = Math.max(...bounds.map((b) => b.maxX));
    const maxY = Math.max(...bounds.map((b) => b.maxY));
    const w = Math.max(1e-9, maxX - minX);
    const h = Math.max(1e-9, maxY - minY);
    const groupId = deps.newId("group");
    const zMin = Math.min(...selected.map((n) => Number(n.zIndex ?? 0)));
    const groupNode: any = {
      id: groupId,
      type: "group",
      space: base.space,
      ...(parentGroupId ? { groupId: parentGroupId } : null),
      zIndex: zMin - 1,
      visible: true,
      opacity: 1,
      transform: {
        x: minX + w / 2,
        y: minY + h / 2,
        w,
        h,
        rotationDeg: 0,
        anchor: "centerCenter",
      },
    };
    if (base.space === "screen") groupNode.screenId = base.screenId ?? "screen_main";
    else groupNode.viewId = deps.persistViewIdForNode(base, deps.store.activeViewId);
    deps.store.model.nodes.push(groupNode);
    for (const node of selected) {
      node.groupId = groupId;
    }
    deps.setSingleSelection(groupId);

    const doc = deps.docForNode(base);
    const persistViewId = deps.persistViewIdForNode(groupNode, deps.store.activeViewId);
    void deps.persistGroup({ id: groupId, viewId: persistViewId, doc, space: base.space, groupId: parentGroupId });
    void deps.persistGeometry({
      id: String(groupId),
      viewId: persistViewId,
      transform: deps.normalizeTransformForPersist(deps.store, groupNode.transform, persistViewId, groupNode.space),
      doc,
      space: groupNode.space,
      groupId: parentGroupId,
    });
    const removeIds = selected.map((n) => String(n.id));
    void deps.persistDelete({ ids: removeIds, doc, groupId: parentGroupId });
    for (const node of selected) {
      const groupPayloadId = String(node.id);
      const groupViewId = "group";
      const groupIdPayload = groupId;
      if (node.type === "text") {
        void deps.persistText({
          id: groupPayloadId,
          viewId: groupViewId,
          text: String(node.text ?? ""),
          doc,
          space: "group",
          align: normalizeAlign((node as any).align),
          ...deps.bgPayload(node),
          groupId: groupIdPayload,
        });
      } else if (node.type === "bullets") {
        void deps.persistBullets({
          id: groupPayloadId,
          viewId: groupViewId,
          text: String(node.rawText ?? ""),
          bullets: String(node.bullets ?? ""),
          doc,
          space: "group",
          align: normalizeAlign((node as any).align),
          ...deps.bgPayload(node),
          groupId: groupIdPayload,
        });
      } else if (node.type === "image") {
        void deps.persistImage({ id: groupPayloadId, viewId: groupViewId, src: node.src, doc, space: "group", groupId: groupIdPayload, ...deps.bgPayload(node) });
      } else if (node.type === "join") {
        void deps.persistJoin({
          id: groupPayloadId,
          viewId: groupViewId,
          text: String(node.text ?? ""),
          fields: Array.isArray(node.fields) ? node.fields : [],
          doc,
          space: "group",
          ...deps.bgPayload(node),
          groupId: groupIdPayload,
        });
      } else if (node.type === "arrow") {
        const start = deps.normalizePointForPersist(deps.store, node.start ?? { x: 0, y: 0.5 }, groupViewId, node.space, groupIdPayload);
        const end = deps.normalizePointForPersist(deps.store, node.end ?? { x: 1, y: 0.5 }, groupViewId, node.space, groupIdPayload);
        const color = typeof node.color === "string" && node.color.includes(",") ? "white" : node.color;
        void deps.persistArrow({
          id: groupPayloadId,
          viewId: groupViewId,
          start,
          end,
          color,
          strokePx: node.strokePx,
          doc,
          space: "group",
          ...deps.bgPayload(node),
          groupId: groupIdPayload,
        });
      }
      if (node.type !== "arrow") {
        void deps.persistGeometry({
          id: groupPayloadId,
          viewId: groupViewId,
          transform: deps.normalizeTransformForPersist(deps.store, node.transform, groupViewId, node.space, groupIdPayload),
          fontPx: node.type === "text" || node.type === "bullets" ? node.fontPx : undefined,
          doc,
          space: "group",
          groupId: groupIdPayload,
        });
      }
    }
  };

  const canUngroupSelected = () => {
    const sel = (deps.store.selectedIds?.length ? deps.store.selectedIds : deps.store.selectedId ? [deps.store.selectedId] : []).filter(Boolean);
    if (sel.length !== 1) return null;
    const node = deps.store.model.nodes.find((n: any) => String(n.id) === String(sel[0])) as any;
    if (!node || node.type !== "group") return null;
    const parentGroupId = node.groupId ? String(node.groupId) : null;
    if (deps.store.activeGroupId) {
      if (String(deps.store.activeGroupId) !== String(parentGroupId ?? "")) return null;
    } else if (parentGroupId) {
      return null;
    }
    return node as any;
  };

  const ungroupSelectedGroup = () => {
    const groupNode = canUngroupSelected();
    if (!groupNode) return;
    const groupId = String(groupNode.id);
    const parentGroupId = groupNode.groupId ? String(groupNode.groupId) : null;
    const children = groupChildren(groupId);
    deps.pushUndo(deps.snapshotNow());
    for (const child of children) {
      child.groupId = parentGroupId ?? null;
    }
    deps.store.model.nodes = deps.store.model.nodes.filter((n: any) => String(n.id) !== groupId);
    if (children.length) deps.setMultiSelection(children.map((n) => String(n.id)), String(children[0]!.id));
    else deps.clearSelection();

    const doc = deps.docForNode(groupNode);
    void deps.persistDelete({ ids: [groupId], doc, groupId: parentGroupId });
    if (children.length) {
      void deps.persistDelete({ ids: children.map((n) => String(n.id)), doc, groupId });
      for (const child of children) {
        persistNodeToParent(child, parentGroupId);
      }
    }
  };

  return {
    groupChildren,
    groupDescendants,
    enterGroupEdit,
    exitGroupEdit,
    createGroupFromSelection,
    canUngroupSelected,
    ungroupSelectedGroup,
  };
};
