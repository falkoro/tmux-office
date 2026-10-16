# 3D office

The 3D office answers two questions at a glance: what is each session doing, and does any of them need me.

## Model and layout

- `deriveOffice` turns the live `OfficeState` characters into rooms of pods of desks with helpers. It is pure and covered by vitest.
- `PIXEL_AGENTS_OFFICE_ROOMS` names the rooms. Entries are separated by `;`. `name=glob` puts every matching tmux session in that room, and globs are separated by commas or spaces. `work=work-*` puts every `work-*` session in one room named work. An entry without `=` is one room named after that text. A configured room stays even with nobody in it. Without the setting every session is a room.
- A pod is one tmux session. It stands on its own rug with a sign that names it. The sign reads "SESSION" over the session name and draws above every desk label and badge, so the session is what you read first. A standing alert badge from the row in front can slip behind a sign; that desk's label still shows the status.
- Each pod has one overseer. `PIXEL_AGENTS_OFFICE_OVERSEERS=lead-*` picks the first agent whose name matches. Without a match the agent in the session's oldest window leads, in tmux window id order. The overseer's desk sits alone at the back of the pod. Its crew sit at smaller desks in one row of up to four in front of it. Agents without tmux share no session, so their pod has no overseer.
- `PIXEL_AGENTS_OFFICE_PINNED=work-8` pins sessions. A pinned pod sits alone in the front row of its room, centred. It gets a red rug, brass posts with a rope, and a diamond on its sign.
- The Background is a porch behind the rooms, at least as wide as them. Its pods wrap into as many rows as fill the view best. It has smaller desks, a railing and fairy lights. Agents without tmux work there.
- `PIXEL_AGENTS_OFFICE_BACKGROUND=hide` drops the Background, so only agents in a room are shown.
- `--live-only` keeps a top-level agent only while its Claude process is in the session registry. Each registry tick reads `tmux list-panes` once and follows a pane by id, so a window moved into another session shows up in that session.
- `planOffice` is a pure function of the rooms and the viewport aspect. It packs each room's pods into rows and tries several room shapes and column counts. It keeps the plan that fills the most of the viewport.
- `Office3D` polls `OfficeState` every 250 ms and pushes a snapshot only when its JSON signature changes. The scene never reads React state.

## Characters

- `characters.ts` is a self-contained kit. It imports only three and holds its own palette.
- There are nine kinds: robot, cat, astronaut, wizard, chef, dog, penguin, frog and knight. Each is one skinned mesh on ten bones, so each costs one draw call.
- A desk's default kind comes from a hash of its name. The colourway also comes from the name.
- A selected desk's label shows a picker. The choice is stored in localStorage under `pixel-agents.office3d.character:<name>`. Every storage access is wrapped in try/catch, so blocked storage falls back to the default.
- The picker holds one option until it is opened, so a selected label stays light.
- Sub-agents are goblins: small helpers that stand in rows of five in front of their parent's name card, facing you, and swing a hammer while they work. Nobody can pick the goblin for a desk.

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
- A desk label is a paper name card on the desk's front panel. Its bottom edge takes the status colour, and an overseer's card has a brass edge and a star. Room and pod signs are wooden plaques.
- A card shows a short name. It drops the agent name's trailing hex id, such as `-c9`, and turns `-` and `_` into spaces. The id is exactly two hex characters, so `web-2024` keeps its ending. An overseer's card also drops the literal start of the glob that made it overseer, so `lead-api-c9` under `lead-*` reads `api`. That start is dropped only at a word boundary, so `leader-c9` under `lead*` reads `leader`. Two desks whose short names match show their whole names. The card's tooltip always has the whole name.
- Density follows the desk pitch on screen. Full shows name and activity. Compact shows the name. Roster replaces desk labels with a per-room name list.
- A label is as wide as its own desk's pitch on screen, measured from that desk's depth, so the back row's narrower labels never overlap their neighbours. Crew desks are smaller but keep the full pitch, so their cards are as wide as the overseer's and their text is smaller. Names are never cut. A long name wraps between words.
- On a phone the roster has two columns in floor that `planOffice` reserves in front of the pods.
- The room bar lists the rooms. When one room is focused, or there is only one, it also lists that room's pods.
- `#work` focuses the room. `#work-8` focuses the pod. A room wins a name it shares with a session, so that session is `#session:work`. The hash follows back and forward.
- A click picks the nearest desk or helper with a ray against boxes. It dismisses the bubble, toggles selection and calls `App.handleClick`, so the terminal panel opens as in the 2D view. Sub-agents route to their parent.
- A drag past 6 px or a wheel counts as steering. A click does not freeze the auto-fit.
- Walk on the room bar puts you at eye height in front of the focused room, or of the whole office when nothing is focused, looking in. You drag to look. W, A, S, D or the arrow keys move you, Shift runs, and Walk or Esc returns you to the overhead view.
- You stay on the office floor, a short margin in from the side and back walls, or on the strip of ground in front of it. When you prefer reduced motion, the camera jumps in and out instead of gliding.
- While you walk, a card or plaque shows only within 12 m and when no nearer desk hides it. CSS labels have no depth test, so far names would otherwise pile up on the horizon and float over near agents.

## Frame budget

- Furniture is merged per material into three draw calls. Status effects are instanced meshes. The demo office draws 29 calls and 157k triangles.
- The room's ambient light is a light probe with nine SH coefficients, baked once from RoomEnvironment. A PMREM environment sampled per pixel cost over half the frame.
- Furniture and the ground use Lambert shading. Their rough surfaces showed almost no specular. Characters keep the standard material, where Lambert saved nothing.
- Plant blades and wires use the low-segment primitives. Character limbs keep the round ones, because fewer segments showed facets on feet and legs up close.
- Measured in headless Chromium on SwiftShader at 1600x1000 and pixel ratio 1, the demo office runs at 2.7 fps, up from 1.1. A synchronous frame takes 375 ms of wall time and 1.9 s of GPU-process CPU, down from 760 ms and 4.7 s. The scene's own JS stays under 2 ms a frame.
- Shadows cost about a quarter of the remaining frame. They stay, because the office looks flat without them.
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
- Name cards on the floor in front of each desk: the crew's badges painted over the overseer's card. Cards now hang on the desk front.
- The crew in a two-by-two grid: a back crew desk's badge covered the card in front of it. The crew now sits in one row.
- Goblins beside their parent's desk: the name card covered them. They now stand in front of it.
- A depth foreshortening of 0.9 in the planner: it overestimated screen depth and laid rooms out in one wide, shallow row.

## Known weaknesses

- In the overview a long name wraps to up to four lines, and a word wider than its desk, such as `internationalisation`, breaks inside the word.
- On a phone the roster's two-line names can cover the pinned pod's sign. The pinned desk itself stays in view.
- On a phone the porch name list covers the porch desks.
- A "?" badge on a back-row desk can overlap the label of the desk in front.
- A session with more than four crew gets a second crew row, which brings that badge overlap back.
- Twenty goblins on one desk reach the crew desks in front of it.
- The 2D game loop does not run under 3D. A done or waiting bubble stays until the desk is clicked or the agent resumes.
- The layout editor and the first-run tour fall back to the pixel view.
- Walking passes through desks and furniture.
- Touch can look around in walk mode, but it cannot walk.
- Frame rates were only measured under SwiftShader. Real-GPU performance is not measured.
