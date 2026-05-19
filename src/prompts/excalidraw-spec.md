## Excalidraw Elements

### Required Fields (all elements)

`type`, `id` (unique string), `x`, `y`, `width`, `height`

### Element Types

**Rectangle** (primary shape for all boxes):
`{ "type": "rectangle", "id": "r1", "x": 100, "y": 100, "width": 200, "height": 100 }`

- `roundness: { type: 3 }` for rounded corners
- `backgroundColor: "#a5d8ff"`, `fillStyle: "solid"` for filled

**Labeled shape (PREFERRED)**: Add `label` to any shape for auto-centered text:
`{ "type": "rectangle", "id": "r1", "x": 100, "y": 100, "width": 200, "height": 80, "label": { "text": "X_train", "fontSize": 20 } }`

- Text auto-centers and container auto-resizes to fit

**Labeled arrow**: `"label": { "text": "train" }` on an arrow element.

**Standalone text** (lane titles, annotations only):
`{ "type": "text", "id": "t1", "x": 150, "y": 138, "text": "PROCESSING", "fontSize": 20 }`

- x is the LEFT edge. To center at cx: set x = cx - (text.length × fontSize × 0.5) / 2
- Do NOT rely on textAlign or width for positioning

**Arrow**: `{ "type": "arrow", "id": "a1", "x": 300, "y": 150, "width": 200, "height": 0, "points": [[0,0],[200,0]], "endArrowhead": "arrow" }`

- points: [dx, dy] offsets from element x,y
- endArrowhead: null | "arrow" | "bar" | "dot" | "triangle"

**Ellipse / Diamond** (allowed ONLY for sketching inside WHITE output boxes — e.g. drawing chart axes, plot dots, heatmap cells):
`{ "type": "ellipse", "id": "e1", "x": 100, "y": 100, "width": 20, "height": 20 }`
`{ "type": "diamond", "id": "d1", "x": 100, "y": 100, "width": 20, "height": 20 }`

### Arrow Bindings

Arrow: `"startBinding": { "elementId": "r1", "fixedPoint": [1, 0.5] }`
fixedPoint: top=[0.5,0], bottom=[0.5,1], left=[0,0.5], right=[1,0.5]

**cameraUpdate** (pseudo-element — controls the viewport, not drawn):
`{ "type": "cameraUpdate", "width": 800, "height": 600, "x": 0, "y": 0 }`

- x, y: top-left corner of the visible area (scene coordinates)
- width, height: size of the visible area — MUST be 4:3 ratio (400×300, 600×450, 800×600, 1200×900, 1600×1200)
- No `id` needed — this is not a drawn element

**delete** (pseudo-element — removes elements by id):
`{ "type": "delete", "ids": "b2,a1,t3" }`

- Comma-separated list of element ids to remove
- Also removes bound text elements (matching `containerId`)
- Place AFTER the elements you want to remove
- Never reuse a deleted id — always assign new ids to replacements

### Drawing Order (CRITICAL)

- Array order = z-order (first = back, last = front)
- **Emit progressively**: lane background → shape → its label → its arrows → next shape
- BAD: all rectangles → all texts → all arrows
- GOOD: lane_bg → box1 → annotation1 → arrow1 → box2 → ...

---

## Sizing Rules

**Font size rules:**

- Minimum fontSize: **16** for body text, labels, descriptions
- Minimum fontSize: **20** for titles and headings
- Minimum fontSize: **14** for secondary annotations only (sparingly)
- NEVER use fontSize below 14

**Element sizing rules:**

- Minimum shape size: 120×60 for labeled rectangles
- Leave 20-30px gaps between elements minimum
- Prefer fewer, larger elements over many tiny ones

---

## Checkpoints (restoring previous state)

Every create_view / draft_view call returns a `checkpointId`. To continue from a previous diagram state, start your elements array with a restoreCheckpoint element:

`[{"type":"restoreCheckpoint","id":"<checkpointId>"}, ...additional new elements...]`

The saved state is loaded and your new elements are appended on top. This saves tokens — you don't need to re-send the entire diagram.

## Deleting Elements

Remove elements by id using the `delete` pseudo-element:

`{"type":"delete","ids":"b2,a1,t3"}`

Works in two modes:

- **With restoreCheckpoint**: restore a saved state, then surgically remove specific elements before adding new ones
- **Inline**: draw elements, then delete and replace them later in the same array

Place delete entries AFTER the elements you want to remove. The final render filters them out.

**IMPORTANT**: Every element id must be unique. Never reuse an id after deleting it — always assign a new id to replacement elements.

---

## General Tips

- Use the BOX COLORS table consistently — every box must use one of the five colors
- **Text contrast is CRITICAL** — never use light gray (#b0b0b0, #999) on white backgrounds. Minimum text color on white: #757575. For colored text on light fills, use dark variants (#15803d not #22c55e, #2563eb not #4a9eed)
- Do NOT use emoji in text — they don't render in Excalidraw's font
