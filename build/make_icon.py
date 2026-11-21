import io
import struct

from PIL import Image, ImageDraw

SRC = r'E:\XC_Tools\App\xcVideoEdit\build\icon-source.png'
OUT = r'E:\XC_Tools\App\xcVideoEdit\build'

src = Image.open(SRC).convert('RGBA')
bbox = src.getbbox()
print('source', src.size, 'bbox', bbox)
if bbox:
    src = src.crop(bbox)


def fit(canvas_side, scale=0.9):
    canvas = Image.new('RGBA', (canvas_side, canvas_side), (0, 0, 0, 0))
    target = int(canvas_side * scale)
    ratio = min(target / src.width, target / src.height)
    new_size = (max(1, int(src.width * ratio)), max(1, int(src.height * ratio)))
    resized = src.resize(new_size, Image.LANCZOS)
    canvas.paste(resized, ((canvas_side - new_size[0]) // 2, (canvas_side - new_size[1]) // 2), resized)
    return canvas


def simple_icon(size):
    """小尺寸专用的几何简版：深底 + 白色胶片条 + 红色取景角"""
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=max(1, round(size * 0.18)),
                        fill=(27, 32, 39, 255))

    pad_x = round(size * 0.27)
    pad_y = round(size * 0.395)
    d.rounded_rectangle([pad_x, pad_y, size - 1 - pad_x, size - 1 - pad_y],
                        radius=max(1, round(size * 0.03)), fill=(250, 250, 252, 255))

    t = max(1, round(size * 0.06))
    arm = max(2, round(size * 0.17))
    m = max(2, round(size * 0.19))
    red = (255, 59, 48, 255)

    d.rectangle([m, m, m + arm, m + t - 1], fill=red)
    d.rectangle([m, m, m + t - 1, m + arm], fill=red)

    d.rectangle([size - 1 - m - arm, m, size - 1 - m, m + t - 1], fill=red)
    d.rectangle([size - 1 - m - t + 1, m, size - 1 - m, m + arm], fill=red)

    d.rectangle([m, size - 1 - m - t + 1, m + arm, size - 1 - m], fill=red)
    d.rectangle([m, size - 1 - m - arm, m + t - 1, size - 1 - m], fill=red)

    d.rectangle([size - 1 - m - arm, size - 1 - m - t + 1, size - 1 - m, size - 1 - m], fill=red)
    d.rectangle([size - 1 - m - t + 1, size - 1 - m - arm, size - 1 - m, size - 1 - m], fill=red)
    return im


icon_1024 = fit(1024, 0.9)
icon_1024.save(f'{OUT}\\icon.png', 'PNG')
fit(512, 0.9).save(f'{OUT}\\icon-512.png', 'PNG')
fit(256, 0.9).save(f'{OUT}\\icon-256.png', 'PNG')


def save_ico(path, entries):
    """entries: [(size, image)]，按条目写入 ICO（PNG 压缩格式，Vista+ 支持）"""
    header = struct.pack('<HHH', 0, 1, len(entries))
    dirs = b''
    data = b''
    offset = 6 + 16 * len(entries)
    for size, im in entries:
        buf = io.BytesIO()
        im.save(buf, 'PNG')
        png = buf.getvalue()
        dim = 0 if size >= 256 else size
        dirs += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(png), offset)
        data += png
        offset += len(png)
    with open(path, 'wb') as f:
        f.write(header + dirs + data)


entries = [
    (16, simple_icon(16)),
    (24, simple_icon(24)),
    (32, fit(32, 0.92)),
    (48, fit(48, 0.92)),
    (64, fit(64, 0.92)),
    (128, fit(128, 0.92)),
    (256, fit(256, 0.92)),
]
save_ico(f'{OUT}\\icon.ico', entries)

# 小尺寸对照预览
sheet = Image.new('RGBA', (3 * 128 + 2 * 24, 128), (45, 48, 53, 255))
for i, size in enumerate([16, 24, 32]):
    im = simple_icon(size) if size != 32 else fit(32, 0.92)
    big = im.resize((128, 128), Image.NEAREST)
    sheet.paste(big, (i * 152, 0), big)
sheet.save(f'{OUT}\\preview_sizes.png')

print('icon.png / icon-512.png / icon-256.png / icon.ico / preview_sizes.png')
