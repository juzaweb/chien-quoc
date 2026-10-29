"""Script to generate building assets for Chien Quoc RTS using Local ComfyUI API."""

import json
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
CLIENT_PUBLIC = ROOT / "apps" / "client" / "public"
OUTPUT_DIR = CLIENT_PUBLIC / "assets" / "buildings"

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

BUILDING_SPECS = [
    {
        "id": "town_center",
        "target_w": 288,
        "target_h": 220,
        "gen_w": 1024,
        "gen_h": 1024,
        "prompt": (
            "A 2D game asset of an ancient East Asian imperial town center palace hall, 2.5D isometric top-down view. "
            "Magnificent wooden pavilion with curved red clay tiled roofs, carved pillars, banners, stone foundation dais, "
            "historical Warring States imperial architecture, detailed RTS building asset. "
            "Solid pure white background, clean sharp silhouette, game asset ready --ar 1:1 --v 6.0 --style raw"
        ),
    },
    {
        "id": "barracks",
        "target_w": 200,
        "target_h": 160,
        "gen_w": 1024,
        "gen_h": 1024,
        "prompt": (
            "A 2D game asset of an ancient East Asian military barracks garrison outpost, 2.5D isometric top-down view. "
            "Fortified timber and stone military lodge, weapon racks with spears and shields outside, banners and war drums, "
            "training yard. Warring States era martial building asset. "
            "Solid pure white background, clean sharp silhouette, game asset ready --ar 1:1 --v 6.0 --style raw"
        ),
    },
    {
        "id": "house",
        "target_w": 128,
        "target_h": 110,
        "gen_w": 1024,
        "gen_h": 1024,
        "prompt": (
            "A 2D game asset of an ancient rustic East Asian peasant cottage house, 2.5D isometric top-down view. "
            "Small thatched-roof wooden hut, earthen timber walls, firewood stack, wicker basket near the door, "
            "rural village house asset. "
            "Solid pure white background, clean sharp silhouette, game asset ready --ar 1:1 --v 6.0 --style raw"
        ),
    },
    {
        "id": "farm",
        "target_w": 192,
        "target_h": 96,
        "gen_w": 1024,
        "gen_h": 512,
        "prompt": (
            "A 2D game asset of an ancient Asian irrigated rice paddy farmland, 2.5D isometric top-down view. "
            "Flooded mud plots with lush green rice crop shoots, wooden water irrigation ditch, neat agricultural field tile. "
            "Solid pure white background, clean sharp silhouette, game asset ready --ar 2:1 --v 6.0 --style raw"
        ),
    },
    {
        "id": "tower",
        "target_w": 80,
        "target_h": 180,
        "gen_w": 512,
        "gen_h": 1024,
        "prompt": (
            "A 2D game asset of an ancient tall wooden and stone watchtower defense tower, 2.5D isometric top-down view. "
            "Slender multi-tiered timber outpost with lookout parapet, arrow slits, signal fire brazier at the peak, stone base. "
            "Solid pure white background, clean sharp silhouette, game asset ready --ar 1:2 --v 6.0 --style raw"
        ),
    },
]


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


def process_building(raw_path: Path, output_path: Path, target_w: int, target_h: int):
    with Image.open(raw_path) as img:
        img = img.convert("RGBA")
        bbox = img.getbbox()
        if bbox:
            img = img.crop(bbox)

        # Scale to fit target dimensions preserving aspect ratio
        scale = min(target_w / img.width, target_h / img.height)
        nw = max(1, int(img.width * scale))
        nh = max(1, int(img.height * scale))
        scaled = img.resize((nw, nh), Image.Resampling.LANCZOS)

        # Center horizontally, anchor to bottom
        canvas = Image.new("RGBA", (target_w, target_h), (0, 0, 0, 0))
        ox = (target_w - nw) // 2
        oy = target_h - nh
        canvas.paste(scaled, (ox, oy), scaled)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        canvas.save(output_path, "PNG", optimize=True)
        print(f"  Processed {output_path.name}: {target_w}x{target_h}")


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for idx, spec in enumerate(BUILDING_SPECS):
        b_id = spec["id"]
        print(f"\n==========================================")
        print(f"[{idx+1}/{len(BUILDING_SPECS)}] Generating: {b_id.upper()}")
        print(f"==========================================")

        # 1. Text to Image
        img_resp = api_request("/v1/images", {
            "prompt": spec["prompt"],
            "width": spec["gen_w"],
            "height": spec["gen_h"],
            "steps": 8
        })
        img_job_id = img_resp["job_id"]
        print(f"Submitted image job: {img_job_id}")
        img_job = wait_for_job(img_job_id, f"{b_id}-img")

        # 2. Key out white background via /v1/sprites
        sprite_resp = api_request("/v1/sprites", {
            "from_job": img_job_id,
            "background": "color",
            "key_color": "#ffffff",
            "tolerance": 28,
            "trim": True
        })
        sprite_job_id = sprite_resp["job_id"]
        print(f"Submitted cutout job: {sprite_job_id}")
        sprite_job = wait_for_job(sprite_job_id, f"{b_id}-cutout")

        # 3. Download and process
        target_file = None
        for f in sprite_job.get("files", []):
            if f.get("filename") in ("spritesheet.png", "frame_000.png"):
                target_file = f
                break
        if not target_file and sprite_job.get("files"):
            target_file = sprite_job["files"][0]

        temp_path = OUTPUT_DIR / f"{b_id}_raw.png"
        download_file(target_file["url"], temp_path)

        final_path = OUTPUT_DIR / f"{b_id}.png"
        process_building(temp_path, final_path, spec["target_w"], spec["target_h"])
        temp_path.unlink(missing_ok=True)

    print("\nAll 5 buildings generated successfully!")


if __name__ == "__main__":
    main()

