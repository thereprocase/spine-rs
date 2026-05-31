"""Generate Spine app icons from logo 02 (Three spines on a shelf).

Spec lifted verbatim from
internal design notes (spine-logos.jsx, L02ThreeSpines).
The logo is an 18x18 pixel grid. We scale via nearest-neighbor for crisp edges.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

GRID = 18
OUT = Path(__file__).resolve().parent.parent / "assets" / "images"
OUT.mkdir(parents=True, exist_ok=True)


def hex_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def draw_logo(img: Image.Image, *, bg: tuple[int, int, int] | tuple[int, int, int, int]) -> None:
    """Draw the 18x18 logo into the provided square image, centered."""
    w, h = img.size
    assert w == h, "icon must be square"
    scale = w // GRID
    pad = (w - scale * GRID) // 2
    d = ImageDraw.Draw(img)
    if len(bg) == 4 and bg[3] == 0:  # transparent
        pass
    else:
        d.rectangle([0, 0, w, h], fill=bg[:3])

    def rect(x: int, y: int, dx: int, dy: int, color: str) -> None:
        x0 = pad + x * scale
        y0 = pad + y * scale
        x1 = pad + (x + dx) * scale
        y1 = pad + (y + dy) * scale
        d.rectangle([x0, y0, x1 - 1, y1 - 1], fill=hex_rgb(color))

    # Baseline rule
    rect(2, 14, 14, 1, "#3a2a20")
    rect(2, 15, 14, 1, "#1A0F12")
    # Book 1 — oxblood (height 8, x=3)
    rect(3, 6, 3, 8, "#6B1E2B")
    rect(3, 7, 3, 1, "#8B2A3A")
    rect(3, 11, 3, 1, "#A8802D")
    # Book 2 — slate, tallest (height 10, x=7)
    rect(7, 4, 3, 10, "#34343b")
    rect(7, 5, 3, 1, "#E4B84F")
    rect(7, 9, 3, 1, "#E4B84F")
    rect(7, 12, 3, 1, "#c8a15a")
    # Book 3 — slate-green (height 7, x=11)
    rect(11, 7, 3, 7, "#6b857b")
    rect(11, 8, 3, 1, "#a8c4bc")
    rect(11, 11, 3, 1, "#A8802D")


def build() -> None:
    # icon.png — 1024 dark background
    icon = Image.new("RGB", (1024, 1024), hex_rgb("#17171a"))
    draw_logo(icon, bg=hex_rgb("#17171a"))
    icon.save(OUT / "icon.png", "PNG")

    # adaptive foreground — 1024 transparent
    fg = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    draw_logo(fg, bg=(0, 0, 0, 0))
    fg.save(OUT / "android-icon-foreground.png", "PNG")

    # adaptive background — solid dark
    bg = Image.new("RGB", (1024, 1024), hex_rgb("#17171a"))
    bg.save(OUT / "android-icon-background.png", "PNG")

    # monochrome — logo silhouette in white on transparent
    mono = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    md = ImageDraw.Draw(mono)
    scale = 1024 // GRID
    pad = (1024 - scale * GRID) // 2

    def rect_mono(x: int, y: int, dx: int, dy: int) -> None:
        x0 = pad + x * scale
        y0 = pad + y * scale
        x1 = pad + (x + dx) * scale
        y1 = pad + (y + dy) * scale
        md.rectangle([x0, y0, x1 - 1, y1 - 1], fill=(255, 255, 255, 255))

    # Books only (skip baseline ground line for monochrome silhouette)
    rect_mono(3, 6, 3, 8)
    rect_mono(7, 4, 3, 10)
    rect_mono(11, 7, 3, 7)
    mono.save(OUT / "android-icon-monochrome.png", "PNG")

    # splash — 512 with logo centered, larger so it reads at 200px imageWidth
    splash = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    sd = ImageDraw.Draw(splash)
    scale = 1024 // GRID
    pad = (1024 - scale * GRID) // 2
    # Just the books, no baseline, so the splash plate stays clean.
    palette = [
        ((3, 6, 3, 8), "#6B1E2B", [(3, 7, 3, 1, "#8B2A3A"), (3, 11, 3, 1, "#A8802D")]),
        ((7, 4, 3, 10), "#34343b", [(7, 5, 3, 1, "#E4B84F"), (7, 9, 3, 1, "#E4B84F"), (7, 12, 3, 1, "#c8a15a")]),
        ((11, 7, 3, 7), "#6b857b", [(11, 8, 3, 1, "#a8c4bc"), (11, 11, 3, 1, "#A8802D")]),
    ]
    for body, color, bands in palette:
        x, y, dx, dy = body
        sd.rectangle(
            [pad + x * scale, pad + y * scale, pad + (x + dx) * scale - 1, pad + (y + dy) * scale - 1],
            fill=hex_rgb(color),
        )
        for bx, by, bdx, bdy, bcolor in bands:
            sd.rectangle(
                [
                    pad + bx * scale,
                    pad + by * scale,
                    pad + (bx + bdx) * scale - 1,
                    pad + (by + bdy) * scale - 1,
                ],
                fill=hex_rgb(bcolor),
            )
    splash.save(OUT / "splash-icon.png", "PNG")

    # favicon — 64
    fav = icon.resize((64, 64), Image.Resampling.NEAREST)
    fav.save(OUT / "favicon.png", "PNG")

    print(f"wrote icons to {OUT}")


if __name__ == "__main__":
    build()
