# 3D office

The 3D office answers two questions at a glance: what is each session doing, and does any of them need me.

## Model and layout

- `deriveOffice` turns the live `OfficeState` characters into rooms of pods of desks with helpers. It is pure and covered by vitest.
- `PIXEL_AGENTS_OFFICE_ROOMS` names the rooms. Entries are separated by `;`. `name=glob` puts every matching tmux session in that room, and globs are separated by commas or spaces. `emperor=emperor-*` puts every `emperor-*` session in one room named emperor. An entry without `=` is one room named after that text. A configured room stays even with nobody in it. Without the setting every session is a room.
- A pod is one tmux session. It stands on its own rug with a sign that names it. The sign reads "SESSION" over the session name and draws above every desk label and badge, so the session is what you read first. A standing alert badge from the row in front can slip behind a sign; that desk's label still shows the status.
- `PIXEL_AGENTS_OFFICE_PINNED=emperor-8` pins sessions. A pinned pod sits alone in the front row of its room, centred. It gets a red rug, brass posts with a rope, and a diamond on its sign.
- The Background is a porch behind the rooms, as wide as them. It has smaller desks, a railing and fairy lights. Agents without tmux work there.
- `PIXEL_AGENTS_OFFICE_BACKGROUND=hide` drops the Background, so only agents in a room are shown.
- `--live-only` keeps a top-level agent only while its Claude process is in the session registry. Each registry tick reads `tmux list-panes` once and follows a pane by id, so a window moved into another session shows up in that session.
- `planOffice` is a pure function of the rooms and the viewport aspect. It packs each room's pods into rows and tries several room shapes and column counts. It keeps the plan that fills the most of the viewport.
- `Office3D` polls `OfficeState` every 250 ms and pushes a snapshot only when its JSON signature changes. The scene never reads React state.

## Characters

- `characters.ts` is a self-contained kit. It imports only three and holds its own palette.
- There are nine kinds: robot, cat, astronaut, wizard, chef, dog, penguin, frog and knight. Each is one skinned mesh on ten bones, so each costs one draw call.
- A desk's default kind comes from a hash of its name. The colourway also comes from the name.
- Each desk label has a picker. The choice is stored in localStorage under `pixel-agents.office3d.character:<name>`. Every storage access is wrapped in try/catch, so blocked storage falls back to the default.
- The picker holds one option until it is opened. That keeps seventeen labels light.
- Sub-agents are goblins: half-size helpers that stand beside their parent's desk and swing a hammer while they work. Nobody can pick the goblin for a desk.

## Status

- Working: the character types at a lit monitor in calm blue.
- Needs-permission: the character stands and raises a hand. An amber beam rises above it, a ring pulses and a "!" badge bobs.
- Waiting-input: a violet "?" badge sways, a violet ring glows and the room label heats up.
- Done: one short cheer with confetti, then a relaxed pose and a green check.
- Idle: the character dozes behind a drifting "z".
- Each kind has its own idle fidget. Fidgets are spaced out, so a calm office spends most of its time still.
- `prefers-reduced-motion` holds every pose still, skips confetti and stops the badge animations.

## Labels and navigation

- Labels are DOM through `CSS2DRenderer`. They stay crisp at any pixel ratio and are real buttons.
- Density follows the desk pitch on screen. Full shows name, activity and picker. Compact shows the name. Roster replaces desk labels with a per-room name list.
- A label is as wide as its own desk's pitch on screen, measured from that desk's depth, so the back row's narrower labels never overlap their neighbours. Names are never cut. A long name wraps at its hyphens.
- On a phone the roster has two columns in floor that `planOffice` reserves in front of the pods.
- The room bar lists the rooms. When one room is focused, or there is only one, it also lists that room's pods.
- `#emperor` focuses the room. `#emperor-8` focuses the pod. The hash follows back and forward.
- A click picks the nearest desk or helper with a ray against boxes. It dismisses the bubble, toggles selection and calls `App.handleClick`, so the terminal panel opens as in the 2D view. Sub-agents route to their parent.
- A drag past 6 px or a wheel counts as steering. A click does not freeze the auto-fit.

## Frame budget

- Furniture is merged per material into three draw calls. Status effects are instanced meshes. The demo office draws in about 28 calls.
- The shadow map renders only when the furniture is rebuilt or the key light moves.
- Frames run on requestAnimationFrame while something moves. When everything is still the loop stops and a timer wakes it for the next fidget.
- Rendering pauses on `visibilitychange`.
- The CSS2D pass runs only when a label changed or the camera moved.
- The pixel ratio adapts to frame time between 1 and the device ratio, capped at 2.
- `?stats` shows fps, draw calls, triangles and the pixel ratio.
- Per-frame work reuses scratch objects. Unmount disposes every geometry, material, texture, target and listener.

## Tried and dropped

- Rotate and scale badge animations. CSS2DRenderer owns `transform`, and the separate properties act on its translation, so badges flew off. Badges now move with `translate` only.
- Pod signs inside the rug: they covered the second line of compact names. Signs now hang from the rug's front edge.
- A room label above the back wall: it covered the porch desks. It now hangs on the wall.
- A single-column phone roster: it covered the pinned pod.
- A depth foreshortening of 0.9 in the planner: it overestimated screen depth and laid rooms out in one wide, shallow row.

## Known weaknesses

- In the overview a long name wraps to up to four lines, and a word wider than its desk, such as `internationalisation`, breaks inside the word.
- On a phone the roster's two-line names can cover the pinned pod's sign. The pinned desk itself stays in view.
- On a phone the porch name list covers the porch desks.
- A "?" badge on a back-row desk can overlap the label of the desk in front.
- The 2D game loop does not run under 3D. A done or waiting bubble stays until the desk is clicked or the agent resumes.
- The layout editor and the first-run tour fall back to the pixel view.
- Frame rates were only measured under SwiftShader. Real-GPU performance is not measured.
