# Jupyter Notebook Diagramming — Excalidraw Spec

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
| **BLUE**  | `#a5d8ff` | `#4a9eed`  | Data entity  | A named data artifact: dataset, dataframe, array, file, split, embedding.                              | `df_raw`, `X_train`, `train.csv`                               |
| **GRAY**  | `#e9ecef` | `#868e96`  | Process step | An operation applied to data or a model: function call, transformation, cleaning step, or computation. | `StandardScaler()`, `Split Train/Test`, `remove_duplicates()`  |
| **RED**   | `#ffc9c9` | `#ef4444`  | Model        | A model definition, training call, or HP search.                                                       | `LogisticRegression()`, `CNN()`, `clf.fit()`, `GridSearchCV()` |
| **GREEN** | `#b2f2bb` | `#22c55e`  | Evaluation   | A step that measures model or data quality against a reference.                                        | `accuracy_score()`, `confusion_matrix()`, `cross_val_score()`  |
| **WHITE** | `#ffffff` | `#868e96`  | Output       | Any human-readable result: plot, printed summary, or exported report. Can appear in any lane.          | `plt.show()`, `print(df.head())`, `sns.heatmap()`              |

Examples of color mixed within a single lane:

- **PROCESSING** lane may contain: BLUE (`df_clean`), GRAY (`StandardScaler()`), WHITE (dist plot)
- **MODELLING** lane may contain: BLUE (`X_train`), RED (`clf.fit()`), GREEN (val accuracy)
- **REPORT** lane may contain: GREEN (final metrics), WHITE (confusion matrix plot), BLUE (predictions df)

---

## BOX CONTENT RULES

- Each box must contain a label that describes what the box represents.
- The label must be concise and clear.
- The labels can be short description (e.g. Split test data) or contain references to the functions, variables or markdown in the notebook (e.g. `Step 6: train_test_split()`).
- In each box you can draw visualizations (e.g. a tree model, tables, etc.) when it helps understanding the content of the box.
- Visualization are mandatory in output boxes with plots, clearly sketching what is being plotted (e.g. histogram of variable X).
- Each box can have at most one visualization.

---

## LANES (workflow stage)

Lanes are spatial columns that group boxes by pipeline stage — not by box type.
Place a box in the lane that describes the stage of the notebook where it appears.
Lanes are created in the END, after knowing the position of all the boxes.

```
┌───────────┬────────────┬────────────┬────────────┬────────────┐
│ ARTIFACTS │ PROCESSING │ MODELLING  │ EVALUATION │   REPORT   │
└───────────┴────────────┴────────────┴────────────┴────────────┘
```

| Lane           | Description                                                                                                                                              | Typical Box Colors |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **ARTIFACTS**  | External data entities before notebook runs or written back out. Inputs: `train.csv`, `test.csv`, API response. Outputs: `predictions.csv`, `model.pkl`. | BLUE               |
| **PROCESSING** | Data preparation: loading, cleaning, transforming, splitting.                                                                                            | BLUE, GRAY, WHITE  |
| **MODELLING**  | Models defined, trained, or tuned.                                                                                                                       | RED, GREEN         |
| **EVALUATION** | Trained model tested on held-out data and measured.                                                                                                      | GREEN, BLUE, WHITE |
| **REPORT**     | Final human-readable outputs: polished visualizations and summaries.                                                                                     | WHITE, GREEN, BLUE |

"Typical colors" above are guidance, not rules. **Any color can appear in any lane.**
When in doubt: assign the lane by _when_ it happens, assign the color by _what_ it is.

---

## DEPLOYMENT ANNOTATIONS (no separate lane)

There is no DEPLOY lane. Deployment intent is captured with annotations on existing boxes:

- If the notebook saves a model to disk (`joblib.dump()`, `model.save()`, `torch.save()`),
  draw a back-arrow to ARTIFACTS with a label for the saved file (e.g., "model.pkl").
  Add a small `★ deploy` tag near that ARTIFACTS box.
- If the notebook does not save the model but one is clearly the final/intended one,
  annotate its RED box directly with `★ deploy`.
- Only one model should carry the `★ deploy` tag.

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

---

## LAYOUT ANTI-PATTERNS (avoid these)

- ✗ **SINGLE-COLUMN CENTERING**: If a box has >1 outgoing arrow, targets MUST be offset.
- ✗ **ARROW-THROUGH-BOX**: No arrow may pass through another box. Reroute or add gaps.
- ✗ **ARROW BUNDLES**: Never draw two arrows on top of each other. Spread apart.
- ✗ **INVISIBLE BACK-ARROWS**: Back-arrows must be visible curves with readable labels.
- ✗ **UNIFORM ROW HEIGHT**: Allow rows to be taller when parallel tracks need more space.

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

- **BLUE** boxes: shape or size (`"N=50k"`, `"(128,28,28)"`, `"80/20 split"`)
- **RED** boxes: key config (`"lr=1e-3"`, `"depth=5"`, `"n_estimators=100"`);
  add `★ deploy` if this is the model to be deployed
- **GREEN** boxes: metric result (`"AUC=0.84"`, `"acc=0.91"`, `"F1=0.78"`)
- **BLUE** (ARTIFACTS, saved model): add `★ deploy` if this file is the deployed artifact

---

## OUTPUT BOX SKETCHES

For every WHITE box (plot, printout), sketch a rough representation inside it
using small inner shapes (ellipses, rectangles, lines):

- **line plot** → axes + curve, label x/y (e.g., "loss vs epoch")
- **bar chart** → bars of different heights, label x axis
- **grid** → small grid of squares (e.g., 3×3 digit images)
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

---
