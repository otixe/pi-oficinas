"""Pure canonical L geometry and move plan. Ratios describe the existing child."""
# Callers supply the validated team's office order. No installation-specific roster.
ORDER = ()


def leader_width(geometry):
    if 'lider_ancho' in geometry:
        return geometry['lider_ancho']
    raise ValueError('geometria sin lider_ancho')

# Conservative terminal-cell floor: reject layouts too small before any Herdr move.
MIN_PANE_WIDTH = 10
MIN_PANE_HEIGHT = 3


def validate_layout(area, geometry):
    """Reject declared L cells that cannot fit a usable terminal in this area."""
    names = geometry['columna_derecha'] + geometry['franja_inferior']
    if not geometry['columna_derecha']:
        raise ValueError('geometria: columna_derecha requiere al menos una oficina')
    if len(geometry['columna_derecha']) > 10 or len(geometry['franja_inferior']) > 10:
        raise ValueError('geometria: split ratio inferior a 0.1')
    cells = expected_rects(names, 'lider', area, geometry)
    if any(w < MIN_PANE_WIDTH or h < MIN_PANE_HEIGHT for _, _, w, h in cells.values()):
        raise ValueError('geometria: celdas inferiores al mínimo de 10 columnas x 3 filas')


def plan(names, leader, geometry=None):
    """Return (name, target pane/name, direction, existing-child ratio)."""
    geometry = geometry or {'lider_ancho': .6, 'franja_superior_alto': .7,
                            'columna_derecha': ORDER[:3], 'franja_inferior': ORDER[3:]}
    right = [name for name in geometry['columna_derecha'] if name in names]
    bottom = [name for name in geometry['franja_inferior'] if name in names]
    steps = []
    if geometry.get('tipo') == 'C':
        # Columna derecha a todo el alto; la última oficina es la esquina.
        if right:
            steps.append((right[0], leader, 'right', leader_width(geometry)))
            top = right[:-1] if len(right) > 1 else right
            if len(right) > 1:
                steps.append((right[-1], right[0], 'down', geometry['franja_superior_alto']))
            for index, name in enumerate(top[1:], 1):
                steps.append((name, top[index - 1], 'down', 1 / (len(top) - index + 1)))
        if bottom:
            steps.append((bottom[0], leader, 'down', geometry['franja_superior_alto']))
            for index, name in enumerate(bottom[1:], 1):
                steps.append((name, bottom[index - 1], 'right', 1 / (len(bottom) - index + 1)))
        return steps
    if bottom:
        steps.append((bottom[0], leader, 'down', geometry['franja_superior_alto']))
        for index, name in enumerate(bottom[1:], 1):
            steps.append((name, bottom[index - 1], 'right', 1 / (len(bottom) - index + 1)))
    if right:
        steps.append((right[0], leader, 'right', leader_width(geometry)))
        for index, name in enumerate(right[1:], 1):
            steps.append((name, right[index - 1], 'down', 1 / (len(right) - index + 1)))
    return steps


def expected_rects(names, leader, area, geometry=None):
    """Cell rounding follows Herdr's round(area * ratio) for positive cells."""
    geometry = geometry or {'lider_ancho': .6, 'franja_superior_alto': .7,
                            'columna_derecha': ORDER[:3], 'franja_inferior': ORDER[3:]}
    names = [name for name in (*geometry['columna_derecha'], *geometry['franja_inferior']) if name in names]
    x, y, width, height = (area[k] for k in ('x', 'y', 'width', 'height'))
    if not names:
        return {leader: (x, y, width, height)}
    right = [name for name in geometry['columna_derecha'] if name in names]
    bottom = [name for name in geometry['franja_inferior'] if name in names]
    top_h = int(height * geometry['franja_superior_alto'] + .5) if bottom else height
    left_w = int(width * leader_width(geometry) + .5) if right else width
    rects = {leader: (x, y, left_w, top_h)}
    def spread(items, start_x, start_y, w, h, axis):
        for index, name in enumerate(items):
            remaining = len(items) - index
            length = (int((w if axis == 'right' else h) / remaining + .5)
                      if remaining > 1 else (w if axis == 'right' else h))
            rects[name] = (start_x, start_y, length if axis == 'right' else w,
                           length if axis == 'down' else h)
            if axis == 'right':
                start_x += length
                w -= length
            else:
                start_y += length
                h -= length
    if geometry.get('tipo') == 'C':
        split_h = int(height * geometry['franja_superior_alto'] + .5)
        corner = len(right) > 1
        rects[leader] = (x, y, left_w, split_h if bottom else height)
        top = right[:-1] if corner else right
        spread(top, x + left_w, y, width - left_w, split_h if corner else height, 'down')
        if corner:
            rects[right[-1]] = (x + left_w, y + split_h, width - left_w, height - split_h)
        if bottom:
            spread(bottom, x, y + split_h, left_w, height - split_h, 'right')
        return rects
    spread(right, x + left_w, y, width - left_w, top_h, 'down')
    if bottom:
        spread(bottom, x, y + top_h, width, height - top_h, 'right')
    return rects
