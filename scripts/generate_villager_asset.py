"""Script to generate isometric villager sprite sheet using Local ComfyUI API."""

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
OUTPUT_DIR = CLIENT_PUBLIC / "assets" / "units"

API_HOST = "http://192.168.1.14:8090"

# Read LOCAL_API_KEY from .env
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

VILLAGER_PROMPT = (
    "A 2D game sprite sheet of an ancient Asian peasant farmer villager, 2.5D isometric top-down view. "
    "Stylized historical Vietnamese and East Asian style, wearing rustic brown linen tunic, rolled trousers, "
    "and a conical straw hat (non la), carrying a wooden farming hoe. "
    "Single horizontal row of 4 animation frames from left to right: "
    "Frame 1: idle standing pose holding the hoe resting on shoulder; "
    "Frame 2: walking stride forward; "
    "Frame 3: alternating walking stride; "
    "Frame 4: swinging hoe down in a harvesting work action. "
    "Solid pure white background, uniform lighting, clean sharp silhouette, game asset ready --ar 4:1 --v 6.0 --style raw"
)


def api_request(path: str, data: dict = None) -> dict:
    """Send authenticated JSON request to the API."""
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
    """Poll job until completion."""
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
    """Download output file, rewriting host to API_HOST."""
    parsed = urllib.parse.urlparse(url)
    direct_url = f"{API_HOST}{parsed.path}"
    req = urllib.request.Request(direct_url, headers={"X-API-Key": API_KEY})
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(req) as r, open(dest_path, "wb") as f:
        f.write(r.read())
    print(f"  Downloaded: {dest_path}")


def process_spritesheet(raw_path: Path, output_sheet_path: Path, frame_size: int = 64):
    """Slice 4-panel image into individual frames, center them, and assemble a 4-frame sheet."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with Image.open(raw_path) as source:
        source_rgba = source.convert("RGBA")
        src_width, src_height = source_rgba.size
        panel_count = 4
        panel_width = src_width // panel_count

        # Final assembled spritesheet width: 4 * frame_size, height: frame_size
        final_sheet = Image.new("RGBA", (panel_count * frame_size, frame_size), (0, 0, 0, 0))

        for i in range(panel_count):
            box = (i * panel_width, 0, (i + 1) * panel_width, src_height)
            panel = source_rgba.crop(box)

            # Auto-crop bounding box of alpha to remove excess empty space around character
            bbox = panel.getbbox()
            if bbox:
                char_cropped = panel.crop(bbox)
            else:
                char_cropped = panel

            # Scale character to fit within frame_size while preserving aspect ratio
            max_char_dim = int(frame_size * 0.85)  # Leave margin for anchor/headroom
            scale = min(max_char_dim / char_cropped.width, max_char_dim / char_cropped.height)
            new_w = max(1, int(char_cropped.width * scale))
            new_h = max(1, int(char_cropped.height * scale))
            scaled_char = char_cropped.resize((new_w, new_h), Image.Resampling.LANCZOS)

            # Place character inside frame: horizontally centered, anchored at bottom (feet on ground)
            frame_img = Image.new("RGBA", (frame_size, frame_size), (0, 0, 0, 0))
            offset_x = (frame_size - new_w) // 2
            offset_y = frame_size - new_h - 2  # 2px bottom padding
            frame_img.paste(scaled_char, (offset_x, offset_y), scaled_char)

            # Paste into final sheet
            final_sheet.paste(frame_img, (i * frame_size, 0), frame_img)

            # Also save first frame as idle preview
            if i == 0:
                idle_path = OUTPUT_DIR / "villager_idle.png"
                frame_img.save(idle_path, "PNG", optimize=True)
                print(f"  Saved idle frame to {idle_path}")

        final_sheet.save(output_sheet_path, "PNG", optimize=True)
        print(f"  Saved final spritesheet ({panel_count * frame_size}x{frame_size}) to {output_sheet_path}")


def main():
    print("=== Step 1: Requesting Image Generation ===")
    img_resp = api_request("/v1/images", {
        "prompt": VILLAGER_PROMPT,
        "width": 1024,
        "height": 256,
        "steps": 8
    })
    img_job_id = img_resp["job_id"]
    print(f"Submitted image job: {img_job_id}")
    img_job = wait_for_job(img_job_id, "image-gen")

    print("\n=== Step 2: Requesting Alpha Cutout via /v1/sprites ===")
    sprite_resp = api_request("/v1/sprites", {
        "from_job": img_job_id,
        "background": "color",
        "key_color": "#ffffff",
        "tolerance": 28,
        "trim": False
    })
    sprite_job_id = sprite_resp["job_id"]
    print(f"Submitted sprite cutout job: {sprite_job_id}")
    sprite_job = wait_for_job(sprite_job_id, "sprite-cutout")

    print("\n=== Step 3: Downloading Transparent Sprite Sheet ===")
    # Find spritesheet.png or frame_000.png from outputs
    target_file = None
    for f in sprite_job.get("files", []):
        if f.get("filename") in ("spritesheet.png", "frame_000.png"):
            target_file = f
            break
    if not target_file and sprite_job.get("files"):
        target_file = sprite_job["files"][0]

    if not target_file:
        raise RuntimeError("No output files returned by sprite cutout job")

    raw_dest = OUTPUT_DIR / "villager_raw_cutout.png"
    download_file(target_file["url"], raw_dest)

    print("\n=== Step 4: Processing Spritesheet for Phaser 3 ===")
    sheet_dest = OUTPUT_DIR / "villager_sheet.png"
    process_spritesheet(raw_dest, sheet_dest, frame_size=64)
    print("\n=== Done! Asset generation completed successfully. ===")


if __name__ == "__main__":
    main()

