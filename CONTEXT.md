# Interactive Presentation

This context describes the concepts used to author, compile, edit, and serve interactive presentation decks in this repo. It exists so the codebase can use stable names for the deck lifecycle and the seams around it.

## Language

**Presentation Workspace**:
The authored deck and all of its persisted files, including `presentation.pr`, geometry CSV files, group files, media, and notes.
_Avoid_: Deck folder, project folder, file tree

**Presentation Model**:
The compiled JSON payload consumed by the web app to render and edit a deck.
_Avoid_: Runtime JSON, frontend payload

**Model Compiler**:
The module that turns a Presentation Workspace into a Presentation Model.
_Avoid_: Serializer, renderer backend

**Composite Module**:
A deck element like timer, multichoice, experiment, pressure, player, or webcam that expands into internal authored or generated nodes.
_Avoid_: Widget, special component

**Group Edit**:
Editing the internal layout of a Composite Module through its group-local files and geometry.
_Avoid_: Nested edit mode, subcomponent edit

**Join Flow**:
The audience-facing phone interaction for joining a session and participating in prompts such as multichoice and timer submissions.
_Avoid_: Mobile app, client flow

**Built-in Group Defaults**:
The canonical shared group-local authored content and geometry for built-in Composite Modules, used as the fallback source before a Presentation Workspace overrides them.
_Avoid_: Seed deck, copied defaults

**Interactive Group Module**:
A built-in or custom Composite Module definition that combines group-local rendering, Join Flow input, and live audience output behind one seam.
_Avoid_: Special widget, hardcoded sensor view

## Relationships

- A **Presentation Workspace** is compiled into a **Presentation Model**
- A **Model Compiler** reads one **Presentation Workspace**
- A **Composite Module** lives in a **Presentation Workspace** and may expose **Group Edit**
- **Built-in Group Defaults** provide the fallback authored internals for an **Interactive Group Module**
- An **Interactive Group Module** expands into a **Presentation Model** through the **Model Compiler**
- The web editor manipulates a **Presentation Model** and persists changes back into a **Presentation Workspace**
- The **Join Flow** interacts with server state that is associated with a **Presentation Workspace**

## Example dialogue

> **Dev:** "Should this bug be fixed in the **Presentation Workspace** or the **Model Compiler**?"
> **Domain expert:** "If the authored files are wrong, fix the **Presentation Workspace** logic. If the files are fine but the web app gets the wrong JSON, fix the **Model Compiler**."

## Flagged ambiguities

- "presentation" was being used to mean both the authored deck files and the compiled JSON model. Resolved: use **Presentation Workspace** for authored files and **Presentation Model** for compiled output.
- "group" was being used for both generic authored groups and generated internals of a **Composite Module**. Resolved: use **Group Edit** only for the editing mode and **Composite Module** for the authored concept.
