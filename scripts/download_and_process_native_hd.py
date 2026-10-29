"""Download native 1024x1024 / 1024x256 cutout renders directly from ComfyUI server and downsample cleanly to 2x AoE DE HD specifications."""

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

BUILDING_JOBS = [
    {"id": "town_center", "job_id": "cf60280e4d4e4c3288b2e98ec5ac8d2d", "target_w": 576, "target_h": 440},
    {"id": "barracks", "job_id": "3692658000ff4b649a075ba18e4bbbd4", "target_w": 400, "target_h": 320},
    {"id": "house", "job_id": "8c437233ba5a4642957c40b0e4bb7806", "target_w": 256, "target_h": 220},
    {"id": "farm", "job_id": "dcd7dbb83fac448bbc7ccebf65705e57", "target_w": 384, "target_h": 192},
    {"id": "tower", "job_id": "0825da14ca784362b9ff1ea8f4ed1434", "target_w": 160, "target_h": 360},
]

RESOURCE_JOBS = [
    {"id": "tree", "job_id": "9a400d3cdc1c4e24a66a46ff65f09963", "target_w": 160, "target_h": 220},
    {"id": "gold", "job_id": "bda2709eed484e31ae110e316eb7d1a4", "target_w": 152, "target_h": 116},
    {"id": "stone", "job_id": "3269cb467c294d139783ba8830ad55ba", "target_w": 152, "target_h": 116},
    {"id": "berry", "job_id": "de9365c671b64301897fd8999706e510", "target_w": 152, "target_h": 116},
]

UNIT_JOBS = [
    {"id": "villager", "job_id": "fa729f07d52043368fe41d798d7fcc8c", "frame_size": 128},
    {"id": "spearman", "job_id": "ba3acb56b91e44e888b54f6acf748b1c", "frame_size": 128},
    {"id": "archer", "job_id": "4640d41b1c70484388d7de30ff33fe29", "frame_size": 128},
    {"id": "cavalry", "job_id": "3c06bdd96cf041b7aa7b2dc58dd2889a", "frame_size": 160},
]

def api_request(path: str) -> dict:
    url = f"{API_HOST}{path}"
    req = urllib.request.Request(url, headers={"X-API-Key": API_KEY})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))

def download_file(url: str, dest_path: Path):
    parsed = urllib.parse.urlparse(url)
    direct_url = f"{API_HOST}{parsed.path}"
    req = urllib.request.Request(direct_url, headers={"X-API-Key": API_KEY})
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(req) as r, open(dest_path, "wb") as f:
        f.write(r.read())
    print(f"  Downloaded: {dest_path.name} ({dest_path.stat().st_size} bytes)")

def process_static_asset(raw_path: Path, output_path: Path, target_w: int, target_h: int):
    with Image.open(raw_path) as img:
        img = img.convert("RGBA")
        bbox = img.getbbox()
        if bbox:
            img = img.crop(bbox)

        # Scale down cleanly from native 1024x1024 preserving aspect ratio
        scale = min(target_w / img.width, target_h / img.height)
        nw = max(1, int(img.width * scale))
        nh = max(1, int(img.height * scale))
        scaled = img.resize((nw, nh), Image.Resampling.LANCZOS)

        canvas = Image.new("RGBA", (target_w, target_h), (0, 0, 0, 0))
        ox = (target_w - nw) // 2
        oy = target_h - nh
        canvas.paste(scaled, (ox, oy), scaled)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        canvas.save(output_path, "PNG", optimize=True)
        print(f"  Processed {output_path.name}: {target_w}x{target_h} (Downscaled from {img.width}x{img.height})")

def process_unit_spritesheet(raw_path: Path, sheet_path: Path, idle_path: Path, frame_size: int):
    with Image.open(raw_path) as source:
        source_rgba = source.convert("RGBA")
        src_w, src_h = source_rgba.size
        panel_count = 4
        panel_w = src_w // panel_count

        final_sheet = Image.new("RGBA", (panel_count * frame_size, frame_size), (0, 0, 0, 0))

        for i in range(panel_count):
            box = (i * panel_w, 0, (i + 1) * panel_w, src_h)
            panel = source_rgba.crop(box)
            bbox = panel.getbbox()
            if bbox:
                char_crop = panel.crop(bbox)
            else:
                char_crop = panel

            max_dim = int(frame_size * 0.88)
            scale = min(max_dim / max(1, char_crop.width), max_dim / max(1, char_crop.height))
            nw = max(1, int(char_crop.width * scale))
            nh = max(1, int(char_crop.height * scale))
            scaled_char = char_crop.resize((nw, nh), Image.Resampling.LANCZOS)

            frame_img = Image.new("RGBA", (frame_size, frame_size), (0, 0, 0, 0))
            ox = (frame_size - nw) // 2
            oy = frame_size - nh - 4
            frame_img.paste(scaled_char, (ox, oy), scaled_char)

            final_sheet.paste(frame_img, (i * frame_size, 0), frame_img)
            if i == 0:
                frame_img.save(idle_path, "PNG", optimize=True)

        final_sheet.save(sheet_path, "PNG", optimize=True)
        print(f"  Processed {sheet_path.name}: {panel_count * frame_size}x{frame_size}, idle {frame_size}x{frame_size}")

def get_job_file_url(job_id: str) -> str:
    job = api_request(f"/v1/jobs/{job_id}")
    for f in job.get("files", []):
        if f.get("filename") in ("spritesheet.png", "frame_000.png"):
            return f["url"]
    if job.get("files"):
        return job["files"][0]["url"]
    raise RuntimeError(f"No file in job {job_id}")

def main():
    raw_dir = ROOT / "scripts" / "raw_downloads"
    raw_dir.mkdir(parents=True, exist_ok=True)

    print("=== [1/3] Downloading & Processing Native 1024x1024 Buildings ===")
    b_out = CLIENT_PUBLIC / "assets" / "buildings"
    for item in BUILDING_JOBS:
        print(f"Building: {item['id']}")
        url = get_job_file_url(item["job_id"])
        raw_path = raw_dir / f"b_{item['id']}_raw1024.png"
        download_file(url, raw_path)
        process_static_asset(raw_path, b_out / f"{item['id']}.png", item["target_w"], item["target_h"])

    print("\n=== [2/3] Downloading & Processing Native 1024x1024 Resources ===")
    r_out = CLIENT_PUBLIC / "assets" / "resources"
    for item in RESOURCE_JOBS:
        print(f"Resource: {item['id']}")
        url = get_job_file_url(item["job_id"])
        raw_path = raw_dir / f"r_{item['id']}_raw1024.png"
        download_file(url, raw_path)
        process_static_asset(raw_path, r_out / f"{item['id']}.png", item["target_w"], item["target_h"])

    print("\n=== [3/3] Downloading & Processing Native 1024x256 Units ===")
    u_out = CLIENT_PUBLIC / "assets" / "units"
    for item in UNIT_JOBS:
        print(f"Unit: {item['id']}")
        url = get_job_file_url(item["job_id"])
        raw_path = raw_dir / f"u_{item['id']}_raw.png"
        download_file(url, raw_path)
        process_unit_spritesheet(
            raw_path,
            u_out / f"{item['id']}_sheet.png",
            u_out / f"{item['id']}_idle.png",
            item["frame_size"]
        )

    print("\nSUCCESS: All native HD assets downloaded and processed cleanly!")

if __name__ == "__main__":
    main()

