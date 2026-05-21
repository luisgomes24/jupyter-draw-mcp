import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";

import path from "node:path";
import { deflateSync } from "node:zlib";
import { z } from "zod/v4";
import type { CheckpointStore } from "./checkpoint-store.js";

/** Maximum allowed size for element/data input strings (5 MB). */
const MAX_INPUT_BYTES = 5 * 1024 * 1024;

// Works both from source (src/server.ts) and compiled (dist/server.js)
const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "..", "dist")
  : import.meta.dirname;

// ============================================================
// RECALL: shared knowledge for the agent
// ============================================================
const EXCALIDRAW_SPECS = `# Excalidraw Element Format

Thanks for calling read_me! Do NOT call it again in this conversation — you will not see anything new. Now use create_view to draw.
---

## Excalidraw Elements

### Required Fields (all elements)
\`type\`, \`id\` (unique string), \`x\`, \`y\`, \`width\`, \`height\`

### Defaults (skip these)
strokeColor="#1e1e1e", backgroundColor="transparent", fillStyle="solid", strokeWidth=2, roughness=1, opacity=100
Canvas background is white.

### Element Types

**Rectangle** (PRIMARY shape for diagram nodes):
\`{ "type": "rectangle", "id": "r1", "x": 100, "y": 100, "width": 200, "height": 100 }\`
- \`roundness: { type: 3 }\` for rounded corners
- \`backgroundColor: "#a5d8ff"\`, \`fillStyle: "solid"\` for filled
- **Rectangles are the only allowed shape for diagram nodes.** Ellipses and diamonds are reserved for in-box sketches (e.g., drawing a scatter plot, chart axis dots, etc.)

**Labeled rectangle (PREFERRED for nodes)**:
\`{ "type": "rectangle", "id": "r1", "x": 100, "y": 100, "width": 200, "height": 80, "label": { "text": "Hello", "fontSize": 20 } }\`
- Text auto-centers; container auto-resizes to fit
- Saves tokens vs separate text elements

**Ellipse** (in-box sketches only — e.g., data points in a scatter plot, pie segments):
\`{ "type": "ellipse", "id": "e1", "x": 100, "y": 100, "width": 150, "height": 150 }\`
- Do NOT use as a diagram node

**Diamond** (in-box sketches only — same as ellipse):
\`{ "type": "diamond", "id": "d1", "x": 100, "y": 100, "width": 150, "height": 150 }\`
- Do NOT use as a diagram node

**Labeled arrow**: \`"label": { "text": "connects" }\` on an arrow element.

**Standalone text** (titles, lane headers, annotations only):
\`{ "type": "text", "id": "t1", "x": 150, "y": 138, "text": "Hello", "fontSize": 20 }\`
- x is the LEFT edge of the text. To center text at position cx: set x = cx - estimatedWidth/2
- estimatedWidth ≈ text.length × fontSize × 0.5
- Do NOT rely on textAlign or width for positioning — they only affect multi-line wrapping

**Arrow** (connections between nodes AND in-box sketch elements such as axes):
\`{ "type": "arrow", "id": "a1", "x": 300, "y": 150, "width": 200, "height": 0, "points": [[0,0],[200,0]], "endArrowhead": "arrow" }\`
- points: [dx, dy] offsets from element x,y
- endArrowhead: null | "arrow" | "bar" | "dot" | "triangle"
- For sketch axes inside a box, set \`endArrowhead: "arrow"\` and \`strokeWidth: 1\`

### Arrow Bindings
Arrow: \`"startBinding": { "elementId": "r1", "fixedPoint": [1, 0.5] }\`
fixedPoint: top=[0.5,0], bottom=[0.5,1], left=[0,0.5], right=[1,0.5]

### Example: Two connected labeled boxes
\`\`\`json
[
  { "type": "cameraUpdate", "width": 800, "height": 600, "x": 50, "y": 50 },
  { "type": "rectangle", "id": "b1", "x": 100, "y": 100, "width": 200, "height": 100, "roundness": { "type": 3 }, "backgroundColor": "#a5d8ff", "fillStyle": "solid", "label": { "text": "Start", "fontSize": 20 } },
  { "type": "rectangle", "id": "b2", "x": 450, "y": 100, "width": 200, "height": 100, "roundness": { "type": 3 }, "backgroundColor": "#b2f2bb", "fillStyle": "solid", "label": { "text": "End", "fontSize": 20 } },
  { "type": "arrow", "id": "a1", "x": 300, "y": 150, "width": 150, "height": 0, "points": [[0,0],[150,0]], "endArrowhead": "arrow", "startBinding": { "elementId": "b1", "fixedPoint": [1, 0.5] }, "endBinding": { "elementId": "b2", "fixedPoint": [0, 0.5] } }
]
\`\`\`

## General Excalidraw Tips
- Do NOT call read_me again — you already have everything you need
- Use the color palette consistently
- **Text contrast is CRITICAL** — never use light gray (#b0b0b0, #999) on white backgrounds. Minimum text color on white: #757575. For colored text on light fills, use dark variants (#15803d not #22c55e, #2563eb not #4a9eed). White text needs dark backgrounds (#9a5030 not #c4795b)
- Do NOT use emoji in text — they don't render in Excalidraw's font
- **Rectangles only for diagram nodes** — Ellipses, diamonds, and similar shapes are for in-box sketches (charts, icons, decorative art) only
`;

const LIVE_UPDATES_PROMPT = `# Live Updates & Camera Reference

This section describes how to use camera updates, drawing progression, deletion animations, and checkpoint restoration to show a diagram being constructed live to the user.

## Camera Updates

**cameraUpdate** (pseudo-element — controls the viewport, not drawn):
\`{ "type": "cameraUpdate", "width": 800, "height": 600, "x": 0, "y": 0 }\`
- x, y: top-left corner of the visible area (scene coordinates)
- width, height: size of the visible area — MUST be 4:3 ratio (400×300, 600×450, 800×600, 1200×900, 1600×1200)
- Animates smoothly between positions — use multiple cameraUpdates to guide attention as you draw
- No \`id\` needed — this is not a drawn element

### Camera & Sizing (CRITICAL for readability)

The diagram displays inline at ~700px width. Design for this constraint.

**Recommended camera sizes (4:3 aspect ratio ONLY):**
- Camera **S**: width 400, height 300 — close-up on a small group (2-3 elements)
- Camera **M**: width 600, height 450 — medium view, a section of a diagram
- Camera **L**: width 800, height 600 — standard full diagram (DEFAULT)
- Camera **XL**: width 1200, height 900 — large diagram overview. WARNING: font size smaller than 18 is unreadable
- Camera **XXL**: width 1600, height 1200 — panorama / final overview of complex diagrams. WARNING: minimum readable font size is 21

ALWAYS use one of these exact sizes. Non-4:3 viewports cause distortion.

**Font size rules:**
- Minimum fontSize: **16** for body text, labels, descriptions
- Minimum fontSize: **20** for titles, headings, and lane headers
- Minimum fontSize: **14** for secondary annotations only (sparingly)
- NEVER use fontSize below 14 — it becomes unreadable at display scale

**Element sizing rules:**
- Minimum shape size: 120×60 for labeled rectangles
- Leave 20-30px gaps between elements minimum
- Prefer fewer, larger elements over many tiny ones

ALWAYS start with a \`cameraUpdate\` as the FIRST element. For example:
\`{ "type": "cameraUpdate", "width": 800, "height": 600, "x": 0, "y": 0 }\`

- x, y: top-left corner of visible area (scene coordinates)
- ALWAYS emit the cameraUpdate BEFORE drawing the elements it frames — camera moves first, then content appears
- The camera animates smoothly between positions
- Leave padding: don't match camera size to content size exactly (e.g., 500px content in 800x600 camera)

Examples:
\`{ "type": "cameraUpdate", "width": 800, "height": 600, "x": 0, "y": 0 }\` — standard view
\`{ "type": "cameraUpdate", "width": 400, "height": 300, "x": 200, "y": 100 }\` — zoom into a detail
\`{ "type": "cameraUpdate", "width": 1600, "height": 1200, "x": -50, "y": -50 }\` — panorama overview

Tip: For large diagrams, emit a cameraUpdate to focus on each section as you draw it.

---

## Live Diagram Building

### Drawing Order (CRITICAL for streaming)
- Array order = z-order (first = back, last = front)
- **Emit progressively**: background → shape → its label → its arrows → next shape
- BAD: all rectangles → all texts → all arrows
- GOOD: bg_shape → shape1 → text1 → arrow1 → shape2 → text2 → ...

### Deleting Elements

Remove elements by id using the \`delete\` pseudo-element:

\`{"type":"delete","ids":"b2,a1,t3"}\`

Works in two modes:
- **With restoreCheckpoint**: restore a saved state, then surgically remove specific elements before adding new ones
- **Inline (animation mode)**: draw elements, then delete and replace them later in the same array to create transformation effects

Place delete entries AFTER the elements you want to remove. The final render filters them out.

**IMPORTANT**: Every element id must be unique. Never reuse an id after deleting it — always assign a new id to replacement elements.

### Checkpoints (restoring previous state)

Every create_view call returns a \`checkpointId\` in its response. To continue from a previous diagram state, start your elements array with a restoreCheckpoint element:

\`[{"type":"restoreCheckpoint","id":"<checkpointId>"}, ...additional new elements...]\`

The saved state (including any user edits made in fullscreen) is loaded from the client, and your new elements are appended on top. This saves tokens — you don't need to re-send the entire diagram.

### Live Updates Tip
- cameraUpdate is MAGICAL and users love it! please use it a lot to guide the user's attention as you draw. It makes a huge difference in readability and engagement.

---

## Diagram Example

Example prompt: "Show a simple ML training pipeline"

Uses 2 camera positions: start zoomed in (M) for title, then zoom out (L) to reveal the full pipeline.

- **Camera 1** (400x300): Draw the title and subtitle
- **Camera 2** (800x600): Zoom out — draw the pipeline: raw CSV → preprocessing → train/test split → model training → evaluation, with metric annotation

\`\`\`json
[
  {"type":"cameraUpdate","width":400,"height":300,"x":150,"y":-20},
  {"type":"text","id":"ti","x":195,"y":10,"text":"ML Training Pipeline","fontSize":28,"strokeColor":"#1e1e1e"},
  {"type":"text","id":"su","x":210,"y":48,"text":"CSV → model → accuracy score","fontSize":16,"strokeColor":"#757575"},
  {"type":"cameraUpdate","width":800,"height":600,"x":0,"y":-20},
  {"type":"rectangle","id":"csv","x":30,"y":200,"width":120,"height":60,"backgroundColor":"#a5d8ff","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#4a9eed","label":{"text":"train.csv","fontSize":16}},
  {"type":"arrow","id":"a1","x":150,"y":230,"width":60,"height":0,"points":[[0,0],[60,0]],"strokeColor":"#1e1e1e","strokeWidth":2,"endArrowhead":"arrow","label":{"text":"load","fontSize":14}},
  {"type":"rectangle","id":"prep","x":210,"y":190,"width":150,"height":80,"backgroundColor":"#e9ecef","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#868e96","label":{"text":"Preprocessing\\ndrop nulls, scale","fontSize":15}},
  {"type":"arrow","id":"a2","x":360,"y":230,"width":60,"height":0,"points":[[0,0],[60,0]],"strokeColor":"#1e1e1e","strokeWidth":2,"endArrowhead":"arrow","label":{"text":"split","fontSize":14}},
  {"type":"rectangle","id":"xtrain","x":420,"y":160,"width":130,"height":55,"backgroundColor":"#a5d8ff","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#4a9eed","label":{"text":"X_train","fontSize":16}},
  {"type":"text","id":"ann1","x":428,"y":218,"text":"80%","fontSize":14,"strokeColor":"#4a9eed"},
  {"type":"rectangle","id":"xtest","x":420,"y":280,"width":130,"height":55,"backgroundColor":"#a5d8ff","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#4a9eed","label":{"text":"X_test","fontSize":16}},
  {"type":"text","id":"ann2","x":428,"y":338,"text":"20%","fontSize":14,"strokeColor":"#4a9eed"},
  {"type":"arrow","id":"a3","x":550,"y":187,"width":70,"height":0,"points":[[0,0],[70,0]],"strokeColor":"#1e1e1e","strokeWidth":2,"endArrowhead":"arrow","label":{"text":"train","fontSize":14}},
  {"type":"rectangle","id":"clf","x":620,"y":160,"width":150,"height":55,"backgroundColor":"#ffc9c9","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#ef4444","label":{"text":"RandomForest()\\nn_estimators=100","fontSize":14}},
  {"type":"arrow","id":"a4","x":550,"y":307,"width":120,"height":-90,"points":[[0,0],[120,-90]],"strokeColor":"#1e1e1e","strokeWidth":2,"endArrowhead":"arrow","label":{"text":"predict","fontSize":14}},
  {"type":"rectangle","id":"eval","x":620,"y":290,"width":150,"height":55,"backgroundColor":"#b2f2bb","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#22c55e","label":{"text":"accuracy_score()","fontSize":16}},
  {"type":"text","id":"metric","x":628,"y":348,"text":"acc = 0.91","fontSize":14,"strokeColor":"#15803d"},
  {"type":"cameraUpdate","width":800,"height":600,"x":0,"y":-20}
]
\`\`\`

## Sequence flow Diagram Example

Example prompt: "show a sequence diagram explaining MCP Apps"

This demonstrates a UML-style sequence diagram with 4 actors (User, Agent, App iframe, MCP Server), dashed lifelines, and labeled arrows showing the full MCP Apps request/response flow. Camera pans progressively across the diagram.
All actor header boxes are rectangles. Lifelines are arrows with \`endArrowhead: null\`.

- **Camera 1** (600x450): Title "MCP Apps — Sequence Flow"
- **Cameras 2–5** (400x300 each): Zoom into each actor column right-to-left — draw header rectangle + dashed lifeline arrow for Server, App, Agent, User
- **Camera 6** (400x300): Zoom into User — draw stick figure (head as ellipse + body as rectangle, in-box sketch only)
- **Camera 7** (600x450): Zoom out — draw first message arrows
- **Camera 8** (600x450): Pan down — draw user interaction
- **Camera 9** (600x450): Pan further down — agent forwards to server, fresh data flows back
- **Camera 10** (800x600): Final zoom-out showing the complete sequence

\`\`\`json
[
  {"type":"cameraUpdate","width":600,"height":450,"x":80,"y":-10},
  {"type":"text","id":"title","x":200,"y":15,"text":"MCP Apps — Sequence Flow","fontSize":24,"strokeColor":"#1e1e1e"},

  {"type":"cameraUpdate","width":400,"height":300,"x":450,"y":-5},
  {"type":"rectangle","id":"sHead","x":600,"y":60,"width":130,"height":40,"backgroundColor":"#ffd8a8","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#f59e0b","strokeWidth":2,"label":{"text":"MCP Server","fontSize":16}},
  {"type":"arrow","id":"sLine","x":665,"y":100,"width":0,"height":490,"points":[[0,0],[0,490]],"strokeColor":"#b0b0b0","strokeWidth":1,"strokeStyle":"dashed","endArrowhead":null},

  {"type":"cameraUpdate","width":400,"height":300,"x":250,"y":-5},
  {"type":"rectangle","id":"appHead","x":400,"y":60,"width":130,"height":40,"backgroundColor":"#b2f2bb","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#22c55e","strokeWidth":2,"label":{"text":"App iframe","fontSize":16}},
  {"type":"arrow","id":"appLine","x":465,"y":100,"width":0,"height":490,"points":[[0,0],[0,490]],"strokeColor":"#b0b0b0","strokeWidth":1,"strokeStyle":"dashed","endArrowhead":null},

  {"type":"cameraUpdate","width":400,"height":300,"x":80,"y":-5},
  {"type":"rectangle","id":"aHead","x":230,"y":60,"width":100,"height":40,"backgroundColor":"#d0bfff","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#8b5cf6","strokeWidth":2,"label":{"text":"Agent","fontSize":16}},
  {"type":"arrow","id":"aLine","x":280,"y":100,"width":0,"height":490,"points":[[0,0],[0,490]],"strokeColor":"#b0b0b0","strokeWidth":1,"strokeStyle":"dashed","endArrowhead":null},

  {"type":"cameraUpdate","width":400,"height":300,"x":-10,"y":-5},
  {"type":"rectangle","id":"uHead","x":60,"y":60,"width":100,"height":40,"backgroundColor":"#a5d8ff","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#4a9eed","strokeWidth":2,"label":{"text":"User","fontSize":16}},
  {"type":"arrow","id":"uLine","x":110,"y":100,"width":0,"height":490,"points":[[0,0],[0,490]],"strokeColor":"#b0b0b0","strokeWidth":1,"strokeStyle":"dashed","endArrowhead":null},

  {"type":"cameraUpdate","width":400,"height":300,"x":-40,"y":50},
  {"type":"ellipse","id":"uh","x":58,"y":110,"width":20,"height":20,"backgroundColor":"#a5d8ff","fillStyle":"solid","strokeColor":"#4a9eed","strokeWidth":2},
  {"type":"rectangle","id":"ub","x":57,"y":132,"width":22,"height":26,"backgroundColor":"#a5d8ff","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#4a9eed","strokeWidth":2},

  {"type":"cameraUpdate","width":600,"height":450,"x":-20,"y":-30},
  {"type":"arrow","id":"m1","x":110,"y":135,"width":170,"height":0,"points":[[0,0],[170,0]],"strokeColor":"#1e1e1e","strokeWidth":2,"endArrowhead":"arrow","label":{"text":"display a chart","fontSize":14}},
  {"type":"rectangle","id":"note1","x":130,"y":162,"width":310,"height":26,"backgroundColor":"#fff3bf","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#f59e0b","strokeWidth":1,"opacity":50,"label":{"text":"Interactive app rendered in chat","fontSize":14}},

  {"type":"cameraUpdate","width":600,"height":450,"x":170,"y":25},
  {"type":"arrow","id":"m2","x":280,"y":210,"width":385,"height":0,"points":[[0,0],[385,0]],"strokeColor":"#8b5cf6","strokeWidth":2,"endArrowhead":"arrow","label":{"text":"tools/call","fontSize":16}},
  {"type":"arrow","id":"m3","x":665,"y":250,"width":-385,"height":0,"points":[[0,0],[-385,0]],"strokeColor":"#f59e0b","strokeWidth":2,"endArrowhead":"arrow","strokeStyle":"dashed","label":{"text":"tool input/result","fontSize":16}},
  {"type":"arrow","id":"m4","x":280,"y":290,"width":185,"height":0,"points":[[0,0],[185,0]],"strokeColor":"#8b5cf6","strokeWidth":2,"endArrowhead":"arrow","strokeStyle":"dashed","label":{"text":"result → app","fontSize":16}},

  {"type":"cameraUpdate","width":600,"height":450,"x":-10,"y":135},
  {"type":"arrow","id":"m5","x":110,"y":340,"width":355,"height":0,"points":[[0,0],[355,0]],"strokeColor":"#4a9eed","strokeWidth":2,"endArrowhead":"arrow","label":{"text":"user interacts","fontSize":16}},
  {"type":"arrow","id":"m6","x":465,"y":380,"width":-185,"height":0,"points":[[0,0],[-185,0]],"strokeColor":"#22c55e","strokeWidth":2,"endArrowhead":"arrow","label":{"text":"tools/call request","fontSize":16}},

  {"type":"cameraUpdate","width":600,"height":450,"x":170,"y":235},
  {"type":"arrow","id":"m7","x":280,"y":420,"width":385,"height":0,"points":[[0,0],[385,0]],"strokeColor":"#8b5cf6","strokeWidth":2,"endArrowhead":"arrow","label":{"text":"tools/call (forwarded)","fontSize":16}},
  {"type":"arrow","id":"m8","x":665,"y":460,"width":-385,"height":0,"points":[[0,0],[-385,0]],"strokeColor":"#f59e0b","strokeWidth":2,"endArrowhead":"arrow","strokeStyle":"dashed","label":{"text":"fresh data","fontSize":16}},
  {"type":"arrow","id":"m9","x":280,"y":500,"width":185,"height":0,"points":[[0,0],[185,0]],"strokeColor":"#8b5cf6","strokeWidth":2,"endArrowhead":"arrow","strokeStyle":"dashed","label":{"text":"fresh data","fontSize":16}},

  {"type":"cameraUpdate","width":600,"height":450,"x":50,"y":327},
  {"type":"rectangle","id":"note2","x":130,"y":522,"width":310,"height":26,"backgroundColor":"#d3f9d8","fillStyle":"solid","roundness":{"type":3},"strokeColor":"#22c55e","strokeWidth":1,"opacity":50,"label":{"text":"App updates with new data","fontSize":14}},
  {"type":"arrow","id":"m10","x":465,"y":570,"width":-185,"height":0,"points":[[0,0],[-185,0]],"strokeColor":"#22c55e","strokeWidth":2,"endArrowhead":"arrow","strokeStyle":"dashed","label":{"text":"context update","fontSize":16}},

  {"type":"cameraUpdate","width":800,"height":600,"x":-5,"y":2}
]
\`\`\`
`;


const JUPYTER_INSTRUCTIONS = `# Jupyter Notebook Diagramming — Excalidraw Spec

This MCP generates Excalidraw diagrams from Jupyter notebooks. Every rule below
applies when diagramming a data science / ML notebook.

---

## TWO INDEPENDENT DIMENSIONS

Every box has exactly two properties chosen independently:

1. **COLOR** — what kind of thing the box represents (entity type)
2. **LANE** — which stage of the pipeline it belongs to (pipeline stage)

Color does NOT belong to a lane.

---

## BOX COLORS (entity type)

Choose the color that describes what the box IS, regardless of where it sits:

| Color     | Fill Hex  | Stroke Hex | Entity Type  | Description                                                                                            | Examples                                                       |
| --------- | --------- | ---------- | ------------ | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| **BLUE**  | \`#a5d8ff\` | \`#4a9eed\`  | Data entity  | A named data artifact: dataset, dataframe, array, file, split, embedding.                              | \`df_raw\`, \`X_train\`, \`train.csv\`                               |
| **GRAY**  | \`#e9ecef\` | \`#868e96\`  | Process step | An operation applied to data or a model: function call, transformation, cleaning step, or computation. | \`StandardScaler()\`, \`Split Train/Test\`, \`remove_duplicates()\`  |
| **RED**   | \`#ffc9c9\` | \`#ef4444\`  | Model        | A model definition, training call, or HP search.                                                       | \`LogisticRegression()\`, \`CNN()\`, \`clf.fit()\`, \`GridSearchCV()\` |
| **GREEN** | \`#b2f2bb\` | \`#22c55e\`  | Evaluation   | A step that measures model or data quality against a reference.                                        | \`accuracy_score()\`, \`confusion_matrix()\`, \`cross_val_score()\`  |
| **WHITE** | \`#ffffff\` | \`#868e96\`  | Output       | Any human-readable result: plot, printed summary, or exported report. Can appear in any lane.          | \`plt.show()\`, \`print(df.head())\`, \`sns.heatmap()\`              |

Examples of color mixed within a single lane:

- **PROCESSING** lane may contain: BLUE (\`df_clean\`), GRAY (\`StandardScaler()\`), WHITE (dist plot)
- **MODELLING** lane may contain: BLUE (\`X_train\`), RED (\`clf.fit()\`), GREEN (val accuracy)
- **REPORT** lane may contain: GREEN (final metrics), WHITE (confusion matrix plot), BLUE (predictions df)

---

## LANES (workflow stage)

Lanes are spatial columns that group boxes by pipeline stage — not by box type.
Place a box in the lane that describes the stage of the notebook where it appears.
Lanes are created in the END, after knowing the position of all the boxes.

\`\`\`
┌───────────┬────────────┬────────────┬────────────┬────────────┐
│ ARTIFACTS │ PROCESSING │ MODELLING  │ EVALUATION │   REPORT   │
└───────────┴────────────┴────────────┴────────────┴────────────┘
\`\`\`

| Lane           | Description                                                                                                                                              | Typical Box Colors |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **ARTIFACTS**  | External data entities before notebook runs or written back out. Inputs: \`train.csv\`, \`test.csv\`, API response. Outputs: \`predictions.csv\`, \`model.pkl\`. | BLUE               |
| **PROCESSING** | Data preparation: loading, cleaning, transforming, splitting.                                                                                            | BLUE, GRAY, WHITE  |
| **MODELLING**  | Models defined, trained, or tuned.                                                                                                                       | RED, GREEN         |
| **EVALUATION** | Trained model tested on held-out data and measured.                                                                                                      | GREEN, BLUE, WHITE |
| **REPORT**     | Final human-readable outputs: polished visualizations and summaries.                                                                                     | WHITE, GREEN, BLUE |

"Typical colors" above are guidance, not rules. **Any color can appear in any lane.**
When in doubt: assign the lane by _when_ it happens, assign the color by _what_ it is.

---

## BOX CONTENT RULES

- Each box must contain a label that describes what the box represents.
- The label must be concise and clear.
- The labels can be short description (e.g. Split test data) or contain references to the functions, variables or markdown in the notebook (e.g. \`Step 6: train_test_split()\`).
- In each box you should draw visualizations (e.g. a tree model, tables, etc.) to help understand the represented content of the box.
- Visualization are mandatory in output boxes with plots, clearly sketching what is being plotted (e.g. histogram of variable X).
- Each box can have at most one visualization.

Example: If a Jupyter notebook is loading a csv file, you may draw 2 boxes:
- The first one (BLUE) show "mydata.csv" with a drawing of a file [artifacts lane].
- The arrow reads "load dataframe" [crossing to processing lane].
- The second one (BLUE) show "df_raw" with a drawing of a table [processing lane]

## DEPLOYMENT ANNOTATIONS

Deployment intent is captured with annotations on existing boxes:

- If the notebook saves a model (\`joblib.dump()\`, \`model.save()\`, \`torch.save()\`),
  draw it in ARTIFACTS with a label for the saved file (e.g., "model.pkl").
  Add a small deploy tag near that ARTIFACTS box.

---

## ARROW DIRECTIONS

Two global rules; everything else is free:

1. Dominant reading order is **left-to-right and top-to-bottom**.
2. **Back-arrows** (right-to-left, any lane → ARTIFACTS) are allowed whenever a lane switch is needed. Draw as curved/angled lines. For example, deploying or using a model will draw a back arrow to the artifacts lane (e.g., "predictions.csv", "model.pkl").

Within a lane, use whatever direction best shows temporal order.

---

## FLOW AND PLACEMENT

- Time flows primarily **left-to-right and top-to-bottom** within each lane (earlier steps at top-left).
- **DIAGONAL** arrows within a lane are also allowed.
- Create parallel paths inside a lane when adequate (e.g. split train/test, features and labels extraction).

**Arrow routing:**

- NEVER draw two arrows on top of each other. Spread them apart.
- NEVER draw arrows on top of boxes.
- Arrows that cross tracks use a small diagonal or gentle curve — never pass through a box.
- When two arrows leave the same box to different tracks, draw them as a Y-fork.
- IMPORTANT: Draw round or slightly bent arrows instead of straight arrows when a straight arrow would cross another arrow or box.

---

## LAYOUT ANTI-PATTERNS (avoid these)

- X **SINGLE-COLUMN CENTERING**: If a box has >1 outgoing arrow, targets MUST be offset.
- X **ARROW-THROUGH-BOX**: No arrow may pass through another box. Reroute or add gaps.
- X **ARROW BUNDLES**: Never draw two arrows on top of each other. Spread apart.
- X **INVISIBLE BACK-ARROWS**: Back-arrows must be visible curves with readable labels.
- X **UNIFORM ROW HEIGHT**: Allow rows to be taller when parallel tracks need more space.

---

## WHAT TO INCLUDE

Include a box when it meaningfully answers one of:

- What data exists, where it came from, and how it was prepared?
- Which model was trained on which data version?
- What was evaluated, and on which split?
- What does the output visualize or report?
- What artifact did the notebook write back to disk?

**Exclude**: imports, constants, helper function definitions, minor variable aliases, and any step that does not change the story of the pipeline.

**IMPORTANT**: Prefer a diagram a practitioner would sketch to explain the notebook to a colleague in 5 minutes — not a complete execution trace.

---

## ANNOTATIONS

Add small annotations near boxes where available:

- **BLUE** boxes: shape or size (\`"N=50k"\`, \`"(128,28,28)"\`, \`"80/20 split"\`)
- **RED** boxes: key config (\`"lr=1e-3"\`, \`"depth=5"\`, \`"n_estimators=100"\`);
  add \`★ deploy\` if this is the model to be deployed
- **GREEN** boxes: metric result (\`"AUC=0.84"\`, \`"acc=0.91"\`, \`"F1=0.78"\`)
- **BLUE** (ARTIFACTS, saved model): add \`★ deploy\` if this file is the deployed artifact

---

## OUTPUT BOX SKETCHES

For every WHITE box (plot, printout), sketch a rough representation inside it
using small inner shapes (ellipses, rectangles, lines):

- **line plot** → axes + curve, label x/y (e.g., "loss vs epoch")
- **bar chart** → bars of different heights, label x axis
- **grid** → small grid of squares (e.g., 3x3 digit images)
- **histogram** → bins of varying heights
- **heatmap** → shaded matrix grid (e.g., confusion matrix)
- **table** → a few rows with dividers

This applies in ANY lane where a WHITE box appears, not only in REPORT.
Label with the plotted variables: "pred vs true", "acc vs epoch", "feature importance".

---

## CONSISTENCY RULES

- **C1.** Box labels use references from the markdown and the actual variable or function name from the notebook.
- **C2.** Arrow labels carry verbs with the meaning of the arrow (e.g. "train").
- **C3.** Collapse sequences of minor in-place mutations into a single GRAY process box.
- **C4.** Use the notebook's own variable names as box labels, not paraphrases.
- **C5.** When a single artifact feeds multiple destinations, draw separate arrows to each.
- **C6.** Model details can be shown if the model is not too big (e.g. a CNN with a few layers).

---

## STYLE

Hand-drawn whiteboard feel: slight informality, no pixel-perfect grids.
Draw lane headers as column titles above a horizontal rule.
No legends — the color schema above is self-evident.
Favor fewer, larger, clearly labeled boxes over many small cluttered ones.
Keep the diagram legible at a glance: if it feels crowded, collapse more steps.
`;

// ============================================================
// MCP Server Instructions — injected into every conversation
// This ensures the LLM has the spec even if it doesn't call read_me.
// ============================================================
const SERVER_INSTRUCTIONS = `You are an Excalidraw diagram assistant specialized in Jupyter notebook diagramming. You create beautiful, hand-drawn diagrams using the create_view tool.

IMPORTANT: Before calling create_view for the first time, you MUST call read_me to learn the Excalidraw element format, color palettes, camera sizing, AND the Jupyter Notebook Diagramming rules. The spec contains mandatory rules you must follow — do NOT guess the format.

## Required Flow for Jupyter Notebooks

1. Call read_me — returns BOTH the Excalidraw element format AND the Jupyter Notebook Diagramming rules (lanes, entity-type colors, annotations, anti-patterns, etc.)
2. Call read_notebook to parse the .ipynb file
3. Analyze the notebook content following ALL Jupyter Diagramming rules from read_me:
   - Assign each box a COLOR based on entity type (BLUE=data, GRAY=process, RED=model, GREEN=evaluation, WHITE=output)
   - Assign each box to a LANE based on pipeline stage (ARTIFACTS, PROCESSING, MODELLING, EVALUATION, REPORT)
   - Color and Lane are INDEPENDENT dimensions
   - Add annotations (data shapes, model configs, metric results)
   - Follow the layout anti-patterns list (no single-column centering, no arrow-through-box, etc.)
4. Call create_view with the complete diagram

Key rules (full details in read_me):
- Elements are a JSON array of Excalidraw element objects
- ALWAYS start with a cameraUpdate element (4:3 ratio: 800x600, 400x300, etc.)
- Use labeled shapes: { "type": "rectangle", "label": { "text": "...", "fontSize": 20 } }
- Use the spec's color palette — never invent colors
- Emit elements progressively: background → shape → label → arrows → next shape
- Use multiple cameraUpdate elements to pan/zoom during streaming — this is the most engaging feature
- Minimum fontSize: 14 (secondary), 16 (body), 20 (titles)
`;

/**
 * Registers all Excalidraw tools and resources on the given McpServer.
 * Shared between local (main.ts) and Vercel (api/mcp.ts) entry points.
 */
export function registerTools(server: McpServer, distDir: string, store: CheckpointStore): void {
  const resourceUri = "ui://excalidraw/mcp-app.html";

  // Track whether read_me has been called in this session
  let readMeCalled = false;

  // ============================================================
  // Tool 1: read_me (call before drawing)
  // ============================================================
  server.registerTool(
    "read_me",
    {
      description: "Returns the MANDATORY Excalidraw element format reference (color palettes, element types, camera sizing, examples) AND the Jupyter Notebook Diagramming rules (lanes, entity-type colors, annotations, layout anti-patterns, consistency rules). You MUST call this BEFORE using create_view — the spec contains rules and examples that are required to produce correct diagrams.",
      annotations: { readOnlyHint: true },
    },
    async (): Promise<CallToolResult> => {
      readMeCalled = true;
      const combined = `${EXCALIDRAW_SPECS}\n\n---\n\n${LIVE_UPDATES_PROMPT}\n\n---\n\n${JUPYTER_INSTRUCTIONS}`;
      return { content: [{ type: "text", text: combined }] };
    },
  );

  // ============================================================
  // Tool 1b: read_jupyter_instructions (standalone Jupyter rules)
  // ============================================================
  server.registerTool(
    "read_jupyter_instructions",
    {
      description: "Returns the Jupyter Notebook Diagramming rules — lanes (ARTIFACTS, PROCESSING, MODELLING, EVALUATION, REPORT), entity-type box colors (BLUE=data, GRAY=process, RED=model, GREEN=evaluation, WHITE=output), annotations, layout anti-patterns, and consistency rules. These rules are MANDATORY when diagramming any data science or ML notebook. Also included in read_me.",
      annotations: { readOnlyHint: true },
    },
    async (): Promise<CallToolResult> => {
      return { content: [{ type: "text", text: JUPYTER_INSTRUCTIONS }] };
    },
  );

  // ============================================================
  // Tool 2: read_notebook (read Jupyter notebook content)
  // ============================================================
  server.registerTool(
    "read_notebook",
    {
      description: "Reads a Jupyter notebook (.ipynb) file and returns its code and markdown cells as structured text. Use this to understand what the notebook does before creating a diagram.",
      inputSchema: z.object({
        path: z.string().describe("Absolute or relative path to a .ipynb file."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ path: notebookPath }): Promise<CallToolResult> => {
      try {
        const resolvedPath = path.resolve(notebookPath);
        const raw = await fs.readFile(resolvedPath, "utf-8");
        const notebook = JSON.parse(raw);

        if (!notebook.cells || !Array.isArray(notebook.cells)) {
          return {
            content: [{ type: "text", text: "Invalid notebook format: no cells array found." }],
            isError: true,
          };
        }

        const output: string[] = [];
        output.push(`# Notebook: ${path.basename(resolvedPath)}`);
        output.push(`Total cells: ${notebook.cells.length}\n`);

        for (let i = 0; i < notebook.cells.length; i++) {
          const cell = notebook.cells[i];
          const cellType = cell.cell_type ?? "unknown";
          const source = Array.isArray(cell.source) ? cell.source.join("") : (cell.source ?? "");

          if (!source.trim()) continue; // skip empty cells

          output.push(`--- Cell ${i + 1} [${cellType}] ---`);
          output.push(source);
          output.push("");
        }

        return { content: [{ type: "text", text: output.join("\n") }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to read notebook: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // ============================================================
  // Tool 3: create_view (Excalidraw SVG)
  // ============================================================
  registerAppTool(server,
    "create_view",
    {
      title: "Draw Diagram",
      description: `Renders a hand-drawn diagram using Excalidraw elements.
Elements stream in one by one with draw-on animations.
You MUST call read_me first to learn the element format — diagrams will not render correctly without following the spec.`,
      inputSchema: z.object({
        elements: z.string().describe(
          "JSON array string of Excalidraw elements. Must be valid JSON — no comments, no trailing commas. Keep compact. You MUST call read_me first for format reference."
        ),
      }),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri } },
    },
    async ({ elements }): Promise<CallToolResult> => {
      if (elements.length > MAX_INPUT_BYTES) {
        return {
          content: [{ type: "text", text: `Elements input exceeds ${MAX_INPUT_BYTES} byte limit. Reduce the number of elements or use checkpoints to build incrementally.` }],
          isError: true,
        };
      }
      let parsed: any[];
      try {
        parsed = JSON.parse(elements);
      } catch (e) {
        return {
          content: [{ type: "text", text: `Invalid JSON in elements: ${(e as Error).message}. Ensure no comments, no trailing commas, and proper quoting.` }],
          isError: true,
        };
      }

      // Resolve restoreCheckpoint references and save fully resolved state
      const restoreEl = parsed.find((el: any) => el.type === "restoreCheckpoint");
      let resolvedElements: any[];

      if (restoreEl?.id) {
        const base = await store.load(restoreEl.id);
        if (!base) {
          return {
            content: [{ type: "text", text: `Checkpoint "${restoreEl.id}" not found — it may have expired or never existed. Please recreate the diagram from scratch.` }],
            isError: true,
          };
        }

        const deleteIds = new Set<string>();
        for (const el of parsed) {
          if (el.type === "delete") {
            for (const id of String(el.ids ?? el.id).split(",")) deleteIds.add(id.trim());
          }
        }

        const baseFiltered = base.elements.filter((el: any) =>
          !deleteIds.has(el.id) && !deleteIds.has(el.containerId)
        );
        const newEls = parsed.filter((el: any) =>
          el.type !== "restoreCheckpoint" && el.type !== "delete"
        );
        resolvedElements = [...baseFiltered, ...newEls];
      } else {
        resolvedElements = parsed.filter((el: any) => el.type !== "delete");
      }

      // Check camera aspect ratios — nudge toward 4:3
      const cameras = parsed.filter((el: any) => el.type === "cameraUpdate");
      const badRatio = cameras.find((c: any) => {
        if (!c.width || !c.height) return false;
        const ratio = c.width / c.height;
        return Math.abs(ratio - 4 / 3) > 0.15;
      });
      const ratioHint = badRatio
        ? `\nTip: your cameraUpdate used ${badRatio.width}x${badRatio.height} — try to stick with 4:3 aspect ratio (e.g. 400x300, 800x600) in future.`
        : "";

      const checkpointId = crypto.randomUUID().replace(/-/g, "").slice(0, 18);
      await store.save(checkpointId, { elements: resolvedElements });

      // If read_me was never called, include the spec in the response so the LLM
      // has the format reference for any subsequent create_view calls.
      const specReminder = readMeCalled
        ? ""
        : `\n\n⚠ You did not call read_me before drawing. For future diagrams, follow this spec:\n\n${EXCALIDRAW_SPECS}\n\n---\n\n${LIVE_UPDATES_PROMPT}\n\n---\n\n${JUPYTER_INSTRUCTIONS}`;

      return {
        content: [{
          type: "text", text: `Diagram displayed! Checkpoint id: "${checkpointId}".
If user asks to create a new diagram - simply create a new one from scratch.
However, if the user wants to edit something on this diagram "${checkpointId}", take these steps:
1) read widget context (using read_widget_context tool) to check if user made any manual edits first
2) decide whether you want to make new diagram from scratch OR - use this one as starting checkpoint:
  simply start from the first element [{"type":"restoreCheckpoint","id":"${checkpointId}"}, ...your new elements...]
  this will use same diagram state as the user currently sees, including any manual edits they made in fullscreen, allowing you to add elements on top.
  To remove elements, use: {"type":"delete","ids":"<id1>,<id2>"}${ratioHint}${specReminder}`
        }],
        structuredContent: { checkpointId },
      };
    },
  );

  // ============================================================
  // Tool 4: export_to_excalidraw (server-side proxy for CORS)
  // Called by widget via app.callServerTool(), not by the model.
  // ============================================================
  registerAppTool(server,
    "export_to_excalidraw",
    {
      description: "Upload diagram to excalidraw.com and return shareable URL.",
      inputSchema: { json: z.string().describe("Serialized Excalidraw JSON") },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ json }): Promise<CallToolResult> => {
      if (json.length > MAX_INPUT_BYTES) {
        return {
          content: [{ type: "text", text: `Export data exceeds ${MAX_INPUT_BYTES} byte limit.` }],
          isError: true,
        };
      }
      try {
        // --- Excalidraw v2 binary format ---
        const remappedJson = json;
        // concatBuffers: [version=1 (4B)] [len₁ (4B)] [data₁] [len₂ (4B)] [data₂] ...
        const concatBuffers = (...bufs: Uint8Array[]): Uint8Array => {
          let total = 4; // version header
          for (const b of bufs) total += 4 + b.length;
          const out = new Uint8Array(total);
          const dv = new DataView(out.buffer);
          dv.setUint32(0, 1); // CONCAT_BUFFERS_VERSION = 1
          let off = 4;
          for (const b of bufs) {
            dv.setUint32(off, b.length);
            off += 4;
            out.set(b, off);
            off += b.length;
          }
          return out;
        };
        const te = new TextEncoder();

        // 1. Inner payload: concatBuffers(fileMetadata, data)
        const fileMetadata = te.encode(JSON.stringify({}));
        const dataBytes = te.encode(remappedJson);
        const innerPayload = concatBuffers(fileMetadata, dataBytes);

        // 2. Compress inner payload with zlib deflate
        const compressed = deflateSync(Buffer.from(innerPayload));

        // 3. Generate AES-GCM 128-bit key + encrypt
        const cryptoKey = await globalThis.crypto.subtle.generateKey(
          { name: "AES-GCM", length: 128 },
          true,
          ["encrypt"],
        );
        const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await globalThis.crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          cryptoKey,
          compressed,
        );

        // 4. Encoding metadata (tells excalidraw.com how to decode)
        const encodingMeta = te.encode(JSON.stringify({
          version: 2,
          compression: "pako@1",
          encryption: "AES-GCM",
        }));

        // 5. Outer payload: concatBuffers(encodingMeta, iv, encryptedData)
        const payload = Buffer.from(concatBuffers(encodingMeta, iv, new Uint8Array(encrypted)));

        // 5. Upload to excalidraw backend
        const res = await fetch("https://json.excalidraw.com/api/v2/post/", {
          method: "POST",
          body: payload,
        });
        if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
        const { id } = (await res.json()) as { id: string };

        // 6. Export key as base64url string
        const jwk = await globalThis.crypto.subtle.exportKey("jwk", cryptoKey);
        const url = `https://excalidraw.com/#json=${id},${jwk.k}`;

        return { content: [{ type: "text", text: url }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Export failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // ============================================================
  // Tool 5: save_checkpoint (private — widget only, for user edits)
  // ============================================================
  registerAppTool(server,
    "save_checkpoint",
    {
      description: "Update checkpoint with user-edited state.",
      inputSchema: { id: z.string(), data: z.string() },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ id, data }): Promise<CallToolResult> => {
      if (data.length > MAX_INPUT_BYTES) {
        return {
          content: [{ type: "text", text: `Checkpoint data exceeds ${MAX_INPUT_BYTES} byte limit.` }],
          isError: true,
        };
      }
      try {
        await store.save(id, JSON.parse(data));
        return { content: [{ type: "text", text: "ok" }] };
      } catch (err) {
        return { content: [{ type: "text", text: `save failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ============================================================
  // Tool 6: read_checkpoint (private — widget only)
  // ============================================================
  registerAppTool(server,
    "read_checkpoint",
    {
      description: "Read checkpoint state for restore.",
      inputSchema: { id: z.string() },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ id }): Promise<CallToolResult> => {
      try {
        const data = await store.load(id);
        if (!data) return { content: [{ type: "text", text: "" }] };
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `read failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // CSP: allow Excalidraw to load fonts from esm.sh
  const cspMeta = {
    ui: {
      csp: {
        resourceDomains: ["https://esm.sh"],
        connectDomains: ["https://esm.sh"],
      },
    },
  };

  // Register the single shared resource for all UI tools
  registerAppResource(server,
    resourceUri,
    resourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(path.join(distDir, "mcp-app.html"), "utf-8");
      return {
        contents: [{
          uri: resourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: {
            ui: {
              ...cspMeta.ui,
              prefersBorder: true,
              permissions: { clipboardWrite: {} },
            },
          },
        }],
      };
    },
  );
}

/**
 * Creates a new MCP server instance with JupyterDraw drawing tools.
 * Used by local entry point (main.ts) and Docker deployments.
 */
export function createServer(store: CheckpointStore): McpServer {
  const server = new McpServer({
    name: "JupyterDraw",
    version: "1.0.0",
  }, {
    instructions: SERVER_INSTRUCTIONS,
  });
  registerTools(server, DIST_DIR, store);
  return server;
}
