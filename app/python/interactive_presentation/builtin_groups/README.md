## Built-in Group Modules

This package is the seam for built-in composite groups such as `timer`, `multichoice`, `sound`, and `spectrum`.

### Responsibilities

- `interfaces.py`
  - Defines the module adapter contract.
  - Defines capability metadata for sensor inputs, phone inputs, phone outputs, and audience outputs.
  - Defines the Python-side interactive controller contract for phone UI and phone actions.
- `controllers/`
  - Owns Python controllers for mobile-facing interactive group behavior.
  - Returns generic phone screens composed from shared element types instead of per-module HTML/JS.
- `modules/<name>.py`
  - Owns the registration metadata for one built-in group type.
  - Points at the implementation adapter, optional interactive controller, and canonical default group id.
- `registry.py`
  - Collects every built-in group definition into one compiler-facing registry.
- `defaults_source.py`
  - Loads the canonical authored defaults from `presentations/defaults_workbench/groups/<canonical_group_id>`.

### Canonical Defaults

Built-in groups no longer need per-presentation seeded internals to render correctly.

The compiler can now read canonical authored defaults from:

- `presentations/defaults_workbench/groups/<canonical_group_id>/elements.pr`
- `presentations/defaults_workbench/groups/<canonical_group_id>/geometries.csv`

Presentation-local `groups/<instance_id>/...` files remain overrides, not the source of truth.

### Adding A New Built-in Group

1. Add a new module file in `modules/`.
2. Add an adapter in `adapters/` for desktop compilation.
3. If the group needs phone UI or phone input, add a controller in `controllers/`.
4. Create a `BuiltinGroupModuleDefinition` with:
   - `module_type`
   - `canonical_group_id`
   - `adapter`
   - `controller` (optional but preferred for interactive groups)
   - `capabilities`
5. Register that definition in `registry.py`.
6. Add a canonical authored group folder under `presentations/defaults_workbench/groups/`.
7. Add compiler, controller, and route tests in `app/python/tests/`.

### Phone UI Model

Interactive phone screens are driven from Python by generic element types such as:

- `field`
- `button`
- `choice_list`
- `stopwatch`

The phone page renders these shared element types with the built-in style system. New interactive groups should extend the Python controller seam and compose screens from these generic elements instead of shipping custom HTML or custom JS per group.

### Preferred Extension Shape

For new custom interactive groups, prefer subclassing `InteractiveGroupModuleBase` in:

- [app/python/interactive_presentation/builtin_groups/module_base.py](C:\Users\viktor.jonsson\OneDrive - CellMax Technologies AB\Documents\Repositories\svenviktorjonsson\interactive-presentation\app\python\interactive_presentation\builtin_groups\module_base.py)

That base class gives you one authoring seam for:

- `module_type`
- `canonical_group_id`
- `adapter_cls`
- `capabilities`
- Python-owned phone UI
- Python-owned phone actions
- Python-owned desktop live updates

And through its controller helpers you get:

- `state(...)`
  - per-group runtime state storage
- `current_screen_payload(...)`
  - the current Python-owned phone screen payload
- `set_phone_screen_payload(...)`
  - shared phone screen publication
- `emit_event(...)`
  - low-level runtime event publication
- `emit_desktop_update(...)`
  - typed desktop node patch publication
- `ok(...)` / `error(...)`
  - standard action results

This is the intended path for future sensor groups and future phone-driven interaction groups. The goal is: one Python subclass controls phone UI, phone actions, and desktop live updates without requiring new HTML or JavaScript files.

### Minimal Example

See:

- [app/python/interactive_presentation/builtin_groups/examples/custom_counter.py](C:\Users\viktor.jonsson\OneDrive - CellMax Technologies AB\Documents\Repositories\svenviktorjonsson\interactive-presentation\app\python\interactive_presentation\builtin_groups\examples\custom_counter.py)

That example shows the preferred shape:

1. subclass `InteractiveGroupModuleBase`
2. declare `module_type`, `canonical_group_id`, `adapter_cls`, and `capabilities`
3. return a `PhoneScreen` from Python
4. handle a phone action in Python
5. emit a typed `DesktopRuntimeUpdate` back to the presentation

### Capability Vocabulary

- `sensor_inputs`
  - External readings or device streams such as pressure, audio, spectrum, or camera capture.
- `phone_inputs`
  - Actions or submissions coming from the phone UI.
- `phone_outputs`
  - Prompts or control surfaces shown on the phone UI.
- `audience_outputs`
  - What the presentation audience sees or what downstream renderers consume.
