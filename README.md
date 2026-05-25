# JupyterDraw MCP

An MCP server designed to generate beautiful, hand-drawn Excalidraw diagrams from Jupyter notebooks. It reads a notebook, parses its structure, and creates pipeline diagrams that follow strict layout, color, and annotation conventions.

## Features

- **Jupyter Notebook Analysis**: Specialized tools to read `.ipynb` files and understand data science/ML pipelines.
- **Two Output Modes**:
  - **Live Interactive View (`create_view`)**: Renders the diagram LIVE in an interactive in-chat widget with draw-on animations and smooth viewport camera panning.
  - **Static File Export (`generate_diagram_file`)**: Produces a standard `.excalidraw` file directly to disk, without the live chat interface.
- **Strict Diagramming Rules**: 
  - **Lanes**: Pipeline stages (ARTIFACTS, PROCESSING, MODELLING, EVALUATION, REPORT).
  - **Colors**: Entity types (BLUE for data, GRAY for process, RED for model, GREEN for evaluation, WHITE for output).
  - **Annotations & Sketches**: Automatically includes hyper-parameters, data shapes, metrics, and inner sketches of visualizations (e.g., bar charts, histograms).

## Setup & Installation

**Prerequisites:** Node.js (v18+)

1. Clone the repository:
   ```bash
   git clone https://github.com/your-username/jupyter-draw-mcp.git
   cd jupyter-draw-mcp
   ```

2. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```

3. Add the server to your MCP client configuration (e.g., Claude Desktop `claude_desktop_config.json`):

   ```json
   {
     "mcpServers": {
       "jupyter-draw": {
         "command": "node",
         "args": ["/absolute/path/to/jupyter-draw-mcp/dist/index.js", "--stdio"]
       }
     }
   }
   ```

## Usage Examples

Ask your AI assistant:
- "Here is my notebook `model_training.ipynb`. Please create a diagram of the pipeline."
- "Read `analysis.ipynb` and generate an excalidraw file for it."
- "Show me a visual flow of how the data is processed in `preprocessing.ipynb`."

## How it works (for LLMs)

The AI assistant follows a strict workflow:
1. Calls `read_me` to ingest the mandatory Excalidraw formatting specs and Jupyter diagramming rules.
2. Calls `read_notebook` to parse the `.ipynb` file.
3. Analyzes the cells and maps them to entities (data, processes, models, outputs).
4. Calls `create_view` (for an animated in-chat experience) or `generate_diagram_file` (for a static file output) with the computed elements array.

## Credits

Built on top of [Excalidraw](https://github.com/excalidraw/excalidraw) and [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps).
