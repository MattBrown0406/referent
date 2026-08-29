from pathlib import Path
from PIL import Image, ImageDraw
import math

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'assets'
SCALE = 4
S = 1024 * SCALE
BG = '#F6F1E7'
GREEN = '#174F43'
TEAL = '#397F7A'
GOLD = '#D5A33B'
MONO = '#111111'


def cubic(p0, p1, p2, p3, steps=220):
    points = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        points.append((
            u**3*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t**3*p3[0],
            u**3*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t**3*p3[1],
        ))
    return points


def sc(points):
    return [(round(x * SCALE), round(y * SCALE)) for x, y in points]


def circle(draw, cx, cy, radius, fill):
    draw.ellipse(((cx-radius)*SCALE, (cy-radius)*SCALE, (cx+radius)*SCALE, (cy+radius)*SCALE), fill=fill)


def arrowhead(draw, tip, previous, color, length=92, half_width=70):
    dx, dy = tip[0]-previous[0], tip[1]-previous[1]
    mag = math.hypot(dx, dy) or 1
    ux, uy = dx/mag, dy/mag
    bx, by = tip[0]-ux*length, tip[1]-uy*length
    px, py = -uy, ux
    polygon = [tip, (bx+px*half_width, by+py*half_width), (bx-px*half_width, by-py*half_width)]
    draw.polygon(sc(polygon), fill=color)


def draw_partner(draw, cx, color, person_color):
    circle(draw, cx, 512, 118, color)
    # A simple person glyph inside each partner node.
    circle(draw, cx, 475, 31, person_color)
    draw.rounded_rectangle(((cx-61)*SCALE, 521*SCALE, (cx+61)*SCALE, 589*SCALE), radius=34*SCALE, fill=person_color)


def draw_mark(image, left=GREEN, right=TEAL, gold=GOLD, person_color: str | tuple[int, int, int, int] = BG):
    d = ImageDraw.Draw(image)
    # Two opposing referral paths form one continuous reciprocal system.
    top = cubic((276, 447), (385, 202), (639, 202), (748, 447))
    bottom = cubic((748, 577), (639, 822), (385, 822), (276, 577))
    width = 72 * SCALE
    d.line(sc(top), fill=left, width=width, joint='curve')
    d.line(sc(bottom), fill=right, width=width, joint='curve')
    arrowhead(d, top[-1], top[-10], left)
    arrowhead(d, bottom[-1], bottom[-10], right)

    draw_partner(d, 178, left, person_color)
    draw_partner(d, 846, right, person_color)

    # One opportunity shared by both referral paths.
    circle(d, 512, 512, 72, person_color)
    circle(d, 512, 512, 52, gold)


def export(path, background, colors, transparent=False, adaptive_scale=1.0):
    mode = 'RGBA' if transparent else 'RGB'
    fill = (0, 0, 0, 0) if transparent else background
    image = Image.new(mode, (S, S), fill)
    draw_mark(image, *colors, person_color=(255, 255, 255, 0) if transparent else BG)
    if adaptive_scale != 1.0:
        scaled_size = round(S * adaptive_scale)
        scaled = image.resize((scaled_size, scaled_size), Image.Resampling.LANCZOS)
        image = Image.new(mode, (S, S), fill)
        inset = (S - scaled_size) // 2
        image.paste(scaled, (inset, inset), scaled if transparent else None)
    image.resize((1024, 1024), Image.Resampling.LANCZOS).save(path, 'PNG', optimize=True)


export(ASSETS / 'icon-referent-symbiosis.png', BG, (GREEN, TEAL, GOLD))
Image.new('RGB', (1024, 1024), BG).save(ASSETS / 'android-icon-background.png', 'PNG', optimize=True)
export(ASSETS / 'android-icon-foreground.png', BG, (GREEN, TEAL, GOLD), transparent=True, adaptive_scale=0.78)
export(ASSETS / 'android-icon-monochrome.png', BG, (MONO, MONO, MONO), transparent=True, adaptive_scale=0.78)
print('generated icon-referent-symbiosis.png and Android adaptive layers')
