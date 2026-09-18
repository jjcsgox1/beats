"""
Draws the home-screen icon.

iOS will not use an SVG for "Add to Home Screen", so there has to be a PNG, and
a PNG checked into a repository is a file nobody can correct later without
opening an image editor. This script is the source; `apple-touch-icon.png` is
its output. Change the drawing here and run it again:

    py -3 tools/make-icon.py

Nothing is imported that does not ship with Python — a PNG is a header, some
zlib, and a length-prefixed chunk, and writing those three directly is less
trouble than depending on an imaging library the phone will never see.

The picture is the thing the app measures: a tone whose loudness swells and
fades because two partials are drifting in and out of step. The pinch points
are where they cancel.
"""

import math
import os
import struct
import zlib

SIZE = 180          # what iOS asks for
SS = 3              # supersampling, for edges that are not staircases

BG = (0x12, 0x13, 0x0f)
CARRIER = (0xb9, 0xd9, 0x8a)
ENVELOPE = (0x5c, 0x61, 0x53)

CARRIER_CYCLES = 7.0     # oscillations across the icon
BEAT_CYCLES = 1.5        # swells across the icon
MARGIN = 0.14            # fraction of the width left clear on each side


def carrier_y(t):
    """Height of the wave at `t` in 0..1, as a fraction of half the icon."""
    env = abs(math.cos(math.pi * BEAT_CYCLES * (2 * t - 1)))
    return env * math.sin(2 * math.pi * CARRIER_CYCLES * t)


def envelope_y(t):
    return abs(math.cos(math.pi * BEAT_CYCLES * (2 * t - 1)))


def draw():
    w = h = SIZE * SS
    pix = [[BG] * w for _ in range(h)]

    left = MARGIN * w
    right = w - left
    span = right - left
    mid = h / 2.0
    amp = h * 0.33

    def stroke(fn, colour, thickness, signs=(1,)):
        """Paint y = fn(t), scaled, as a line of `thickness` device pixels.

        Walked column by column rather than by distance to the curve: the curve
        is a function of x, so the only place a vertical band is too thin is
        where the slope is steep, and widening by sqrt(1 + slope^2) corrects
        exactly that.
        """
        half = thickness * SS / 2.0
        step = 1.0 / span
        for px in range(int(left), int(right) + 1):
            t = (px - left) / span
            for sign in signs:
                y = mid - sign * fn(t) * amp
                ahead = mid - sign * fn(min(1.0, t + step)) * amp
                slope = (ahead - y) / 1.0
                reach = half * math.sqrt(1.0 + slope * slope)
                lo = max(0, int(math.floor(y - reach)))
                hi = min(h - 1, int(math.ceil(y + reach)))
                for py in range(lo, hi + 1):
                    pix[py][px] = colour

    def fill(fn, colour):
        """Paint everything between +fn and -fn.

        The wave inside the swell was drawn here at first and had to go: at the
        size this is actually looked at — a home screen, about sixty pixels — a
        carrier of seven cycles is not a wave, it is a smudge. What survives
        being shrunk is the outline, so that is all this draws."""
        for px in range(int(left), int(right) + 1):
            t = (px - left) / span
            reach = fn(t) * amp
            lo = max(0, int(round(mid - reach)))
            hi = min(h - 1, int(round(mid + reach)))
            for py in range(lo, hi + 1):
                pix[py][px] = colour

    fill(envelope_y, CARRIER)

    # Average each supersampled block down to one pixel.
    out = bytearray()
    for y in range(SIZE):
        out.append(0)  # PNG filter: none
        for x in range(SIZE):
            r = g = b = 0
            for dy in range(SS):
                row = pix[y * SS + dy]
                for dx in range(SS):
                    c = row[x * SS + dx]
                    r += c[0]; g += c[1]; b += c[2]
            n = SS * SS
            out += bytes((r // n, g // n, b // n))
    return bytes(out)


def chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))


def main():
    raw = draw()
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(here, "apple-touch-icon.png")
    with open(path, "wb") as f:
        f.write(png)
    print("wrote %s, %d bytes" % (path, len(png)))


if __name__ == "__main__":
    main()
