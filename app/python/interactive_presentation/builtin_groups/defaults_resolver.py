from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from .defaults_source import FileSystemBuiltinGroupDefaultsSource
from .interfaces import BuiltinGroupDefaultsSource


FormatTemplate = Callable[[str, dict[str, Any]], str]


def _iter_group_spec_items(group_spec: Any):
  collections = [group_spec, *(list(getattr(group_spec, "screens", []) or []))]
  for container in collections:
    for text in list(getattr(container, "texts", []) or []):
      yield ("text", text)
    for bullets in list(getattr(container, "bullets", []) or []):
      yield ("bullets", bullets)
    for buttons in list(getattr(container, "buttons", []) or []):
      yield ("buttons", buttons)
    for slider in list(getattr(container, "sliders", []) or []):
      yield ("slider", slider)
    for axis in list(getattr(container, "axes", []) or []):
      yield ("axis", axis)
    for table in list(getattr(container, "tables", []) or []):
      yield ("table", table)
    for image in list(getattr(container, "images", []) or []):
      yield ("image", image)
    for video in list(getattr(container, "videos", []) or []):
      yield ("video", video)
    for camera in list(getattr(container, "cameras", []) or []):
      yield ("camera", camera)


@dataclass(frozen=True)
class BuiltinGroupDefaultsResolver:
  source: BuiltinGroupDefaultsSource

  def canonical_group_id(self, module_type: str) -> str | None:
    return self.source.canonical_group_id(module_type)

  def _map_target_child_to_canonical_child(self, module_type: str, group_id: str, child_id: str) -> str | None:
    canonical_group_id = self.canonical_group_id(module_type)
    if not canonical_group_id:
      return None
    group_prefix = f"{group_id}_"
    canonical_prefix = f"{canonical_group_id}_"
    if child_id == group_id:
      return canonical_group_id
    if child_id.startswith(group_prefix):
      return canonical_prefix + child_id[len(group_prefix):]
    return None

  def _lookup_default_group_geom(self, module_type: str, group_id: str, child_id: str):
    canonical_child_id = self._map_target_child_to_canonical_child(module_type, group_id, child_id)
    if not canonical_child_id:
      return None
    default_geoms = self.source.load_group_geometries(module_type)
    return (
      default_geoms.get((canonical_child_id, "group"))
      or default_geoms.get((canonical_child_id, ""))
      or default_geoms.get((canonical_child_id, "home"))
    )

  def lookup_default_group_geom(self, module_type: str, group_id: str, child_id: str):
    return self._lookup_default_group_geom(module_type, group_id, child_id)

  def apply_item_overlay(
    self,
    module_type: str,
    group_id: str,
    target_nodes: list[dict[str, Any]],
    *,
    format_template: FormatTemplate,
  ) -> None:
    group_spec = self.source.load_group_spec(module_type)
    if not group_spec:
      return
    by_id = {str(node.get("id", "")).strip(): node for node in target_nodes}
    canonical_group_id = self.canonical_group_id(module_type)
    for item_type, item in _iter_group_spec_items(group_spec):
      canonical_item_id = str(getattr(item, "id", "")).strip()
      if not canonical_item_id:
        continue
      target_id = canonical_item_id
      if canonical_group_id:
        if canonical_item_id == canonical_group_id:
          target_id = group_id
        elif canonical_item_id.startswith(f"{canonical_group_id}_"):
          target_id = f"{group_id}_{canonical_item_id[len(canonical_group_id) + 1:]}"
      target = by_id.get(target_id)
      if not target:
        continue
      if item_type == "text":
        template = getattr(item, "text", "")
        target["template"] = template
        if "{{" in str(template) and "}}" in str(template):
          if not str(target.get("text", "")).strip():
            target["text"] = format_template(template, {})
        else:
          target["text"] = format_template(template, {})
        align = getattr(item, "align", None)
        if align:
          target["align"] = align
      elif item_type == "bullets":
        template = getattr(item, "text", "")
        target["rawText"] = template
        target["template"] = template
        bullets_type = getattr(item, "bullets_type", None)
        if bullets_type:
          target["bullets"] = bullets_type
        align = getattr(item, "align", None)
        if align:
          target["align"] = align
      elif item_type == "buttons":
        if getattr(item, "labels", None) is not None:
          label_templates = list(item.labels or [])
          target["templates"] = label_templates
          if any("{{" in str(label) and "}}" in str(label) for label in label_templates):
            if not isinstance(target.get("labels"), list) or not target.get("labels"):
              target["labels"] = [format_template(str(label), {}) for label in label_templates]
          else:
            target["labels"] = label_templates
        if getattr(item, "actions", None) is not None:
          target["actions"] = list(item.actions or [])
        if getattr(item, "buttons_mode", None) is not None:
          target["buttonsMode"] = item.buttons_mode
        if getattr(item, "h_splits", None):
          target["hSplits"] = list(item.h_splits or [])
        if getattr(item, "v_splits", None):
          target["vSplits"] = list(item.v_splits or [])
        if getattr(item, "rows", None) is not None:
          target["rows"] = int(item.rows)
        if getattr(item, "cols", None) is not None:
          target["cols"] = int(item.cols)
      elif item_type == "slider":
        if getattr(item, "min_val", None) is not None:
          target["min"] = float(item.min_val)
        if getattr(item, "max_val", None) is not None:
          target["max"] = float(item.max_val)
        if getattr(item, "step", None) is not None:
          target["step"] = float(item.step)
        if getattr(item, "value", None) is not None:
          target["value"] = float(item.value)
        if getattr(item, "values", None):
          target["values"] = [float(v) for v in item.values or []]
      elif item_type == "axis":
        if getattr(item, "x_min", None) is not None or getattr(item, "x_max", None) is not None or getattr(item, "y_min", None) is not None or getattr(item, "y_max", None) is not None:
          target["limits"] = {
            "xMin": float(getattr(item, "x_min", None) or 0.0),
            "xMax": float(getattr(item, "x_max", None) or 1.0),
            "yMin": float(getattr(item, "y_min", None) or 0.0),
            "yMax": float(getattr(item, "y_max", None) or 1.0),
          }
        if getattr(item, "clamp", None) is not None:
          target["clamp"] = bool(item.clamp)
        if getattr(item, "pad_px", None) is not None:
          target["padPx"] = float(item.pad_px)
        if getattr(item, "max_points", None) is not None:
          target["maxPoints"] = int(item.max_points)

  def apply_geometry_overlay(self, module_type: str, group_id: str, target_nodes: list[dict[str, Any]]) -> None:
    for node in target_nodes:
      node_id = str(node.get("id", "")).strip()
      if not node_id:
        continue
      g = self._lookup_default_group_geom(module_type, group_id, node_id)
      if not g:
        continue
      if g.fontPx is not None and node.get("type") in {"text", "bullets"}:
        node["fontPx"] = float(g.fontPx)
      try:
        node["zIndex"] = int(getattr(g, "zIndex", 0) or 0)
      except Exception:
        pass


def build_builtin_group_defaults_resolver(
  source: BuiltinGroupDefaultsSource | None = None,
) -> BuiltinGroupDefaultsResolver:
  return BuiltinGroupDefaultsResolver(source or FileSystemBuiltinGroupDefaultsSource())
