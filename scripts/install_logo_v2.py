"""Install selected horizontal logo (v2) and derive mark + Expo icons."""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
BRAND = ROOT / "assets" / "brand"
OUT = ROOT / "assets" / "images"
SRC_LOGO = Path(
    r"C:\Users\petra\.cursor\projects\c-Users-petra-OneDrive-Namizje-Cursor-ToBump-tobump-mobile\assets\tobump-logo-horizontal-v2.png"
)
SRC_ICON = Path(
    r"C:\Users\petra\.cursor\projects\c-Users-petra-OneDrive-Namizje-Cursor-ToBump-tobump-mobile\assets\tobump-app-icon-from-v2.png"
)
CYAN = (43, 184, 232, 255)


def trim(im: Image.Image, threshold: int = 248) -> Image.Image:
    rgba = im.convert("RGBA")
    mask = Image.new("L", rgba.size, 0)
    mp = mask.load()
    px = rgba.load()
    w, h = rgba.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a > 10 and not (r >= threshold and g >= threshold and b >= threshold):
                mp[x, y] = 255
    bbox = mask.getbbox()
    if not bbox:
        return rgba
    return rgba.crop(bbox)


def add_padding(im: Image.Image, pad: int, fill=(255, 255, 255, 255)) -> Image.Image:
    canvas = Image.new("RGBA", (im.width + pad * 2, im.height + pad * 2), fill)
    canvas.paste(im, (pad, pad), im)
    return canvas


def extract_mark(logo: Image.Image) -> Image.Image:
    """Take the left fist-bump from the horizontal lockup."""
    work = trim(logo)
    px = work.load()
    w, h = work.size
    col_fill = []
    for x in range(w):
        filled = 0
        for y in range(h):
            r, g, b, a = px[x, y]
            if a > 10 and not (r > 245 and g > 245 and b > 245):
                filled += 1
        col_fill.append(filled)

    start = next((i for i, n in enumerate(col_fill) if n > 8), 0)
    gap = None
    in_gap = 0
    for x in range(start + 8, w):
        if col_fill[x] < 4:
            in_gap += 1
            if in_gap >= max(12, w // 40):
                gap = x - in_gap
                break
        else:
            in_gap = 0
    right = gap if gap else int(w * 0.42)
    fists = work.crop((0, 0, right, h))
    fists = trim(fists)
    # Recolor to brand cyan, white -> transparent
    fists = fists.convert("RGBA")
    fp = fists.load()
    for y in range(fists.height):
        for x in range(fists.width):
            r, g, b, a = fp[x, y]
            if a < 20 or (r > 245 and g > 245 and b > 245):
                fp[x, y] = (0, 0, 0, 0)
            else:
                fp[x, y] = CYAN
    size = 1024
    canvas = Image.new("RGBA", (size, size), (255, 255, 255, 255))
    max_side = int(size * 0.72)
    fists.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    ox = (size - fists.width) // 2
    oy = (size - fists.height) // 2
    canvas.paste(fists, (ox, oy), fists)
    return canvas


def square_cyan_icon(src: Image.Image, size: int = 1024) -> Image.Image:
    """Force a full-bleed cyan square (OS applies the mask)."""
    im = src.convert("RGBA").resize((size, size), Image.Resampling.LANCZOS)
    out = Image.new("RGB", (size, size), (43, 184, 232))
    # Keep light pixels as the white symbol; fill dark/corner leftovers with cyan
    px = im.load()
    op = out.load()
    for y in range(size):
        for x in range(size):
            r, g, b, a = px[x, y]
            brightness = (r + g + b) / 3
            if a > 20 and brightness > 200 and abs(r - g) < 45 and abs(g - b) < 45:
                op[x, y] = (255, 255, 255)
    return out


def rounded_preview(src_rgb: Image.Image, radius: int = 220) -> Image.Image:
    size = src_rgb.size[0]
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(src_rgb.convert("RGBA"), (0, 0))
    out.putalpha(mask)
    return out


def extract_white_symbol(src: Image.Image, size: int, pad_ratio: float = 0.18) -> Image.Image:
    im = src.resize((size, size), Image.Resampling.LANCZOS).convert("RGBA")
    pixels = im.load()
    for y in range(size):
        for x in range(size):
            r, g, b, a = pixels[x, y]
            brightness = (r + g + b) / 3
            is_symbol = brightness > 200 and abs(r - g) < 40 and abs(g - b) < 40
            pixels[x, y] = (255, 255, 255, 255) if is_symbol else (0, 0, 0, 0)
    bbox = im.getbbox()
    if not bbox:
        return Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cropped = im.crop(bbox)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    max_side = int(size * (1 - 2 * pad_ratio))
    cropped.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    canvas.paste(cropped, ((size - cropped.width) // 2, (size - cropped.height) // 2), cropped)
    return canvas


def extract_cyan_symbol(src: Image.Image, size: int, pad_ratio: float = 0.16) -> Image.Image:
    im = src.convert("RGBA")
    pixels = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = pixels[x, y]
            if r > 245 and g > 245 and b > 245:
                pixels[x, y] = (0, 0, 0, 0)
            elif a > 10:
                pixels[x, y] = CYAN
    bbox = im.getbbox()
    cropped = im.crop(bbox) if bbox else im
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    max_side = int(size * (1 - 2 * pad_ratio))
    cropped.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    canvas.paste(cropped, ((size - cropped.width) // 2, (size - cropped.height) // 2), cropped)
    return canvas


def main() -> None:
    BRAND.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)

    logo = add_padding(trim(Image.open(SRC_LOGO)), pad=80, fill=(255, 255, 255, 255))
    logo.convert("RGB").save(BRAND / "logo-horizontal.png", optimize=True)
    print("logo-horizontal.png", logo.size)

    mark = extract_mark(Image.open(SRC_LOGO))
    mark.convert("RGB").save(BRAND / "mark.png", optimize=True)
    print("mark.png", mark.size)

    icon_rgb = square_cyan_icon(Image.open(SRC_ICON), 1024)
    icon_rgb.save(OUT / "icon.png", optimize=True)
    print("icon.png", icon_rgb.size)

    rounded_preview(icon_rgb).save(BRAND / "app-icon.png", optimize=True)
    print("app-icon.png")

    extract_white_symbol(icon_rgb, 1024, pad_ratio=0.2).save(OUT / "splash-icon.png", optimize=True)
    extract_white_symbol(icon_rgb, 512, pad_ratio=0.22).save(OUT / "android-icon-foreground.png", optimize=True)
    Image.new("RGBA", (512, 512), CYAN).save(OUT / "android-icon-background.png", optimize=True)

    mono = extract_white_symbol(icon_rgb, 432, pad_ratio=0.18)
    mp = mono.load()
    for y in range(432):
        for x in range(432):
            r, g, b, a = mp[x, y]
            mp[x, y] = (0, 0, 0, 255) if a > 10 else (0, 0, 0, 0)
    mono.save(OUT / "android-icon-monochrome.png", optimize=True)

    extract_cyan_symbol(mark, 48, pad_ratio=0.08).save(OUT / "favicon.png", optimize=True)
    extract_cyan_symbol(mark, 192, pad_ratio=0.1).save(BRAND / "mark-cyan-transparent.png", optimize=True)
    print("done")


if __name__ == "__main__":
    main()
