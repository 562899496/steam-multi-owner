# 生成扩展图标（Steam 深蓝底 + 双层对勾，表示"多个账号都查过"）
from PIL import Image, ImageDraw

BG = (27, 40, 56, 255)
ACCENT = (164, 208, 7, 255)
BLUE = (102, 192, 244, 255)


def make(size):
    scale = 8
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    pad = int(s * 0.06)
    d.rounded_rectangle([pad, pad, s - pad, s - pad], radius=int(s * 0.22), fill=BG,
                        outline=(42, 71, 94, 255), width=max(1, int(s * 0.02)))

    # 主对勾（亮绿）
    w = max(2, int(s * 0.085))
    d.line([(s * 0.24, s * 0.53), (s * 0.43, s * 0.72), (s * 0.77, s * 0.30)],
           fill=ACCENT, width=w, joint="curve")

    # 次对勾（Steam 蓝，靠下，表示第二个账号）
    w2 = max(2, int(s * 0.055))
    d.line([(s * 0.30, s * 0.66), (s * 0.42, s * 0.79), (s * 0.66, s * 0.55)],
           fill=BLUE, width=w2, joint="curve")

    return img.resize((size, size), Image.LANCZOS)


for px in (16, 32, 48, 128):
    make(px).save(rf"C:\dev\steam-multi-owner\icons\icon{px}.png")
    print("wrote", px)
