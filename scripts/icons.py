"""用几何书页绘制可复现的本地图标，不加载外部图片或字体。"""
from pathlib import Path
from PIL import Image, ImageDraw

output = Path(__file__).resolve().parents[1] / "public" / "icons"
output.mkdir(parents=True, exist_ok=True)
canvas = Image.new("RGBA", (512, 512))
draw = ImageDraw.Draw(canvas)
draw.rounded_rectangle((0, 0, 512, 512), radius=120, fill="#164c42")
draw.rounded_rectangle((98, 112, 266, 350), radius=24, fill="#d5e7dc")
draw.rounded_rectangle((212, 162, 412, 404), radius=24, fill="#fffaf0")
for x1, y, x2 in ((132, 164, 228), (132, 207, 183), (248, 220, 372), (248, 265, 372), (248, 310, 332)):
    draw.rounded_rectangle((x1, y, x2, y + 14), radius=7, fill="#164c42")
draw.ellipse((352, 99, 410, 157), fill="#e8b866")
for size in (16, 32, 48, 128):
    canvas.resize((size, size), Image.Resampling.LANCZOS).save(output / f"{size}.png")
print("已生成 16/32/48/128 像素书页图标。")
