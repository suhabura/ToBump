from PIL import Image
import os

BRAND = "assets/brand"
OUT = "assets/images"
os.makedirs(OUT, exist_ok=True)

app = Image.open(f"{BRAND}/app-icon.png").convert("RGBA")
mark = Image.open(f"{BRAND}/mark.png").convert("RGBA")

# icon.png: polished app icon
icon = app.resize((1024, 1024), Image.Resampling.LANCZOS)
icon.convert("RGB").save(f"{OUT}/icon.png", optimize=True)
print("icon.png", icon.size)


def extract_white_symbol(src: Image.Image, size: int, pad_ratio: float = 0.18) -> Image.Image:
    im = src.resize((size, size), Image.Resampling.LANCZOS).convert("RGBA")
    pixels = im.load()
    for y in range(size):
        for x in range(size):
            r, g, b, a = pixels[x, y]
            brightness = (r + g + b) / 3
            is_symbol = brightness > 200 and abs(r - g) < 40 and abs(g - b) < 40
            if is_symbol:
                pixels[x, y] = (255, 255, 255, 255)
            else:
                pixels[x, y] = (0, 0, 0, 0)
    bbox = im.getbbox()
    if not bbox:
        return Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cropped = im.crop(bbox)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    max_side = int(size * (1 - 2 * pad_ratio))
    cropped.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    ox = (size - cropped.width) // 2
    oy = (size - cropped.height) // 2
    canvas.paste(cropped, (ox, oy), cropped)
    return canvas


def extract_cyan_symbol(
    src: Image.Image, size: int, color=(43, 184, 232), pad_ratio: float = 0.16
) -> Image.Image:
    im = src.resize((1024, 1024), Image.Resampling.LANCZOS).convert("RGBA")
    pixels = im.load()
    for y in range(1024):
        for x in range(1024):
            r, g, b, a = pixels[x, y]
            if r > 245 and g > 245 and b > 245:
                pixels[x, y] = (0, 0, 0, 0)
            else:
                pixels[x, y] = (*color, 255)
    bbox = im.getbbox()
    cropped = im.crop(bbox) if bbox else im
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    max_side = int(size * (1 - 2 * pad_ratio))
    cropped.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    ox = (size - cropped.width) // 2
    oy = (size - cropped.height) // 2
    canvas.paste(cropped, (ox, oy), cropped)
    return canvas


white_symbol_1024 = extract_white_symbol(app, 1024, pad_ratio=0.2)
white_symbol_1024.save(f"{OUT}/splash-icon.png", optimize=True)
print("splash-icon.png", white_symbol_1024.size)

fg = extract_white_symbol(app, 512, pad_ratio=0.22)
fg.save(f"{OUT}/android-icon-foreground.png", optimize=True)
print("android-icon-foreground.png", fg.size)

bg = Image.new("RGBA", (512, 512), (43, 184, 232, 255))
bg.save(f"{OUT}/android-icon-background.png", optimize=True)
print("android-icon-background.png", bg.size)

mono_src = extract_white_symbol(app, 432, pad_ratio=0.18)
mp = mono_src.load()
for y in range(432):
    for x in range(432):
        r, g, b, a = mp[x, y]
        mp[x, y] = (0, 0, 0, 255) if a > 10 else (0, 0, 0, 0)
mono_src.save(f"{OUT}/android-icon-monochrome.png", optimize=True)
print("android-icon-monochrome.png", mono_src.size)

fav_base = extract_cyan_symbol(mark, 48, pad_ratio=0.08)
if not fav_base.getbbox():
    fav_base = app.resize((48, 48), Image.Resampling.LANCZOS)
fav_base.save(f"{OUT}/favicon.png", optimize=True)
print("favicon.png", fav_base.size)

extract_cyan_symbol(mark, 192, pad_ratio=0.1).save(
    f"{BRAND}/mark-cyan-transparent.png", optimize=True
)
print("done")
