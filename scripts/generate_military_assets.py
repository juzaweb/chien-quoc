"""Script to generate isometric military unit sprite sheets (Spearman, Archer, Cavalry) using Local ComfyUI API."""

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

MILITARY_UNITS = [
    {
        "id": "spearman",
        "name": "Spearman",
        "frame_size": 64,
        "prompt": (
            "A 2D game sprite sheet of an ancient East Asian armored spearmen infantry soldier, 2.5D isometric top-down view. "
            "Warring States historical style, wearing lacquered bronze and crimson lamellar armor, pointed helmet, "
            "wielding a long spear with bronze spearhead. "
            "Single horizontal row of 4 animation frames from left to right: "
            "Frame 1: idle combat stance holding spear upright; "
            "Frame 2: walking march stride forward; "
            "Frame 3: alternating marching stride; "
            "Frame 4: thrusting spear forward in attack pose. "
            "Solid pure white background, uniform lighting, clean sharp silhouette, game asset ready --ar 4:1 --v 6.0 --style raw"
        ),
    },
    {
        "id": "archer",
        "name": "Archer",
        "frame_size": 64,
        "prompt": (
            "A 2D game sprite sheet of an ancient East Asian archer marksman soldier, 2.5D isometric top-down view. "
            "Warring States historical style, wearing studded leather armor tunic and fabric headband, quiver of arrows strapped to back, "
            "holding a traditional composite recurve bow. "
            "Single horizontal row of 4 animation frames from left to right: "
            "Frame 1: idle standing pose holding bow at side; "
            "Frame 2: walking stride forward; "
            "Frame 3: alternating walking stride; "
            "Frame 4: drawing bowstring and aiming arrow forward in shooting attack pose. "
            "Solid pure white background, uniform lighting, clean sharp silhouette, game asset ready --ar 4:1 --v 6.0 --style raw"
        ),
    },
    {
        "id": "cavalry",
        "name": "Cavalry",
        "frame_size": 80,
        "prompt": (
            "A 2D game sprite sheet of an ancient East Asian armored cavalry warrior mounted on a warhorse, 2.5D isometric top-down view. "
            "Warring States historical style, armored warrior in crimson and bronze plate mounted on a muscular warhorse with saddle and bridle, "
            "wielding a curved dao saber. "
            "Single horizontal row of 4 animation frames from left to right: "
            "Frame 1: idle mounted pose on standing horse; "
            "Frame 2: horse trotting forward stride; "
            "Frame 3: horse galloping fast stride; "
            "Frame 4: rider slashing saber downward in mounted strike. "
            "Solid pure white background, uniform lighting, clean sharp silhouette, game asset ready --ar 4:1 --v 6.0 --style raw"
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
    print(f"  Downloaded: {dest_path}")


def process_spritesheet(raw_path: Path, output_sheet_path: Path, idle_path: Path, frame_size: int = 64):
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with Image.open(raw_path) as source:
        source_rgba = source.convert("RGBA")
        src_width, src_height = source_rgba.size
        panel_count = 4
        panel_width = src_width // panel_count

        final_sheet = Image.new("RGBA", (panel_count * frame_size, frame_size), (0, 0, 0, 0))

        for i in range(panel_count):
            box = (i * panel_width, 0, (i + 1) * panel_width, src_height)
            panel = source_rgba.crop(box)

            bbox = panel.getbbox()
            if bbox:
                char_cropped = panel.crop(bbox)
            else:
                char_cropped = panel

            max_char_dim = int(frame_size * 0.88)
            scale = min(max_char_dim / max(1, char_cropped.width), max_char_dim / max(1, char_cropped.height))
            new_w = max(1, int(char_cropped.width * scale))
            new_h = max(1, int(char_cropped.height * scale))
            scaled_char = char_cropped.resize((new_w, new_h), Image.Resampling.LANCZOS)

            frame_img = Image.new("RGBA", (frame_size, frame_size), (0, 0, 0, 0))
            offset_x = (frame_size - new_w) // 2
            offset_y = frame_size - new_h - 2
            frame_img.paste(scaled_char, (offset_x, offset_y), scaled_char)

            final_sheet.paste(frame_img, (i * frame_size, 0), frame_img)

            if i == 0:
                frame_img.save(idle_path, "PNG", optimize=True)
                print(f"  Saved idle frame to {idle_path}")

        final_sheet.save(output_sheet_path, "PNG", optimize=True)
        print(f"  Saved final spritesheet ({panel_count * frame_size}x{frame_size}) to {output_sheet_path}")


def main():
    raw_dir = OUTPUT_DIR / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    total = len(MILITARY_UNITS)
    for idx, unit in enumerate(MILITARY_UNITS, 1):
        uid = unit["id"]
        frame_size = unit["frame_size"]
        sheet_path = OUTPUT_DIR / f"{uid}_sheet.png"
        idle_path = OUTPUT_DIR / f"{uid}_idle.png"

        print(f"\n==========================================")
        print(f"[{idx}/{total}] Generating Unit: {unit['name'].upper()} ({frame_size}x{frame_size})")
        print(f"==========================================")

        # Optimization: spearman cutout was already generated in job ba3acb56b91e44e888b54f6acf748b1c
        if uid == "spearman":
            try:
                cutout_job = api_request("/v1/jobs/ba3acb56b91e44e888b54f6acf748b1c")
                if cutout_job.get("status") != "succeeded":
                    cutout_job = None
            except Exception:
                cutout_job = None
        else:
            cutout_job = None

        if not cutout_job:
            img_resp = api_request("/v1/images", {
                "prompt": unit["prompt"],
                "width": 1024,
                "height": 256,
                "steps": 8
            })
            img_job_id = img_resp["job_id"]
            print(f"Submitted image job: {img_job_id}")
            wait_for_job(img_job_id, f"{uid}-img")

            sprite_resp = api_request("/v1/sprites", {
                "from_job": img_job_id,
                "background": "color",
                "key_color": "#ffffff",
                "tolerance": 28,
                "trim": False
            })
            sprite_job_id = sprite_resp["job_id"]
            print(f"Submitted sprite cutout job: {sprite_job_id}")
            cutout_job = wait_for_job(sprite_job_id, f"{uid}-cutout")

        target_file = None
        for f in cutout_job.get("files", []):
            if f.get("filename") in ("spritesheet.png", "frame_000.png"):
                target_file = f
                break
        if not target_file and cutout_job.get("files"):
            target_file = cutout_job["files"][0]

        if not target_file:
            raise RuntimeError(f"No output files returned by sprite cutout job for {uid}")

        raw_cutout_path = raw_dir / f"{uid}_cutout_raw.png"
        download_file(target_file["url"], raw_cutout_path)

        process_spritesheet(raw_cutout_path, sheet_path, idle_path, frame_size=frame_size)
        print(f"Processed {uid}: sheet ({4 * frame_size}x{frame_size}), idle ({frame_size}x{frame_size})")

    print("\nAll military unit assets generated successfully!")


if __name__ == "__main__":
    main()
