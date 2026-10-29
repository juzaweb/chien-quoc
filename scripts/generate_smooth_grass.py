"""Generate authentic Age of Empires 2 velvety smooth grass tiles directly matching user reference."""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter
import random

ROOT = Path(__file__).resolve().parent.parent
CLIENT_PUBLIC = ROOT / "apps" / "client" / "public"
TERRAIN_DIR = CLIENT_PUBLIC / "assets" / "terrain"
USER_REF = Path("/Users/theanh/.gemini/antigravity/brain/cd031cf9-d0a6-4d3e-9bbf-00ca9562c691/.user_uploaded/media_1793287994244_98ca6077.png")

def create_smooth_aoe_grass():
    TERRAIN_DIR.mkdir(parents=True, exist_ok=True)
    ref_img = Image.open(USER_REF).convert("RGBA")
    
    # Crop pure lush grass area from reference (x: 10..90, y: 5..75)
    grass_sample = ref_img.crop((12, 6, 92, 70))
    sw, sh = grass_sample.size

    # Synthesize a large 512x512 seamless meadow canvas
    canvas_w, canvas_h = 512, 512
    meadow = Image.new("RGBA", (canvas_w, canvas_h))
    
    # 1. Base tile
    for y in range(0, canvas_h, sh):
        for x in range(0, canvas_w, sw):
            meadow.paste(grass_sample, (x, y))

    # 2. Random Poisson-like feathered stamps to eliminate tiling seams
    random.seed(1337)
    for _ in range(120):
        patch_size = random.randint(32, 48)
        mask = Image.new("L", (patch_size, patch_size), 0)
        draw = ImageDraw.Draw(mask)
        draw.ellipse((4, 4, patch_size - 4, patch_size - 4), fill=255)
        mask = mask.filter(ImageFilter.GaussianBlur(radius=5))

        rx = random.randint(0, sw - patch_size)
        ry = random.randint(0, sh - patch_size)
        patch = grass_sample.crop((rx, ry, rx + patch_size, ry + patch_size))

        dx = random.randint(0, canvas_w - patch_size)
        dy = random.randint(0, canvas_h - patch_size)
        meadow.paste(patch, (dx, dy), mask)

    # 3. Create precise 128x64 isometric diamond mask with 1px bleed to prevent subpixel black seam bleed
    tile_w, tile_h = 128, 64
    hw, hh = tile_w / 2.0, tile_h / 2.0

    mask = Image.new("L", (tile_w, tile_h), 0)
    mask_pixels = mask.load()
    for y in range(tile_h):
        for x in range(tile_w):
            # True 2:1 isometric diamond equation: |x - 64|/64 + |y - 32|/32 <= 1.0
            # Slight 1.015 margin covers exact adjacent pixels seamlessly without gaps
            dist = abs(x + 0.5 - hw) / hw + abs(y + 0.5 - hh) / hh
            if dist <= 1.015:
                mask_pixels[x, y] = 255
            elif dist <= 1.04:
                # 1px soft anti-aliased edge
                alpha = int(255 * (1.04 - dist) / 0.025)
                mask_pixels[x, y] = max(0, min(255, alpha))

    # Extract 3 unique organic variations
    crops = [
        (40, 40),
        (180, 100),
        (300, 220),
    ]

    for idx, (cx, cy) in enumerate(crops, 1):
        tile_raw = meadow.crop((cx, cy, cx + tile_w, cy + tile_h))
        tile = Image.new("RGBA", (tile_w, tile_h), (0, 0, 0, 0))
        tile.paste(tile_raw, (0, 0))
        # Zero border lines! Pure smooth velvety grass
        tile.putalpha(mask)

        out_path = TERRAIN_DIR / f"grass_{idx}.png"
        tile.save(out_path, "PNG", optimize=True)
        print(f"Generated smooth AoE grass tile: {out_path.name} ({tile_w}x{tile_h})")

    # Save default grass.png
    default_tile = TERRAIN_DIR / "grass_1.png"
    target_default = TERRAIN_DIR / "grass.png"
    with Image.open(default_tile) as d_img:
        d_img.save(target_default, "PNG", optimize=True)
        print(f"Generated default grass tile: {target_default.name}")

if __name__ == "__main__":
    create_smooth_aoe_grass()

