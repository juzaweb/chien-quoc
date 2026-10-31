"""Assemble directional walk strips into one Phaser spritesheet.

Input: ``<unit>_<DIR>_raw.png`` — one Canva strip per direction with four poses
laid out left to right on a flat white background.

Output: ``<unit>_walk.png`` — one row per direction, one column per walk frame,
so a Phaser spritesheet can index frame ``row * cols + col``.

Row order is compass-from-east, matching ``directionIndex()`` in the client:
E, SE, S, SW, W, NW, N, NE.

Background removal is local (no Canva matte call): the strips ship as opaque
white, so the matte is rebuilt here by flood-filling the border-connected
background. Doing it locally keeps the source pixels untouched, costs no quota,
and makes the whole 8-direction sheet reproducible from the raw files alone.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

DIRECTIONS = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"]
FRAMES_PER_DIRECTION = 4
MARGIN_BOTTOM = 4

# Matting. The renders bake a soft grey drop shadow that a pure white key leaves
# behind as a dirty smudge, so low-saturation grey brighter than SHADOW_LUMA_MIN
# also counts as background — but only where it connects to the image border, so
# white highlights inside the silhouette survive.
BG_VALUE = 254
FLAT_DELTA = 3
SAT_MAX = 18
SHADOW_LUMA_MIN = 120
FEATHER_RADIUS = 1.0


def _channel_max(image: Image.Image) -> Image.Image:
    r, g, b = image.split()
    return ImageChops.lighter(ImageChops.lighter(r, g), b)


def _channel_min(image: Image.Image) -> Image.Image:
    r, g, b = image.split()
    return ImageChops.darker(ImageChops.darker(r, g), b)


def _background_color(image: Image.Image) -> tuple[int, int, int]:
    width, height = image.size
    pixels = image.load()
    samples = [pixels[x, 0] for x in range(width)]
    samples += [pixels[x, height - 1] for x in range(width)]
    samples += [pixels[0, y] for y in range(height)]
    samples += [pixels[width - 1, y] for y in range(height)]
    return tuple(sorted(sample[i] for sample in samples)[len(samples) // 2] for i in range(3))


def _foreground_mask(image: Image.Image) -> Image.Image:
    background = Image.new("RGB", image.size, _background_color(image))
    delta = _channel_max(ImageChops.difference(image, background))
    saturation = ImageChops.subtract(_channel_max(image), _channel_min(image))
    luma = image.convert("L")

    flat = delta.point(lambda value: 255 if value <= FLAT_DELTA else 0)
    grey = ImageChops.multiply(
        saturation.point(lambda value: 255 if value <= SAT_MAX else 0),
        luma.point(lambda value: 255 if value >= SHADOW_LUMA_MIN else 0),
    )
    candidate = ImageChops.lighter(flat, grey)

    probe = candidate.point(lambda value: 128 if value else 0)
    width, height = image.size
    for seed in ((0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)):
        if probe.getpixel(seed) == 128:
            ImageDraw.floodfill(probe, seed, 255, thresh=0)
    return ImageChops.invert(probe.point(lambda value: 255 if value == 255 else 0))


def remove_background(image: Image.Image) -> Image.Image:
    """Return ``image`` with the flat background cut out and edge white unblended."""
    rgb = image.convert("RGB")
    mask = _foreground_mask(rgb)

    # Soften the cut by a pixel, but keep everything a few pixels inside fully
    # opaque so the body never turns translucent.
    soft = mask.filter(ImageFilter.GaussianBlur(FEATHER_RADIUS))
    core = mask.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(3))
    alpha = Image.composite(Image.new("L", rgb.size, 255), soft, core)

    # An edge pixel is alpha * color + (1 - alpha) * background. Left baked in,
    # that white shows up as a pale halo once the sprite sits on dark terrain.
    def unblend(band: Image.Image) -> Image.Image:
        source = band.load()
        alphas = alpha.load()
        out = Image.new("L", rgb.size)
        target = out.load()
        width, height = rgb.size
        for y in range(height):
            for x in range(width):
                a = alphas[x, y]
                v = source[x, y]
                if a == 0 or a == 255:
                    target[x, y] = v
                else:
                    f = a / 255
                    target[x, y] = max(0, min(255, round((v - (1 - f) * BG_VALUE) / f)))
        return out

    return Image.merge("RGBA", (*[unblend(band) for band in rgb.split()], alpha))


def content(frame: Image.Image) -> Image.Image:
    bbox = frame.getchannel("A").getbbox()
    if bbox is None:
        raise ValueError("empty frame after background removal")
    return frame.crop(bbox)


def split(image: Image.Image) -> list[Image.Image]:
    width = image.width // FRAMES_PER_DIRECTION
    return [
        image.crop((i * width, 0, (i + 1) * width, image.height))
        for i in range(FRAMES_PER_DIRECTION)
    ]


def load_direction(raw_dir: Path, unit: str, direction: str) -> list[Image.Image]:
    path = raw_dir / f"{unit}_{direction}_raw.png"
    if not path.exists():
        raise FileNotFoundError(f"missing strip for {direction}: {path}")
    return split(remove_background(Image.open(path)))


def compose(unit: str, frame_size: int, content_height: int) -> tuple[Path, dict]:
    root = Path(__file__).resolve().parent
    raw_dir = root / "raw_downloads" / "units_8dir"
    assets = root.parent / "apps" / "client" / "public" / "assets" / "units"
    out_path = assets / f"{unit}_walk.png"

    crops = {
        direction: [content(frame) for frame in load_direction(raw_dir, unit, direction)]
        for direction in DIRECTIONS
    }
    tallest = max(frame.height for frames in crops.values() for frame in frames)
    scale = content_height / tallest

    sheet = Image.new(
        "RGBA",
        (frame_size * FRAMES_PER_DIRECTION, frame_size * len(DIRECTIONS)),
        (0, 0, 0, 0),
    )
    stats = {}
    for row, direction in enumerate(DIRECTIONS):
        frames = crops[direction]
        # Anchor every row on its mean bbox centre instead of centring each frame:
        # per-frame centring cancels the in-place side-to-side sway of a walk and
        # makes the sprite slide.
        centre = sum((frame.width / 2) for frame in frames) / len(frames)
        for column, frame in enumerate(frames):
            size = (max(1, round(frame.width * scale)), max(1, round(frame.height * scale)))
            scaled = frame.convert("RGBa").resize(size, Image.Resampling.LANCZOS).convert("RGBA")
            x = round(column * frame_size + frame_size / 2 - centre * scale)
            y = row * frame_size + frame_size - scaled.height - MARGIN_BOTTOM
            sheet.alpha_composite(scaled, (x, y))
        stats[direction] = [(frame.width, frame.height) for frame in frames]

    sheet.save(out_path)
    return out_path, {"scale": scale, "sizes": stats}


def main(unit: str, frame_size: int, content_height: int) -> None:
    out_path, info = compose(unit, frame_size, content_height)
    sheet = Image.open(out_path)
    print(
        f"{out_path.name}: {sheet.size[0]}x{sheet.size[1]} "
        f"{out_path.stat().st_size // 1024} KB scale={info['scale']:.3f} "
        f"alpha={sheet.getchannel('A').getextrema()}"
    )
    for direction, sizes in info["sizes"].items():
        widths = [size[0] for size in sizes]
        heights = [size[1] for size in sizes]
        print(
            f"  {direction}: w={widths} (spread {max(widths) - min(widths)}px) "
            f"h={heights} (spread {max(heights) - min(heights)}px)"
        )


if __name__ == "__main__":
    unit_name = sys.argv[1]
    size = int(sys.argv[2]) if len(sys.argv) > 2 else 128
    height = int(sys.argv[3]) if len(sys.argv) > 3 else 112
    main(unit_name, size, height)
