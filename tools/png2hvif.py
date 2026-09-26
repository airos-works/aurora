#!/usr/bin/env python3
"""Trace a PNG app icon into a Haiku vector icon (HVIF).

Electron apps ship bitmap icons; Haiku draws vector ones at every size. This
reduces the image to a few flat colours and traces each as polygons:

    python3 tools/png2hvif.py icon.png icon.hvif [--colors 4] [--preview out.png]

Colours are layered from the largest area up, and every layer also covers the
area of the layers drawn over it, so the result has no gaps between colours.
Background showing through (transparent pixels) becomes holes, traced with the
opposite winding, which Haiku's renderer leaves empty under either fill rule.
"""
import argparse
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hvif  # noqa: E402

TRACE_SIZE = 256
MAX_POINTS = 250


def quantize(image, colors):
    """Returns (index map, palette); index -1 is transparent."""
    rgba = image.convert('RGBA').resize((TRACE_SIZE, TRACE_SIZE), Image.LANCZOS)
    alpha = rgba.getchannel('A')
    # Quantize only opaque pixels: put transparent ones in a colour that is
    # removed afterwards.
    rgb = Image.new('RGB', rgba.size, (0, 0, 0))
    rgb.paste(rgba.convert('RGB'), mask=alpha)
    quantized = rgb.quantize(colors=colors, method=Image.Quantize.MEDIANCUT)
    palette = quantized.getpalette()[: colors * 3]
    indices = list(quantized.getdata())
    alphas = list(alpha.getdata())
    grid = [[-1] * TRACE_SIZE for _ in range(TRACE_SIZE)]
    for y in range(TRACE_SIZE):
        for x in range(TRACE_SIZE):
            if alphas[y * TRACE_SIZE + x] >= 128:
                grid[y][x] = indices[y * TRACE_SIZE + x]
    # Each colour is the median of its pixels: anti-aliased edges would pull a
    # mean towards its neighbours (white lines turning grey).
    samples = [[] for _ in range(colors)]
    pixels = list(rgba.getdata())
    for position, index in enumerate(indices):
        if alphas[position] >= 250:
            samples[index].append(pixels[position][:3])
    colours = []
    for index in range(colors):
        if samples[index]:
            channels = list(zip(*samples[index]))
            colours.append(tuple(sorted(channel)[len(channel) // 2] for channel in channels))
        else:
            colours.append(tuple(palette[index * 3:index * 3 + 3]))
    return grid, colours


def trace(mask):
    """Closed loops of pixel edges around the True cells, inside on the left."""
    size = len(mask)
    inside = lambda x, y: 0 <= x < size and 0 <= y < size and mask[y][x]  # noqa: E731
    # Directed edges on the corner lattice: from -> [to, ...].
    edges = {}

    def add(a, b):
        edges.setdefault(a, []).append(b)

    for y in range(size):
        for x in range(size):
            if not mask[y][x]:
                continue
            if not inside(x, y - 1):
                add((x + 1, y), (x, y))          # top edge, right to left
            if not inside(x, y + 1):
                add((x, y + 1), (x + 1, y + 1))  # bottom edge, left to right
            if not inside(x - 1, y):
                add((x, y), (x, y + 1))          # left edge, downward
            if not inside(x + 1, y):
                add((x + 1, y + 1), (x + 1, y))  # right edge, upward

    def turn(incoming, outgoing):
        # z of the cross product: positive turns left in screen coordinates... here
        # y grows downwards, so a positive value is a clockwise (right) turn.
        return incoming[0] * outgoing[1] - incoming[1] * outgoing[0]

    loops = []
    while edges:
        start = next(iter(edges))
        point = start
        direction = None
        loop = []
        while True:
            candidates = edges.get(point)
            if not candidates:
                break
            if len(candidates) > 1 and direction is not None:
                # Two pixels touching at a corner: keep them apart by always
                # taking the sharper turn towards the inside.
                candidates.sort(key=lambda target: turn(direction, (target[0] - point[0], target[1] - point[1])))
            following = candidates.pop(0)
            if not candidates:
                del edges[point]
            loop.append(point)
            direction = (following[0] - point[0], following[1] - point[1])
            point = following
            if point == start and (start not in edges):
                break
        if len(loop) >= 4:
            loops.append(loop)
    return loops


def area(loop):
    return sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(loop, loop[1:] + loop[:1])) / 2.0


def simplify(points, epsilon):
    """Douglas-Peucker on a closed polygon."""
    if len(points) < 4:
        return points

    def distance(p, a, b):
        (px, py), (ax, ay), (bx, by) = p, a, b
        dx, dy = bx - ax, by - ay
        if dx == dy == 0:
            return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
        return abs(dy * px - dx * py + bx * ay - by * ax) / (dx * dx + dy * dy) ** 0.5

    def reduce(section):
        stack = [(0, len(section) - 1)]
        keep = {0, len(section) - 1}
        while stack:
            first, last = stack.pop()
            best, index = 0.0, None
            for i in range(first + 1, last):
                d = distance(section[i], section[first], section[last])
                if d > best:
                    best, index = d, i
            if index is not None and best > epsilon:
                keep.add(index)
                stack.append((first, index))
                stack.append((index, last))
        return [section[i] for i in sorted(keep)]

    # Split the ring at its farthest point from the start to reduce it as two chains.
    far = max(range(len(points)), key=lambda i: (points[i][0] - points[0][0]) ** 2 + (points[i][1] - points[0][1]) ** 2)
    first = reduce(points[:far + 1])
    second = reduce(points[far:] + [points[0]])
    return first[:-1] + second[:-1]


def build(image_path, colors, epsilon, min_area):
    grid, palette = quantize(Image.open(image_path), colors)
    counts = [0] * len(palette)
    for row in grid:
        for index in row:
            if index >= 0:
                counts[index] += 1
    order = [i for i in sorted(range(len(palette)), key=lambda i: -counts[i]) if counts[i]]
    rank = {index: position for position, index in enumerate(order)}
    icon = {'styles': [], 'paths': [], 'shapes': []}
    scale = 64.0 / TRACE_SIZE
    for position, index in enumerate(order):
        # This layer and everything drawn over it.
        mask = [[cell >= 0 and rank[cell] >= position for cell in row] for row in grid]
        paths = []
        for loop in trace(mask):
            if abs(area(loop)) < min_area:
                continue
            reduced = simplify(loop, epsilon)
            while len(reduced) > MAX_POINTS:
                epsilon_here = epsilon * 1.5
                reduced = simplify(loop, epsilon_here)
                epsilon = epsilon_here
            if len(reduced) < 3:
                continue
            icon['paths'].append({'closed': True, 'points': [(x * scale, y * scale) for x, y in reduced]})
            paths.append(len(icon['paths']) - 1)
        if not paths:
            continue
        r, g, b = palette[index]
        icon['styles'].append({'color': (r, g, b, 255)})
        icon['shapes'].append({'style': len(icon['styles']) - 1, 'paths': paths})
    return icon


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('png')
    parser.add_argument('hvif')
    parser.add_argument('--colors', type=int, default=4)
    parser.add_argument('--epsilon', type=float, default=1.2, help='simplification, in trace pixels (of 256)')
    parser.add_argument('--min-area', type=float, default=24.0, help='smallest loop kept, in trace pixels')
    parser.add_argument('--preview')
    arguments = parser.parse_args()
    icon = build(arguments.png, arguments.colors, arguments.epsilon, arguments.min_area)
    data = hvif.encode(icon)
    with open(arguments.hvif, 'wb') as output:
        output.write(data)
    points = sum(len(path['points']) for path in icon['paths'])
    print(f'{arguments.hvif}: {len(data)} bytes, {len(icon["shapes"])} colours, {len(icon["paths"])} paths, {points} points')
    if arguments.preview:
        preview_even_odd(icon, 256).save(arguments.preview)


def preview_even_odd(icon, size):
    """A host preview that honours holes (hvif.preview fills every path)."""
    from PIL import ImageChops, ImageDraw
    image = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    unit = size / 64.0
    for shape in icon['shapes']:
        mask = Image.new('1', (size, size), 0)
        for index in shape['paths']:
            polygon = Image.new('1', (size, size), 0)
            ImageDraw.Draw(polygon).polygon([(x * unit, y * unit) for x, y in icon['paths'][index]['points']], fill=1)
            mask = ImageChops.logical_xor(mask, polygon)
        layer = Image.new('RGBA', (size, size), icon['styles'][shape['style']]['color'])
        image.paste(layer, (0, 0), mask.convert('L'))
    return image


if __name__ == '__main__':
    main()
