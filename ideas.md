# Ideas for Future Development

## Multi-Agent Architecture

Instead of a single agent doing everything (reading notebook, planning layout, generating elements, reviewing quality), split responsibilities across specialized agents:

### Proposed Agents

1. **Planner Agent** — Reads the notebook, identifies key workflow stages, data flows, and important variables. Outputs a structured diagram plan (nodes, edges, groupings, annotations).

2. **Layout Agent** — Takes the plan and determines optimal spatial positioning. Handles coordinate math, spacing, grouping zones, and ensures no overlaps. Outputs positioned element skeletons.

3. **Renderer Agent** — Takes positioned skeletons and generates final Excalidraw elements with styling (colors, icons, labels, arrows). Calls `search_icons` and applies the color palette.

4. **Reviewer Agent** — Receives the rendered diagram (as image), evaluates quality against the notebook content. Checks for: overlaps, readability, completeness, accuracy. Sends corrections back to the Layout or Renderer agent.

### Benefits
- Each agent has a focused, simpler task → better quality per step
- The Reviewer agent provides the "visual grounding" that the current single-shot approach lacks
- Agents can be different models (e.g., fast model for layout, strong model for planning)
- Easier to debug which step is causing quality issues

### Implementation Notes
- Could use a simple orchestrator that pipes outputs between agents
- The Planner → Layout → Renderer pipeline is sequential
- The Reviewer → Layout/Renderer feedback loop enables iterative improvement
- Consider using different temperature settings per agent (low for Layout, higher for Renderer)
