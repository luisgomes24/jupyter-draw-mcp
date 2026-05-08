"""
Headless agent that reads a Jupyter notebook via the Excalidraw MCP server
and generates a .excalidraw diagram file — no human interaction required.

Supports two modes:
  - fast:       Single-shot LLM call (original behaviour, quick but "blind")
  - iterative:  Multi-turn loop with visual checkpoints — the LLM builds the
                diagram in sections, receives a rendered preview after each
                create_view call, and self-corrects before saving.

Usage:
    python agent.py <notebook_path> [output_path] [--mode fast|iterative]

Environment variables:
    OPENROUTER_API_KEY  — API key for OpenRouter (required)
    MODEL              — LiteLLM model string (default: openai/gpt-5.4)
"""

import argparse
import asyncio
import json
import os
import re
import sys
from pathlib import Path

from dotenv import load_dotenv
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
import litellm

load_dotenv()

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parent.parent
MCP_SERVER_CMD = "node"
MCP_SERVER_ARGS = [str(PROJECT_ROOT / "dist" / "index.js"), "--stdio"]

DEFAULT_MODEL = os.environ.get("MODEL", "openai/gpt-5.4")

MAX_ITERATIONS = 5  # Safety cap for iterative mode

# ---------------------------------------------------------------------------
# System prompts
# ---------------------------------------------------------------------------

# Shared diagram style instructions (used by both modes)
DIAGRAM_STYLE = """
You are an expert diagramming assistant that turns a data science / machine learning workflow (often from a Jupyter notebook) into an informal whiteboard-style diagram.

Use ONLY:
- Rectangular boxes for all elements (data, processes, models, plots, monitoring).
- Arrows between boxes to show relationships.
- Short text labels and small icons or rough sketches INSIDE or next to boxes.
No other shapes (no diamonds, circles, swimlanes, legends).

High-level intent:
- The diagram should look like what an ML practitioner would sketch on a whiteboard to explain their pipeline.
- You decide which boxes represent data vs. processes vs. models vs. etc. based on the workflow description.
- Arrows can mean order of operations, data flow, or feedback; infer which makes most sense and label only when needed (e.g., "train/val split", "retrain loop").

Pipeline structure:
- Impose a simple left→right AND top→bottom flow that roughly follows standard data science lifecycle
- Give high importance to data and how they are used in the steps
- It must be very clear visually/spatially which data is used where (e.g. which train data is used in which model)
- Show important branching dynamics:
  - train / validation / test splits,
  - alternative models (baseline vs. model v2),

Labels, annotations, and icons:
- Use concise labels on boxes:
  examples: "clean data", "EDA", "build features", "train RF", "serve API", "monitor drift".
- Add small numeric or textual annotations near key boxes:
  examples: "AUC=0.84", "N=1M rows", "latency=120ms", "drift p<0.01".
- Mark special boxes with lightweight secondary notation:
  star, exclamation, or colored border, with labels like "Feature leakage?", "Label noise risk".
- Use icons (e.g., table, gear, model, cloud, chart) but keep everything inside or attached to rectangular boxes.

Visualization / plot nodes:
- Inside visualization boxes, sketch a rough representation of the plot instead of a generic icon:
  example: a bar chart silhouette, a 3x3 grid of handwritten digits, axes with minimal ticks.
- Include explicit annotations for axis and other components:
  examples: " accuracy vs epoch", "confusion matrix", "MNIST sample grid".

- When possible, mention the plotted variables in the label or annotation:
  examples: "acc vs epoch", "income vs age", "number examples", "pred vs true", etc.

Style:
- Favor a hand-drawn feel in layout and spacing, but keep the logical flow clear.
- Avoid long prose, legends, or dense color schemes; 
- Understanding should come from the arrangement of boxes, arrows, and short labels.
- Each box MUST HAVE one text label and one Icon/Visualization (use the search_icons tool or draw it yourself)
"""

# Fast mode: single-shot JSON generation (original behaviour)
SYSTEM_PROMPT_FAST = DIAGRAM_STYLE + """
Output format:
Save the .excalidraw file locally.

You MUST respond with ONLY a valid JSON array of Excalidraw elements.
No markdown code fences, no explanation text, no comments — ONLY the raw JSON array.
"""

# Iterative mode: multi-turn with visual checkpoints
SYSTEM_PROMPT_ITERATIVE = DIAGRAM_STYLE + """
## Workflow (CRITICAL — follow this step by step)

You are building the diagram ITERATIVELY with structural and visual feedback. Follow this process:

1. **Icons first**: Call `search_icons` to find appropriate icons for your nodes BEFORE drawing.

2. **Build in 2–3 passes** using `draft_view`:
   - **Pass 1**: Draw the main structure — primary boxes, key labels, and major arrows.
   - **Pass 2**: Use `restoreCheckpoint` from the previous checkpoint ID. Add secondary elements, annotations, details, and fix any issues.
   - **Pass 3** (if needed): Fix remaining overlaps or readability issues.

3. **Review the feedback**: After each `draft_view` call, you will receive:
   - Structural feedback from the server (element count, bounding box, overlap detection)
   - A rendered preview image of your diagram
   Carefully inspect both for:
    - Overlapping boxes or text
    - Unreadable or hidden labels
    - Missing connections
    - Poor spacing or layout
    Fix any issues in your next pass.

4. **Finalize**: When satisfied, call `save_excalidraw_file` with ALL the final elements to write the .excalidraw file.
   You can use `read_checkpoint` to retrieve the full element state from your last checkpoint.

IMPORTANT RULES:
- `draft_view` elements format is a JSON array string — same format as documented in the cheat sheet.
- When using `restoreCheckpoint`, only provide NEW elements — the checkpoint's elements are restored automatically.
- You can delete elements from a checkpoint with `{"type": "delete", "ids": "id1,id2"}`.
- For the final `save_excalidraw_file`, provide ALL elements (no restoreCheckpoint). Use `read_checkpoint` to get the full state.
- Keep the total number of iterations to 2–3 passes (max 5).
"""





def extract_json_array(text: str) -> str:
    """
    Extract a JSON array from LLM response text.
    Handles responses wrapped in markdown code fences or with extra text.
    """
    # Try direct parse first
    text = text.strip()
    if text.startswith("["):
        try:
            json.loads(text)
            return text
        except json.JSONDecodeError:
            pass

    # Try extracting from markdown code fences
    patterns = [
        r"```json\s*\n(.*?)```",
        r"```\s*\n(.*?)```",
        r"\[.*\]",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.DOTALL)
        if match:
            candidate = match.group(1) if match.lastindex else match.group(0)
            candidate = candidate.strip()
            try:
                json.loads(candidate)
                return candidate
            except json.JSONDecodeError:
                continue

    # Last resort: find the first [ and last ]
    first_bracket = text.find("[")
    last_bracket = text.rfind("]")
    if first_bracket != -1 and last_bracket > first_bracket:
        candidate = text[first_bracket : last_bracket + 1]
        try:
            json.loads(candidate)
            return candidate
        except json.JSONDecodeError:
            pass

    raise ValueError(
        f"Could not extract valid JSON array from LLM response:\n{text[:500]}"
    )


async def call_mcp_tool(session: ClientSession, tool_name: str, args: dict) -> str:
    """Call an MCP tool and return the text content."""
    result = await session.call_tool(tool_name, args)
    text_parts = []
    for item in result.content:
        if hasattr(item, "text"):
            text_parts.append(item.text)
    return "\n".join(text_parts)


def _build_llm_tools(tools_result) -> list[dict]:
    """Build LLM tool definitions from MCP tools, exposing the ones we need."""
    exposed_tools = {"search_icons", "draft_view", "save_excalidraw_file", "read_checkpoint"}
    llm_tools = []
    for t in tools_result.tools:
        if t.name in exposed_tools:
            llm_tools.append(
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.inputSchema,
                    },
                }
            )
    return llm_tools


def _build_llm_tools_fast(tools_result) -> list[dict]:
    """Build LLM tool definitions for fast mode (search_icons only)."""
    llm_tools = []
    for t in tools_result.tools:
        if t.name == "search_icons":
            llm_tools.append(
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.inputSchema,
                    },
                }
            )
    return llm_tools


def _generate_visual_feedback(elements_json: str) -> tuple[str, str | None]:
    """
    Generate visual feedback for the LLM after a create_view call.

    Returns:
        (text_feedback, base64_png_or_none)
    """
    try:
        from render_preview import detect_overlaps, render_to_base64

        elements = json.loads(elements_json)
        # Filter to drawable elements for analysis
        drawable = [
            el for el in elements
            if el.get("type") not in ("cameraUpdate", "delete", "restoreCheckpoint")
        ]

        overlap_text = detect_overlaps(drawable)
        base64_png = render_to_base64(drawable)

        text = f"Preview rendered ({len(drawable)} elements)."
        if overlap_text:
            text += f" {overlap_text}"

        return text, base64_png
    except Exception as e:
        return f"Could not render preview: {e}", None


# ---------------------------------------------------------------------------
# Fast mode (original single-shot behavior)
# ---------------------------------------------------------------------------
async def run_agent_fast(
    session: ClientSession, notebook_path: str, output_path: str, cheat_sheet: str, notebook_content: str
) -> None:
    """Original single-shot agent: one LLM call → save."""
    tools_result = await session.list_tools()
    llm_tools = _build_llm_tools_fast(tools_result)

    print(f"[agent] Calling LLM ({DEFAULT_MODEL}) in FAST mode...")
    user_message = (
        f"## Excalidraw Element Format Reference\n\n{cheat_sheet}\n\n"
        f"---\n\n"
        f"## Jupyter Notebook Content\n\n{notebook_content}\n\n"
        f"---\n\n"
        f"Now generate the Excalidraw elements JSON array for a diagram "
        f"that visualises this notebook's workflow. "
        f"Use the `search_icons` tool to find appropriate icons for your nodes BEFORE generating the final JSON array. "
        f"When you are ready to produce the diagram, respond with ONLY the JSON array, nothing else."
    )

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT_FAST},
        {"role": "user", "content": user_message},
    ]

    while True:
        response = litellm.completion(
            model=DEFAULT_MODEL,
            messages=messages,
            tools=llm_tools if llm_tools else None,
        )

        msg = response.choices[0].message

        if getattr(msg, "tool_calls", None):
            assistant_msg = {"role": "assistant", "content": msg.content or ""}
            assistant_msg["tool_calls"] = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    },
                }
                for tc in msg.tool_calls
            ]
            messages.append(assistant_msg)

            for tool_call in msg.tool_calls:
                if tool_call.function.name == "search_icons":
                    try:
                        args = json.loads(tool_call.function.arguments)
                        print(f"[agent]   → LLM called search_icons({args})")
                        tool_result = await call_mcp_tool(
                            session, "search_icons", args
                        )
                        print(
                            f"[agent]   ← Got icons result ({len(tool_result)} chars)"
                        )
                    except Exception as e:
                        print(f"[agent]   ! Tool error: {e}")
                        tool_result = f"Error: {e}"

                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "name": tool_call.function.name,
                            "content": tool_result,
                        }
                    )
        else:
            raw_response = msg.content or ""
            break

    print(f"[agent]   ← Got final LLM response ({len(raw_response)} chars)")

    try:
        elements_json = extract_json_array(raw_response)
    except ValueError as e:
        print(f"[agent] ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    parsed = json.loads(elements_json)
    print(f"[agent]   ← Parsed {len(parsed)} elements")

    print(f"[agent] Saving to {output_path}...")
    save_result = await call_mcp_tool(
        session,
        "save_excalidraw_file",
        {"path": output_path, "elements": elements_json},
    )
    print(f"[agent]   ← {save_result}")


# ---------------------------------------------------------------------------
# Iterative mode (multi-turn with visual feedback)
# ---------------------------------------------------------------------------
async def run_agent_iterative(
    session: ClientSession, notebook_path: str, output_path: str, cheat_sheet: str, notebook_content: str
) -> None:
    """Iterative agent: multi-turn tool loop with visual checkpoints."""
    tools_result = await session.list_tools()
    llm_tools = _build_llm_tools(tools_result)

    print(f"[agent] Calling LLM ({DEFAULT_MODEL}) in ITERATIVE mode...")
    user_message = (
        f"## Excalidraw Element Format Reference\n\n{cheat_sheet}\n\n"
        f"---\n\n"
        f"## Jupyter Notebook Content\n\n{notebook_content}\n\n"
        f"---\n\n"
        f"Create an Excalidraw diagram that visualises this notebook's workflow.\n"
        f"Follow the iterative workflow from your instructions:\n"
        f"1. Search for icons first\n"
        f"2. Build the diagram in 2-3 passes using draft_view\n"
        f"3. Review each preview and fix issues\n"
        f"4. Call save_excalidraw_file with the final elements when done\n\n"
        f"The output file should be saved to: {output_path}"
    )

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT_ITERATIVE},
        {"role": "user", "content": user_message},
    ]

    iteration = 0
    last_checkpoint_id = None
    last_elements_json = None
    done = False

    while not done and iteration < MAX_ITERATIONS:
        iteration += 1
        print(f"\n[agent] === Iteration {iteration}/{MAX_ITERATIONS} ===")

        response = litellm.completion(
            model=DEFAULT_MODEL,
            messages=messages,
            tools=llm_tools if llm_tools else None,
        )

        msg = response.choices[0].message

        if not getattr(msg, "tool_calls", None):
            # LLM responded with text instead of tool calls
            print(f"[agent] LLM text response: {(msg.content or '')[:200]}")

            # Check if LLM produced a JSON array directly (fallback)
            raw = msg.content or ""
            try:
                elements_json = extract_json_array(raw)
                print(f"[agent] LLM returned raw JSON — saving directly")
                save_result = await call_mcp_tool(
                    session,
                    "save_excalidraw_file",
                    {"path": output_path, "elements": elements_json},
                )
                print(f"[agent]   ← {save_result}")
                done = True
            except ValueError:
                # Not JSON — add to messages and continue
                messages.append({"role": "assistant", "content": raw})
                messages.append(
                    {
                        "role": "user",
                        "content": "Please use the tools to build the diagram. Start by calling search_icons, then use create_view.",
                    }
                )
            continue

        # Process tool calls
        assistant_msg = {"role": "assistant", "content": msg.content or ""}
        assistant_msg["tool_calls"] = [
            {
                "id": tc.id,
                "type": "function",
                "function": {
                    "name": tc.function.name,
                    "arguments": tc.function.arguments,
                },
            }
            for tc in msg.tool_calls
        ]
        messages.append(assistant_msg)

        for tool_call in msg.tool_calls:
            tool_name = tool_call.function.name
            try:
                args = json.loads(tool_call.function.arguments)
            except json.JSONDecodeError:
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "name": tool_name,
                        "content": "Error: Invalid JSON in arguments",
                    }
                )
                continue

            print(f"[agent]   → LLM called {tool_name}({list(args.keys())})")

            if tool_name == "save_excalidraw_file":
                # Final save — done!
                elements_str = args.get("elements", "[]")
                save_path = args.get("path", output_path)
                tool_result = await call_mcp_tool(
                    session, "save_excalidraw_file",
                    {"path": save_path, "elements": elements_str},
                )
                print(f"[agent]   ← {tool_result}")
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "name": tool_name,
                        "content": tool_result,
                    }
                )
                done = True

            elif tool_name == "draft_view":
                elements_str = args.get("elements", "[]")
                last_elements_json = elements_str
                tool_result = await call_mcp_tool(
                    session, "draft_view", {"elements": elements_str},
                )
                print(f"[agent]   ← draft_view result: {tool_result[:150]}")

                # Extract checkpoint ID from result
                cp_match = re.search(r'Checkpoint id: "([^"]+)"', tool_result)
                if cp_match:
                    last_checkpoint_id = cp_match.group(1)
                    print(f"[agent]   ← Checkpoint: {last_checkpoint_id}")

                # Add tool result (includes structural feedback from server)
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "name": tool_name,
                        "content": tool_result,
                    }
                )

                # Generate and inject visual feedback (client-side rendering)
                text_feedback, base64_png = _generate_visual_feedback(elements_str)
                print(f"[agent]   ← Feedback: {text_feedback}")

                feedback_content: list[dict] = [
                    {"type": "text", "text": f"[Visual Preview] {text_feedback}"}
                ]
                if base64_png:
                    feedback_content.append(
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/png;base64,{base64_png}"
                            },
                        }
                    )
                messages.append({"role": "user", "content": feedback_content})

            elif tool_name in ("search_icons", "read_checkpoint"):
                tool_result = await call_mcp_tool(session, tool_name, args)
                print(f"[agent]   ← Got {tool_name} result ({len(tool_result)} chars)")
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "name": tool_name,
                        "content": tool_result,
                    }
                )

            else:
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "name": tool_name,
                        "content": f"Unknown tool: {tool_name}",
                    }
                )

    # If we hit max iterations without save_excalidraw_file, save from last state
    if not done:
        print(f"\n[agent] Max iterations reached — saving from last state...")
        if last_checkpoint_id:
            # Load checkpoint and save
            print(f"[agent] Loading checkpoint {last_checkpoint_id}...")
            checkpoint_data = await call_mcp_tool(
                session, "read_checkpoint", {"id": last_checkpoint_id},
            )
            if checkpoint_data:
                try:
                    data = json.loads(checkpoint_data)
                    final_elements = json.dumps(data.get("elements", []))
                    save_result = await call_mcp_tool(
                        session,
                        "save_excalidraw_file",
                        {"path": output_path, "elements": final_elements},
                    )
                    print(f"[agent]   ← {save_result}")
                    done = True
                except (json.JSONDecodeError, KeyError) as e:
                    print(f"[agent]   ! Checkpoint load error: {e}")

        if not done and last_elements_json:
            # Fallback: save the last elements the LLM sent
            print(f"[agent] Fallback: saving last elements directly...")
            save_result = await call_mcp_tool(
                session,
                "save_excalidraw_file",
                {"path": output_path, "elements": last_elements_json},
            )
            print(f"[agent]   ← {save_result}")

        if not done:
            print(f"[agent] ERROR: No elements to save!", file=sys.stderr)
            sys.exit(1)


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------
async def run_agent(notebook_path: str, output_path: str, mode: str = "iterative") -> None:
    """
    Connect to the MCP server, read the notebook, call the LLM, and save the diagram.
    """
    server_params = StdioServerParameters(
        command=MCP_SERVER_CMD,
        args=MCP_SERVER_ARGS,
    )

    print(
        f"[agent] Connecting to MCP server: {MCP_SERVER_CMD} {' '.join(MCP_SERVER_ARGS)}"
    )
    async with stdio_client(server_params) as (read_stream, write_stream):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()

            # Discover available tools (for logging)
            tools_result = await session.list_tools()
            tool_names = [t.name for t in tools_result.tools]
            print(f"[agent] Available MCP tools: {tool_names}")

            # Step 1: Get the Excalidraw cheat sheet via MCP prompt
            prompt_name = "diagram_automatic" if mode == "iterative" else "diagram_interactive"
            print(f"[agent] Step 1: Fetching prompt '{prompt_name}'...")
            try:
                prompt_result = await session.get_prompt(prompt_name)
                cheat_sheet = prompt_result.messages[0].content.text
                print(f"[agent]   ← Got prompt ({len(cheat_sheet)} chars)")
            except Exception as e:
                print(f"[agent]   ! Prompt fetch failed ({e}), falling back to read_me...")
                cheat_sheet = await call_mcp_tool(session, "read_me", {})
                print(f"[agent]   ← Got cheat sheet ({len(cheat_sheet)} chars)")

            # Step 2: Read the notebook
            print(f"[agent] Step 2: Calling read_notebook({notebook_path})...")
            notebook_content = await call_mcp_tool(
                session, "read_notebook", {"path": notebook_path}
            )
            print(f"[agent] ← Got notebook content ({len(notebook_content)} chars)")

            # Step 3: Run in selected mode
            if mode == "fast":
                await run_agent_fast(
                    session, notebook_path, output_path, cheat_sheet, notebook_content
                )
            else:
                await run_agent_iterative(
                    session, notebook_path, output_path, cheat_sheet, notebook_content
                )

            print(f"\n[agent] ✓ Done! Diagram saved to: {output_path}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Generate Excalidraw diagram from a Jupyter notebook using MCP tools."
    )
    parser.add_argument("notebook", help="Path to the .ipynb file")
    parser.add_argument(
        "output",
        nargs="?",
        default=None,
        help="Output .excalidraw file path (default: <notebook_name>.excalidraw in same dir)",
    )
    parser.add_argument(
        "--mode",
        choices=["fast", "iterative"],
        default="iterative",
        help="Generation mode: 'fast' (single-shot) or 'iterative' (visual checkpoints, default)",
    )
    args = parser.parse_args()

    notebook_path = str(Path(args.notebook).resolve())
    if args.output:
        output_path = str(Path(args.output).resolve())
    else:
        nb = Path(notebook_path)
        output_path = str(nb.parent / (nb.stem + ".excalidraw"))

    if not Path(notebook_path).exists():
        print(f"Error: Notebook not found: {notebook_path}", file=sys.stderr)
        sys.exit(1)

    print(f"[agent] Notebook: {notebook_path}")
    print(f"[agent] Output:   {output_path}")
    print(f"[agent] Model:    {DEFAULT_MODEL}")
    print(f"[agent] Mode:     {args.mode}")

    asyncio.run(run_agent(notebook_path, output_path, args.mode))


if __name__ == "__main__":
    main()
