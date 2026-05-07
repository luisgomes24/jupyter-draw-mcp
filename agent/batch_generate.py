"""
Batch runner: generates Excalidraw diagrams for every Jupyter notebook in a directory.

Usage:
    python batch_generate.py [directory] [--output-dir DIR]

Defaults:
    directory  → ../data  (relative to this script)
    output-dir → same directory as the input notebooks
"""

import argparse
import subprocess
import sys
from pathlib import Path

AGENT_SCRIPT = Path(__file__).resolve().parent / "agent.py"


def find_notebooks(directory: Path) -> list[Path]:
    """Recursively find all .ipynb files in a directory."""
    notebooks = sorted(directory.rglob("*.ipynb"))
    # Filter out checkpoint files
    return [nb for nb in notebooks if ".ipynb_checkpoints" not in str(nb)]


def main():
    parser = argparse.ArgumentParser(
        description="Batch-generate Excalidraw diagrams for all notebooks in a directory."
    )
    parser.add_argument(
        "directory",
        nargs="?",
        default=str(Path(__file__).resolve().parent.parent / "data"),
        help="Directory containing .ipynb files (default: ../data)",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Directory for output .excalidraw files (default: same as input notebooks)",
    )
    args = parser.parse_args()

    input_dir = Path(args.directory).resolve()
    output_dir = Path(args.output_dir).resolve() if args.output_dir else None

    if not input_dir.is_dir():
        print(f"Error: Not a directory: {input_dir}", file=sys.stderr)
        sys.exit(1)

    notebooks = find_notebooks(input_dir)
    if not notebooks:
        print(f"No .ipynb files found in {input_dir}")
        sys.exit(0)

    print(f"Found {len(notebooks)} notebook(s) in {input_dir}:\n")
    for nb in notebooks:
        print(f"  - {nb.name}")
    print()

    results = {"success": [], "failed": []}

    for i, nb_path in enumerate(notebooks, 1):
        if output_dir:
            out_path = output_dir / (nb_path.stem + ".excalidraw")
        else:
            out_path = nb_path.parent / (nb_path.stem + ".excalidraw")

        print(f"\n{'='*60}")
        print(f"[{i}/{len(notebooks)}] Processing: {nb_path.name}")
        print(f"  Output: {out_path}")
        print(f"{'='*60}")

        try:
            result = subprocess.run(
                [sys.executable, str(AGENT_SCRIPT), str(nb_path), str(out_path)],
                check=True,
                timeout=300,  # 5 minute timeout per notebook
            )
            if out_path.exists():
                results["success"].append(nb_path.name)
                print(f"\n✓ Success: {nb_path.name} → {out_path.name}")
            else:
                results["failed"].append((nb_path.name, "Output file not created"))
                print(f"\n✗ Failed: {nb_path.name} — output file was not created")
        except subprocess.TimeoutExpired:
            results["failed"].append((nb_path.name, "Timed out (5 min)"))
            print(f"\n✗ Failed: {nb_path.name} — timed out after 5 minutes")
        except subprocess.CalledProcessError as e:
            results["failed"].append((nb_path.name, f"Exit code {e.returncode}"))
            print(f"\n✗ Failed: {nb_path.name} — exit code {e.returncode}")

    # Summary
    print(f"\n{'='*60}")
    print(f"SUMMARY")
    print(f"{'='*60}")
    print(f"  Total:     {len(notebooks)}")
    print(f"  Succeeded: {len(results['success'])}")
    print(f"  Failed:    {len(results['failed'])}")

    if results["failed"]:
        print(f"\nFailed notebooks:")
        for name, reason in results["failed"]:
            print(f"  - {name}: {reason}")

    sys.exit(0 if not results["failed"] else 1)


if __name__ == "__main__":
    main()
