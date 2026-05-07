"""
Renders a simplified visual preview of Excalidraw elements using Pillow,
and detects overlapping bounding boxes.

Used by the iterative agent to provide visual feedback to the LLM.
"""

import base64
import io
import math
from typing import Any

from PIL import Image, ImageDraw, ImageFont


# Hex color name mapping for common Excalidraw fills
_HEX_TO_RGB: dict[str, tuple[int, int, int]] = {}


def _hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    """Convert hex color string to RGB tuple."""
    if hex_color in _HEX_TO_RGB:
        return _HEX_TO_RGB[hex_color]
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) != 6:
        return (200, 200, 200)  # fallback gray
    try:
        rgb = (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except ValueError:
        rgb = (200, 200, 200)
    _HEX_TO_RGB[hex_color] = rgb
    return rgb


def _get_label(el: dict) -> str:
    """Extract text label from an element."""
    label = el.get("label")
    if isinstance(label, dict):
        return label.get("text", "")
    if el.get("type") == "text":
        return el.get("text", "")
    return ""


def _is_drawable(el: dict) -> bool:
    """Check if element should be rendered (not a pseudo-element)."""
    return el.get("type") not in ("cameraUpdate", "delete", "restoreCheckpoint")


def _get_shapes(elements: list[dict]) -> list[dict]:
    """Filter to drawable shape elements (not arrows/text)."""
    return [
        el for el in elements
        if _is_drawable(el) and el.get("type") in ("rectangle", "ellipse", "diamond")
    ]


def _get_arrows(elements: list[dict]) -> list[dict]:
    """Filter to arrow elements."""
    return [el for el in elements if el.get("type") == "arrow"]


def _get_texts(elements: list[dict]) -> list[dict]:
    """Filter to standalone text elements."""
    return [
        el for el in elements
        if el.get("type") == "text" and not el.get("containerId")
    ]


def _bbox(el: dict) -> tuple[float, float, float, float]:
    """Get bounding box (x1, y1, x2, y2) of an element."""
    x = el.get("x", 0)
    y = el.get("y", 0)
    w = el.get("width", 0)
    h = el.get("height", 0)
    return (x, y, x + w, y + h)


def _bboxes_overlap(a: tuple, b: tuple, margin: float = 5) -> bool:
    """Check if two bounding boxes overlap (with optional margin)."""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    return not (
        ax2 + margin <= bx1
        or bx2 + margin <= ax1
        or ay2 + margin <= by1
        or by2 + margin <= ay1
    )


def detect_overlaps(elements: list[dict]) -> str:
    """
    Detect overlapping elements and return a minimal text report.

    Returns empty string if no overlaps.
    """
    shapes = _get_shapes(elements)
    overlaps: list[str] = []

    for i in range(len(shapes)):
        for j in range(i + 1, len(shapes)):
            a, b = shapes[i], shapes[j]
            ba, bb = _bbox(a), _bbox(b)
            if _bboxes_overlap(ba, bb):
                la = _get_label(a) or a.get("id", "?")
                lb = _get_label(b) or b.get("id", "?")
                overlaps.append(f'"{la}" and "{lb}"')

    if not overlaps:
        return ""

    return f"⚠ {len(overlaps)} overlap(s): " + "; ".join(overlaps[:5])


def render_elements_preview(
    elements: list[dict],
    img_width: int = 800,
    img_height: int = 600,
) -> bytes:
    """
    Render a simplified visual preview of Excalidraw elements as PNG bytes.

    This is NOT a full Excalidraw render — it draws colored rectangles with
    labels and arrows as lines, giving the LLM enough spatial context to
    understand the layout and detect issues.
    """
    drawable = [el for el in elements if _is_drawable(el)]
    if not drawable:
        # Return a blank image
        img = Image.new("RGB", (img_width, img_height), "white")
        return _img_to_bytes(img)

    # Compute scene bounding box
    all_points: list[tuple[float, float]] = []
    for el in drawable:
        x, y = el.get("x", 0), el.get("y", 0)
        w, h = el.get("width", 0), el.get("height", 0)
        all_points.append((x, y))
        all_points.append((x + w, y + h))
        # Include arrow endpoints
        if el.get("type") == "arrow" and el.get("points"):
            for pt in el["points"]:
                all_points.append((x + pt[0], y + pt[1]))

    min_x = min(p[0] for p in all_points)
    min_y = min(p[1] for p in all_points)
    max_x = max(p[0] for p in all_points)
    max_y = max(p[1] for p in all_points)

    scene_w = max(max_x - min_x, 1)
    scene_h = max(max_y - min_y, 1)

    # Scale with padding
    pad = 30
    scale_x = (img_width - 2 * pad) / scene_w
    scale_y = (img_height - 2 * pad) / scene_h
    scale = min(scale_x, scale_y)

    def tx(sx: float) -> float:
        return (sx - min_x) * scale + pad

    def ty(sy: float) -> float:
        return (sy - min_y) * scale + pad

    img = Image.new("RGB", (img_width, img_height), "white")
    draw = ImageDraw.Draw(img)

    # Try to load a readable font; fall back to default
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 12)
        font_small = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 10)
    except Exception:
        try:
            font = ImageFont.truetype("arial.ttf", 12)
            font_small = ImageFont.truetype("arial.ttf", 10)
        except Exception:
            font = ImageFont.load_default()
            font_small = font

    # --- Draw shapes ---
    for el in _get_shapes(drawable):
        x1, y1 = tx(el["x"]), ty(el["y"])
        x2 = x1 + el.get("width", 100) * scale
        y2 = y1 + el.get("height", 60) * scale

        bg = el.get("backgroundColor", "transparent")
        fill_rgb = _hex_to_rgb(bg) if bg and bg != "transparent" else (240, 240, 240)
        stroke_rgb = _hex_to_rgb(el.get("strokeColor", "#333333"))

        if el.get("type") == "ellipse":
            draw.ellipse([x1, y1, x2, y2], fill=fill_rgb, outline=stroke_rgb, width=2)
        else:
            draw.rectangle([x1, y1, x2, y2], fill=fill_rgb, outline=stroke_rgb, width=2)

        # Label
        label = _get_label(el)
        if label:
            cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
            # Truncate long labels
            if len(label) > 25:
                label = label[:22] + "..."
            draw.text((cx, cy), label, fill=(30, 30, 30), font=font, anchor="mm")

    # --- Draw arrows ---
    for el in _get_arrows(drawable):
        pts = el.get("points", [[0, 0]])
        ox, oy = el.get("x", 0), el.get("y", 0)
        stroke_rgb = _hex_to_rgb(el.get("strokeColor", "#333333"))

        screen_pts = [(tx(ox + p[0]), ty(oy + p[1])) for p in pts]
        if len(screen_pts) >= 2:
            draw.line(screen_pts, fill=stroke_rgb, width=2)
            # Simple arrowhead
            if el.get("endArrowhead"):
                _draw_arrowhead(draw, screen_pts[-2], screen_pts[-1], stroke_rgb)

        # Arrow label
        label = _get_label(el)
        if label and len(screen_pts) >= 2:
            mid_idx = len(screen_pts) // 2
            mx = (screen_pts[mid_idx - 1][0] + screen_pts[mid_idx][0]) / 2
            my = (screen_pts[mid_idx - 1][1] + screen_pts[mid_idx][1]) / 2
            draw.text((mx, my - 8), label[:20], fill=(80, 80, 80), font=font_small, anchor="mm")

    # --- Draw standalone text ---
    for el in _get_texts(drawable):
        sx, sy = tx(el["x"]), ty(el["y"])
        text = el.get("text", "")
        if text:
            color = _hex_to_rgb(el.get("strokeColor", "#1e1e1e"))
            draw.text((sx, sy), text[:40], fill=color, font=font)

    return _img_to_bytes(img)


def _draw_arrowhead(
    draw: ImageDraw.ImageDraw,
    from_pt: tuple[float, float],
    to_pt: tuple[float, float],
    color: tuple[int, int, int],
    size: float = 10,
) -> None:
    """Draw a simple arrowhead at the end of a line."""
    dx = to_pt[0] - from_pt[0]
    dy = to_pt[1] - from_pt[1]
    length = math.sqrt(dx * dx + dy * dy)
    if length < 1:
        return
    dx, dy = dx / length, dy / length
    # Perpendicular
    px, py = -dy, dx
    base_x = to_pt[0] - dx * size
    base_y = to_pt[1] - dy * size
    points = [
        to_pt,
        (base_x + px * size * 0.4, base_y + py * size * 0.4),
        (base_x - px * size * 0.4, base_y - py * size * 0.4),
    ]
    draw.polygon(points, fill=color)


def _img_to_bytes(img: Image.Image) -> bytes:
    """Convert PIL Image to PNG bytes."""
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def render_to_base64(elements: list[dict]) -> str:
    """Render elements preview and return as base64-encoded PNG string."""
    png_bytes = render_elements_preview(elements)
    return base64.b64encode(png_bytes).decode("ascii")
