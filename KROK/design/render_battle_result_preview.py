from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


SCALE = 2
WIDTH = 480
HEIGHT = 352
GAP = 48

INK = (8, 11, 13, 255)
SURFACE = (16, 21, 22, 255)
GREEN = (76, 199, 115, 255)
GREEN_72 = (76, 199, 115, 184)
GREEN_56 = (76, 199, 115, 143)
GREEN_48 = (76, 199, 115, 122)
GREEN_22 = (76, 199, 115, 56)
WIN = (255, 101, 115, 255)
MUTED = (183, 190, 194, 255)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    path = Path(r"C:\Windows\Fonts") / ("msyhbd.ttc" if bold else "msyh.ttc")
    return ImageFont.truetype(str(path), size * SCALE)


def s(value: float) -> int:
    return round(value * SCALE)


def rgba(color, alpha: float):
    return (color[0], color[1], color[2], round(alpha * 255))


def draw_centered(draw, center_x, top, text, use_font, fill):
    box = draw.textbbox((0, 0), text, font=use_font)
    width = box[2] - box[0]
    draw.text((s(center_x) - width / 2, s(top)), text, font=use_font, fill=fill)


def draw_frame(draw, left, outcome):
    device_left = s(left)
    device_top = 0
    device_right = device_left + s(WIDTH)
    device_bottom = s(HEIGHT)
    draw.rectangle((device_left, device_top, device_right, device_bottom), fill=INK)

    screen_left = device_left + s(16)
    screen_top = device_top + s(12)
    screen_right = screen_left + s(448)
    screen_bottom = screen_top + s(328)
    draw.rectangle((screen_left, screen_top, screen_right, screen_bottom), fill=SURFACE)

    # Subtle win glow, drawn as concentric translucent circles.
    if outcome == "win":
        for radius, alpha in ((112, 5), (86, 6), (60, 7)):
            box = (
                screen_left + s(224 - radius),
                screen_top + s(135 - radius),
                screen_left + s(224 + radius),
                screen_top + s(135 + radius),
            )
            draw.ellipse(box, fill=(255, 101, 115, alpha))

    draw.line(
        (screen_left + s(16), screen_top + s(16), screen_left + s(60), screen_top + s(16)),
        fill=(76, 199, 115, 64),
        width=s(1),
    )
    draw.line(
        (screen_right - s(60), screen_top + s(16), screen_right - s(16), screen_top + s(16)),
        fill=(76, 199, 115, 64),
        width=s(1),
    )

    center_x = screen_left + s(224)
    draw_centered(
        draw,
        center_x / SCALE,
        (screen_top / SCALE) + 52,
        "本局结算",
        font(10, True),
        GREEN_56,
    )

    badge_size = s(126)
    badge_top = screen_top + s(78)
    badge_box = (
        center_x - badge_size // 2,
        badge_top,
        center_x + badge_size // 2,
        badge_top + badge_size,
    )
    badge_color = WIN if outcome == "win" else MUTED
    badge_fill = (255, 101, 115, 15) if outcome == "win" else (255, 255, 255, 6)
    draw.ellipse(badge_box, fill=badge_fill, outline=badge_color, width=s(4))

    title = "胜利" if outcome == "win" else "失败"
    title_font = font(38, True)
    title_box = draw.textbbox((0, 0), title, font=title_font)
    title_width = title_box[2] - title_box[0]
    title_height = title_box[3] - title_box[1]
    draw.text(
        (center_x - title_width / 2, badge_top + (badge_size - title_height) / 2 - s(2)),
        title,
        font=title_font,
        fill=WIN if outcome == "win" else MUTED,
    )

    score_top = screen_top + s(218)
    score_width = s(280)
    score_left = center_x - score_width // 2
    role_font = font(10)
    value_font = font(25, True)
    self_score = "92" if outcome == "win" else "87"
    rival_score = "87" if outcome == "win" else "92"

    draw_centered(draw, (score_left / SCALE) + 70, (score_top / SCALE) + 2, "你", role_font, GREEN_48)
    draw_centered(
        draw,
        (score_left / SCALE) + 70,
        (score_top / SCALE) + 17,
        self_score,
        value_font,
        WIN if outcome == "win" else GREEN_72,
    )
    draw_centered(draw, (score_left / SCALE) + 210, (score_top / SCALE) + 2, "对手", role_font, GREEN_48)
    draw_centered(
        draw,
        (score_left / SCALE) + 210,
        (score_top / SCALE) + 17,
        rival_score,
        value_font,
        WIN if outcome == "loss" else GREEN_72,
    )
    draw.line(
        (
            center_x,
            score_top + s(2),
            center_x,
            score_top + s(32),
        ),
        fill=(76, 199, 115, 51),
        width=s(1),
    )

    hint_top = screen_bottom - s(22)
    draw.line(
        (screen_left, hint_top, screen_right, hint_top),
        fill=GREEN_22,
        width=s(1),
    )
    dot_x = center_x - s(42)
    dot_y = hint_top + s(10)
    draw.ellipse(
        (dot_x - s(2), dot_y - s(2), dot_x + s(2), dot_y + s(2)),
        fill=GREEN,
    )
    draw.text(
        (dot_x + s(8), hint_top + s(3)),
        "点按镜腿 · 确认离开",
        font=font(11),
        fill=GREEN_72,
    )


def main():
    canvas = Image.new(
        "RGB",
        (s(WIDTH * 2 + GAP), s(HEIGHT)),
        (7, 10, 11),
    )
    draw = ImageDraw.Draw(canvas, "RGBA")
    draw_frame(draw, 0, "win")
    draw_frame(draw, WIDTH + GAP, "loss")
    result = canvas.resize((WIDTH * 2 + GAP, HEIGHT), Image.Resampling.LANCZOS)
    output = Path(__file__).with_name("battle-result-design.png")
    result.save(output, format="PNG", optimize=True)
    print(output)


if __name__ == "__main__":
    main()
