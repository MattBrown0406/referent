from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'assets'
SCALE = 4
SIZE = 1024
S = SIZE * SCALE

BG = '#123F37'
LEFT = '#43B7AE'
RIGHT = '#9FC596'
TRUNK = '#E6D5BA'
GOLD = '#E4AD45'
MONO = '#111111'


def sc(value: float) -> int:
    return round(value * SCALE)


def points(values):
    return [(sc(x), sc(y)) for x, y in values]


def cubic(p0, p1, p2, p3, steps=180):
    result = []
    for index in range(steps + 1):
        t = index / steps
        u = 1 - t
        result.append((
            u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
            u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1],
        ))
    return result


def circle(draw, cx, cy, radius, fill):
    draw.ellipse((sc(cx - radius), sc(cy - radius), sc(cx + radius), sc(cy + radius)), fill=fill)


def canopy(draw, cx, color):
    # Five large overlapping leaves read as one balanced tree at thumbnail size.
    for dx, dy, radius in [(-78, 20, 82), (-44, -54, 92), (44, -54, 92), (78, 20, 82), (0, 35, 112)]:
        circle(draw, cx + dx, 350 + dy, radius, color)


def draw_mark(image, left=LEFT, right=RIGHT, trunk=TRUNK, gold=GOLD, transparent=False):
    draw = ImageDraw.Draw(image)

    canopy(draw, 300, left)
    canopy(draw, 724, right)

    # Two smooth roots cross into one infinity loop. Each begins beneath one
    # trunk and finishes beneath the other, making reciprocal support explicit.
    root_width = sc(70)
    root_a = cubic((285, 575), (214, 690), (382, 778), (512, 640))
    root_a += cubic((512, 640), (642, 502), (810, 590), (739, 575))[1:]
    root_b = cubic((739, 575), (810, 690), (642, 778), (512, 640))
    root_b += cubic((512, 640), (382, 502), (214, 590), (285, 575))[1:]
    draw.line(points(root_a), fill=left, width=root_width, joint='curve')
    draw.line(points(root_b), fill=right, width=root_width, joint='curve')

    # Equal trunks sit over the root endpoints, hiding line caps and creating
    # one clean, organic trunk-to-root transition on both sides.
    draw.polygon(points([(273, 420), (327, 420), (344, 610), (256, 610)]), fill=trunk)
    draw.polygon(points([(697, 420), (751, 420), (768, 610), (680, 610)]), fill=trunk)

    # A simple almond-shaped seed is jointly cradled by both roots.
    seed = cubic((512, 574), (566, 610), (566, 666), (512, 704), 90)
    seed += cubic((512, 704), (458, 666), (458, 610), (512, 574), 90)[1:]
    draw.polygon(points(seed), fill=gold)


def export(path, colors, transparent=False, adaptive_scale=1.0):
    mode = 'RGBA' if transparent else 'RGB'
    fill = (0, 0, 0, 0) if transparent else BG
    image = Image.new(mode, (S, S), fill)
    draw_mark(image, *colors, transparent=transparent)

    if adaptive_scale != 1.0:
        scaled_size = round(S * adaptive_scale)
        scaled = image.resize((scaled_size, scaled_size), Image.Resampling.LANCZOS)
        image = Image.new(mode, (S, S), fill)
        inset = (S - scaled_size) // 2
        image.paste(scaled, (inset, inset), scaled if transparent else None)

    image.resize((SIZE, SIZE), Image.Resampling.LANCZOS).save(path, 'PNG', optimize=True)


export(ASSETS / 'icon-referent-symbiosis.png', (LEFT, RIGHT, TRUNK, GOLD))
Image.new('RGB', (SIZE, SIZE), BG).save(ASSETS / 'android-icon-background.png', 'PNG', optimize=True)
export(ASSETS / 'android-icon-foreground.png', (LEFT, RIGHT, TRUNK, GOLD), transparent=True, adaptive_scale=0.78)
export(ASSETS / 'android-icon-monochrome.png', (MONO, MONO, MONO, MONO), transparent=True, adaptive_scale=0.78)
print('generated symbiotic-growth app icon and Android adaptive layers')
