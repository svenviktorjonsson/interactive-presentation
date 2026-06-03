from __future__ import annotations

from ...pr.parser import *
from .shared import CompositeRenderContext, _child_transformer, _resolve_media_src, format_template

class ExperimentModuleAdapter:
  module_type = "experiment"

  def compile(
    self,
    ctx: CompositeRenderContext,
    spec: ExperimentSpec,
    *,
    transform: dict[str, Any],
    space: str,
    view_id: str | None,
    layer: str | None,
  ) -> None:
    base_id = str(spec.id)
    title = str(getattr(spec, "title", None) or base_id)
    transforms = list(getattr(spec, "transforms", None) or ["x", "1/x", "1/sqrt(x)"])
    fit_label = str(getattr(spec, "fit_label", None) or "y = {{a:.3f}}x + {{b:.3f}}")
    fit_button_label = str(getattr(spec, "fit_button_label", None) or "Fit")
    clear_label = str(getattr(spec, "clear_label", None) or "Clear")
    line_color = str(getattr(spec, "line_color", None) or "rgba(255,255,255,0.85)")
    data_color = str(getattr(spec, "data_color", None) or "rgba(110,168,255,0.9)")
    table_bg = str(getattr(spec, "table_bg_color", None) or "white")
    axis_bg_raw = getattr(spec, "axis_bg_color", None)

    group_node: dict[str, Any] = {
      "id": base_id,
      "type": "group",
      "space": space,
      "zIndex": 0,
      "visible": True,
      "opacity": 1,
      "transform": transform,
      "experimentId": base_id,
      "experimentRole": "root",
      "experimentTitle": title,
      "experimentFitLabel": fit_label,
      "experimentFitButtonLabel": fit_button_label,
      "experimentClearLabel": clear_label,
      "experimentTransforms": transforms,
      "experimentLineColor": line_color,
      "experimentDataColor": data_color,
    }
    if getattr(spec, "bg_alpha", None) is not None:
      group_node["bgAlpha"] = spec.bg_alpha
    if getattr(spec, "bg_padding", None) is not None:
      group_node["bgPadding"] = spec.bg_padding
    if getattr(spec, "bg_radius", None) is not None:
      group_node["bgRadius"] = spec.bg_radius
    ctx.append_node(group_node, view_id=view_id, space=space, layer=layer)

    child_transform = _child_transformer(ctx, transform)
    cells_raw = [list(r) for r in (spec.cells or [])]
    h_header = list(getattr(spec, "h_header", None) or [])
    v_header = list(getattr(spec, "v_header", None) or [])
    h_style = list(getattr(spec, "h_style", None) or [])
    rows = int(spec.rows) if spec.rows is not None else len(cells_raw)
    cols = int(spec.cols) if spec.cols is not None else max([len(r) for r in cells_raw], default=0)
    rows = max(rows, len(cells_raw), len(v_header), 1)
    cols = max(cols, max([len(r) for r in cells_raw], default=0), len(h_header), 1)
    cells: list[list[str]] = [["" for _ in range(cols)] for _ in range(rows)]
    for row_index, row in enumerate(cells_raw):
      if row_index >= rows:
        break
      for col_index, value in enumerate(row):
        if col_index >= cols:
          break
        cells[row_index][col_index] = str(value)

    table_local = {
      "x": 0.17680271952208165,
      "y": 0.4614349074505467,
      "w": 0.2075963144792914,
      "h": 0.45681790664192995,
      "rotationDeg": 0,
      "anchor": "topLeft",
    }
    table_node: dict[str, Any] = {
      "id": f"{base_id}_table",
      "type": "table",
      "space": space,
      "groupId": base_id,
      "experimentId": base_id,
      "experimentRole": "table",
      "zIndex": 1,
      "visible": True,
      "opacity": 1,
      "transform": child_transform(table_local),
      "groupLocal": table_local,
      "rows": rows,
      "cols": cols,
      "cells": cells,
      "editable": bool(spec.editable) if spec.editable is not None else True,
      "hHeader": h_header,
      "vHeader": v_header,
      "hStyle": h_style,
      "bgColor": table_bg,
      "color": "black",
    }
    ctx.append_node(table_node, view_id=view_id, space=space, layer=layer)

    axis_local = {
      "x": 0.3923515403728571,
      "y": 0.19609607894580705,
      "w": 0.5371862680684496,
      "h": 0.5626492904726401,
      "rotationDeg": 0,
      "anchor": "topLeft",
    }
    axis_node: dict[str, Any] = {
      "id": f"{base_id}_axis",
      "type": "axis",
      "space": space,
      "groupId": base_id,
      "experimentId": base_id,
      "experimentRole": "axis",
      "zIndex": 0,
      "visible": True,
      "opacity": 1,
      "transform": child_transform(axis_local),
      "groupLocal": axis_local,
      "limits": {"xMin": 0, "xMax": 1, "yMin": 0, "yMax": 1},
      "clamp": True,
      "padPx": 40,
      "color": "white",
    }
    if axis_bg_raw:
      axis_node["bgColor"] = str(axis_bg_raw)
    ctx.append_node(axis_node, view_id=view_id, space=space, layer=layer)

    def _append_text(node_id: str, text: str, local_t: dict[str, Any], align: str, font_px: float, role: str) -> None:
      node: dict[str, Any] = {
        "id": node_id,
        "type": "text",
        "space": space,
        "groupId": base_id,
        "experimentId": base_id,
        "experimentRole": role,
        "zIndex": 2,
        "visible": True,
        "opacity": 1,
        "transform": child_transform(local_t),
        "groupLocal": local_t,
        "text": text,
        "template": text,
        "color": "rgba(255,255,255,0.92)",
        "fontPx": font_px,
        "align": align,
      }
      ctx.append_node(node, view_id=view_id, space=space, layer=layer)

    _append_text(
      f"{base_id}_title",
      title,
      {"x": 0.3655885304345316, "y": 0.22273805323473217, "w": 0.5949259004815233, "h": 0.03793661630479063, "rotationDeg": 0, "anchor": "topLeft"},
      "center",
      28.0,
      "title",
    )
    _append_text(
      f"{base_id}_x_label",
      "{{xLabel}}",
      {"x": 0.6144674507502228, "y": 0.8164182069604309, "w": 0.1075438063522649, "h": 0.04500051283773446, "rotationDeg": 0, "anchor": "topLeft"},
      "center",
      26.096457166242836,
      "x-label",
    )
    _append_text(
      f"{base_id}_y_label",
      "{{yLabel}}",
      {"x": 0.39217180969308685, "y": 0.6087127522569757, "w": 0.05288230226502429, "h": 0.058729314653924856, "rotationDeg": -90, "anchor": "topLeft"},
      "center",
      22.0,
      "y-label",
    )
    _append_text(
      f"{base_id}_fit_label",
      "{{fit}}",
      {"x": 0.8149119420724149, "y": 0.19254869625348092, "w": 0.18508805792758504, "h": 0.03793661630479063, "rotationDeg": 0, "anchor": "topLeft"},
      "left",
      22.0,
      "fit-label",
    )

    def _append_buttons(node_id: str, labels: list[str], actions: list[str], local_t: dict[str, Any], role: str, mode: str) -> None:
      node: dict[str, Any] = {
        "id": node_id,
        "type": "buttons",
        "space": space,
        "groupId": base_id,
        "experimentId": base_id,
        "experimentRole": role,
        "zIndex": 2,
        "visible": True,
        "opacity": 1,
        "transform": child_transform(local_t),
        "groupLocal": local_t,
        "labels": labels,
        "templates": labels,
        "actions": actions,
        "buttonsMode": mode,
      }
      ctx.apply_element_defaults(node, "buttons")
      ctx.append_node(node, view_id=view_id, space=space, layer=layer)

    x_labels = h_header or [f"Col {index + 1}" for index in range(cols)]
    _append_buttons(
      f"{base_id}_x_buttons",
      x_labels,
      [f"experiment-x:{index}" for index in range(cols)],
      {"x": 0.44419514834488183, "y": 0.9022962253497762, "w": 0.4362789936864504, "h": 0.03793661630479063, "rotationDeg": 0, "anchor": "topLeft"},
      "x-buttons",
      "radio",
    )
    _append_buttons(
      f"{base_id}_y_buttons",
      x_labels,
      [f"experiment-y:{index}" for index in range(cols)],
      {"x": 0.23149172423958325, "y": 0.194024962419233, "w": 0.15393784998312085, "h": 0.20530220185587894, "rotationDeg": 0, "anchor": "topLeft"},
      "y-buttons",
      "radio",
    )
    t_labels = list(transforms) + [fit_button_label, clear_label]
    t_actions = [f"experiment-t:{index}" for index in range(len(transforms))] + ["experiment-fit", "experiment-clear"]
    _append_buttons(
      f"{base_id}_t_buttons",
      t_labels,
      t_actions,
      {"x": 0.4566590393220744, "y": 0.11959881555753266, "w": 0.40983784255393835, "h": 0.03793661630479063, "rotationDeg": 0, "anchor": "topLeft"},
      "t-buttons",
      "radio",
    )
