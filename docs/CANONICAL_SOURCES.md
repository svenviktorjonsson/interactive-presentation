# Canonical Sources

This file records the current source-of-truth Modules so future changes do not drift back into duplicated paths.

## Presentation Workspace

- Canonical authored deck files live under `presentations/<deck>/`
- The Python seam that reads and writes them lives under:
  - `app/python/interactive_presentation/presentation_workspace/`

## Presentation Model

- Canonical compilation path lives under:
  - `app/python/interactive_presentation/model_compiler/`
  - `app/python/interactive_presentation/pr/compile.py`

## Built-in Group Defaults

- Canonical shared authored internals for built-in Interactive Group Modules live under:
  - `presentations/defaults_workbench/groups/`
- The resolver seam for those defaults lives under:
  - `app/python/interactive_presentation/builtin_groups/defaults_resolver.py`

## Interactive Group Module authoring

- Canonical Python authoring seam lives under:
  - `app/python/interactive_presentation/builtin_groups/module_base.py`
- Built-in registrations live under:
  - `app/python/interactive_presentation/builtin_groups/modules/`
- Built-in Python controllers live under:
  - `app/python/interactive_presentation/builtin_groups/controllers/`
- Built-in desktop adapters live under:
  - `app/python/interactive_presentation/builtin_groups/adapters/`

## Join Flow

- Canonical route composition lives under:
  - `app/python/interactive_presentation/server/join_flow_routes.py`
- Canonical Join Flow resolution lives under:
  - `app/python/interactive_presentation/server/join_flow_resolver.py`
- Canonical phone page renderer lives under:
  - `app/python/interactive_presentation/server/phone_screen_renderer.py`

## Web editor and render runtime

- Canonical editor runtime seams live under:
  - `app/web/src/editor/`
- Canonical render runtime seams live under:
  - `app/web/src/render/`

## Legacy code

- `legacy/` is not the canonical implementation path.
- Do not add new behavior there.
- New behavior should land only in the canonical seams above.
