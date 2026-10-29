"""Script to generate authentic Age of Empires 2 Grass Terrain tiles and HUD Resource Icons using Local ComfyUI API."""

import json
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
CLIENT_PUBLIC = ROOT / "apps" / "client" / "public"
TERRAIN_DIR = CLIENT_PUBLIC / "assets" / "terrain"
ICONS_DIR = CLIENT_PUBLIC / "assets" / "icons"

API_HOST = "http://192.168.1.14:8090"


def get_api_key() -> str:
    env_file = ROOT / ".env"
    if env_file.exists():
        with open(env_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("LOCAL_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    api_key = os.environ.get("LOCAL_API_KEY")
    if api_key:
        return api_key
    raise ValueError("LOCAL_API_KEY not found in .env or environment")


API_KEY = get_api_key()


def api_request(path: str, data: dict = None) -> dict:
    url = f"{API_HOST}{path}"
    headers = {"X-API-Key": API_KEY}
    body = None
    if data is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(data).encode("utf-8")

    req = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))


def wait_for_job(job_id: str, label: str) -> dict:
    start = time.time()
    while True:
        job = api_request(f"/v1/jobs/{job_id}")
        status = job.get("status")
        progress = job.get("progress", 0.0)
        elapsed = time.time() - start
        print(f"  [{label}] status: {status}, progress: {progress}%, elapsed: {elapsed:.1f}s", flush=True)

        if status == "succeeded":
            return job
        elif status in ("failed", "canceled"):
            raise RuntimeError(f"Job {job_id} {status}: {job.get('error')}")
        time.sleep(2)


def download_file(url: str, dest_path: Path):
    parsed = urllib.parse.urlparse(url)
    direct_url = f"{API_HOST}{parsed.path}"
    req = urllib.request.Request(direct_url, headers={"X-API-Key": API_KEY})
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(req) as r, open(dest_path, "wb") as f:
        f.write(r.read())
    print(f"  Downloaded: {dest_path}")


def create_isometric_mask(w: int, h: int) -> Image.Image:
    """Create an anti-aliased isometric diamond mask for w x h tile."""
    # Render at 4x for smooth anti-aliased edge
    scale = 4
    sw, sh = w * scale, h * scale
    mask = Image.new("L", (sw, sh), 0)
    draw = ImageDraw.Draw(mask)
    # Diamond corners
    points = [
        (sw // 2, 0),
        (sw - 1, sh // 2),
        (sw // 2, sh - 1),
        (0, sh // 2),
    ]
    draw.polygon(points, fill=255)
    return mask.resize((w, h), Image.Resampling.LANCZOS)


def process_grass_tiles(raw_path: Path):
    """Slice texture into 3 isometric grass tile variations of 128x64."""
    TERRAIN_DIR.mkdir(parents=True, exist_ok=True)
    with Image.open(raw_path) as im:
        im = im.convert("RGBA")
        tile_w, tile_h = 128, 64
        mask = create_isometric_mask(tile_w, tile_h)

        # We will extract 3 distinct patches from the 1024x512 master texture
        patches = [
            (64, 64, 64 + tile_w * 2, 64 + tile_h * 2),
            (384, 128, 384 + tile_w * 2, 128 + tile_h * 2),
            (700, 64, 700 + tile_w * 2, 64 + tile_h * 2),
        ]

        for idx, (x1, y1, x2, y2) in enumerate(patches, 1):
            patch = im.crop((x1, y1, x2, y2)).resize((tile_w, tile_h), Image.Resampling.LANCZOS)
            tile = Image.new("RGBA", (tile_w, tile_h), (0, 0, 0, 0))
            tile.paste(patch, (0, 0))

            # Apply subtle grid boundary (faint natural highlight on top edges, faint shadow on bottom)
            draw = ImageDraw.Draw(tile)
            hw = tile_w // 2
            hh = tile_h // 2
            # Subtle top-edge light border
            draw.line([(hw, 0), (tile_w - 1, hh)], fill=(200, 240, 180, 50), width=1)
            draw.line([(0, hh), (hw, 0)], fill=(200, 240, 180, 50), width=1)
            # Subtle bottom-edge shade border
            draw.line([(tile_w - 1, hh), (hw, tile_h - 1)], fill=(20, 60, 20, 60), width=1)
            draw.line([(hw, tile_h - 1), (0, hh)], fill=(20, 60, 20, 60), width=1)

            # Apply isometric diamond alpha mask
            tile.putalpha(mask)

            out_path = TERRAIN_DIR / f"grass_{idx}.png"
            tile.save(out_path, "PNG", optimize=True)
            print(f"  Saved terrain tile: {out_path} ({tile_w}x{tile_h})")

        # Also save default grass_0.png as standard tile
        default_tile = TERRAIN_DIR / "grass_1.png"
        target_default = TERRAIN_DIR / "grass.png"
        with Image.open(default_tile) as d_img:
            d_img.save(target_default, "PNG", optimize=True)
            print(f"  Saved default grass: {target_default}")


def process_icons_sheet(raw_path: Path):
    """Slice 5-panel image into 5 distinct UI icons (wood, food, gold, stone, population)."""
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    icon_names = ["wood", "food", "gold", "stone", "population"]
    with Image.open(raw_path) as source:
        source_rgba = source.convert("RGBA")
        src_w, src_h = source_rgba.size
        panel_count = 5
        panel_w = src_w // panel_count
        icon_size = 64

        for i, name in enumerate(icon_names):
            box = (i * panel_w, 0, (i + 1) * panel_w, src_h)
            panel = source_rgba.crop(box)
            bbox = panel.getbbox()
            if bbox:
                crop = panel.crop(bbox)
            else:
                crop = panel

            max_dim = int(icon_size * 0.90)
            scale = min(max_dim / max(1, crop.width), max_dim / max(1, crop.height))
            nw = max(1, int(crop.width * scale))
            nh = max(1, int(crop.height * scale))
            scaled = crop.resize((nw, nh), Image.Resampling.LANCZOS)

            canvas = Image.new("RGBA", (icon_size, icon_size), (0, 0, 0, 0))
            ox = (icon_size - nw) // 2
            oy = (icon_size - nh) // 2
            canvas.paste(scaled, (ox, oy), scaled)

            out_file = ICONS_DIR / f"{name}.png"
            canvas.save(out_file, "PNG", optimize=True)
            print(f"  Saved icon {name}: {out_file} ({icon_size}x{icon_size})")


def main():
    raw_dir = ROOT / "scripts" / "raw_downloads"
    raw_dir.mkdir(parents=True, exist_ok=True)

    # ==========================================
    # 1. GENERATE AGE OF EMPIRES 2 GRASS TERRAIN
    # ==========================================
    print("\n==========================================")
    print("[1/2] Generating Age of Empires 2 Grass Terrain")
    print("==========================================")
    grass_prompt = (
        "A 2D game asset of seamless Age of Empires 2 style lush green grass meadow terrain texture, top-down 2.5D isometric view. "
        "High detail organic grass blades, rich earthy emerald greens, moss and subtle wild clover, soft sunlight, "
        "historical RTS strategy game ground surface texture. Seamless natural texture, clean game asset ready --ar 2:1 --v 6.0 --style raw"
    )
    grass_resp = api_request("/v1/images", {
        "prompt": grass_prompt,
        "width": 1024,
        "height": 512,
        "steps": 8
    })
    grass_job_id = grass_resp["job_id"]
    print(f"Submitted grass job: {grass_job_id}")
    grass_job = wait_for_job(grass_job_id, "grass-img")
    grass_url = grass_job["files"][0]["url"]
    raw_grass_path = raw_dir / "grass_raw1024.png"
    download_file(grass_url, raw_grass_path)
    process_grass_tiles(raw_grass_path)

    # ==========================================
    # 2. GENERATE AGE OF EMPIRES 2 HUD RESOURCE ICONS
    # ==========================================
    print("\n==========================================")
    print("[2/2] Generating Age of Empires 2 HUD Resource Icons")
    print("==========================================")
    icons_prompt = (
        "A 2D game UI icon set of 5 classic medieval RTS strategy resource icons in a single horizontal row from left to right: "
        "Item 1: neat stack of round chopped wooden logs; "
        "Item 2: golden sheaf of ripe wheat bushels tied with ribbon; "
        "Item 3: gleaming pile of shiny gold coins and gold bullion ingots; "
        "Item 4: hewn granite gray masonry stone blocks; "
        "Item 5: antique bronze crested warrior helmet representing population. "
        "Solid pure white background, polished 3D game UI icon render, Age of Empires style, crisp silhouette --ar 4:1 --v 6.0 --style raw"
    )
    icons_resp = api_request("/v1/images", {
        "prompt": icons_prompt,
        "width": 1024,
        "height": 256,
        "steps": 8
    })
    icons_job_id = icons_resp["job_id"]
    print(f"Submitted icons job: {icons_job_id}")
    wait_for_job(icons_job_id, "icons-img")

    sprite_resp = api_request("/v1/sprites", {
        "from_job": icons_job_id,
        "background": "color",
        "key_color": "#ffffff",
        "tolerance": 28,
        "trim": False
    })
    sprite_job_id = sprite_resp["job_id"]
    print(f"Submitted sprite cutout job: {sprite_job_id}")
    cutout_job = wait_for_job(sprite_job_id, "icons-cutout")

    target_file = None
    for f in cutout_job.get("files", []):
        if f.get("filename") in ("spritesheet.png", "frame_000.png"):
            target_file = f
            break
    if not target_file and cutout_job.get("files"):
        target_file = cutout_job["files"][0]

    raw_icons_path = raw_dir / "icons_cutout_raw.png"
    download_file(target_file["url"], raw_icons_path)
    process_icons_sheet(raw_icons_path)

    print("\nAll grass terrain tiles and HUD resource icons generated successfully!")


if __name__ == "__main__":
    main()

