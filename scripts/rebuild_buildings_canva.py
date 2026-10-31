"""Rebuild the five original building sprites from Canva-matting sources.

Inputs are the background-free 1:1 renders in ``scripts/raw_downloads``
(``m_<name>_mat.png``). Each one is cropped to its alpha bounds, scaled to the
game's target sheet, and anchored bottom-centre so the base of the artwork
lands on the bottom row of the sheet -- the same convention every building
sprite in ``apps/client/public/assets/buildings`` already follows.

Resampling happens in premultiplied alpha (PIL mode ``RGBa``) so transparent
pixels cannot bleed a dark halo into the edges of the silhouette.
"""

import argparse
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "scripts" / "raw_downloads"
OUT_DIR = ROOT / "apps" / "client" / "public" / "assets" / "buildings"

# name -> (width, height) of the shipped sheet. These are the sizes the client
# offsets in apps/client/src/game/render/buildingArt.ts already assume.
TARGETS = {
    "town_center": (576, 440),
    "barracks": (400, 320),
    "farm": (384, 192),
    "tower": (160, 360),
    "house": (256, 220),
}


def rebuild(name: str, size: tuple[int, int]) -> Image.Image:
    source = Image.open(RAW_DIR / f"m_{name}_mat.png").convert("RGBA")
    box = source.getchannel("A").getbbox()
    if box is None:
        raise ValueError(f"{name}: source is fully transparent")
    art = source.crop(box)

    width, height = size
    scale = min(width / art.width, height / art.height)
    scaled = art.convert("RGBa").resize(
        (max(1, round(art.width * scale)), max(1, round(art.height * scale))),
        Image.Resampling.LANCZOS,
    ).convert("RGBA")

    sheet = Image.new("RGBA", size, (0, 0, 0, 0))
    sheet.paste(
        scaled,
        ((width - scaled.width) // 2, height - scaled.height),
        scaled,
    )
    return sheet


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="measure without writing")
    args = parser.parse_args()

    for name, size in TARGETS.items():
        sheet = rebuild(name, size)
        alpha = sheet.getchannel("A")
        transparent = alpha.histogram()[0]
        total = size[0] * size[1]
        corners = [alpha.getpixel(p) for p in ((0, 0), (size[0] - 1, 0), (0, size[1] - 1), (size[0] - 1, size[1] - 1))]
        print(
            f"{name:12s} {size[0]}x{size[1]} mode={sheet.mode} bbox={alpha.getbbox()} "
            f"transparent={transparent * 100 / total:.1f}% alpha_extrema={alpha.getextrema()} corners={corners}"
        )
        if not args.dry_run:
            destination = OUT_DIR / f"{name}.png"
            sheet.save(destination, optimize=True)
            print(f"  wrote {destination.relative_to(ROOT)} {destination.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
