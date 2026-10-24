"""Selección pura del siguiente split de oficina (sin efectos de herdr)."""

def choose_split(panes, coordinator_pane):
    """panes en orden de antigüedad: [{'pane_id': ..., 'rect': {width,height,...}}]."""
    if not panes or panes[0]['pane_id'] != coordinator_pane:
        raise ValueError('Pane principal ausente o fuera de orden')
    if len(panes) == 1:
        return coordinator_pane, 'right', 0.6
    offices = panes[1:]
    for pane in offices:
        rect = pane['rect']
        if rect['width'] <= 0 or rect['height'] <= 0:
            raise ValueError('Geometría inválida')
    # max elige el último elemento ante igualdad: la oficina más reciente.
    largest = max(range(len(offices)), key=lambda i: (offices[i]['rect']['width'] * offices[i]['rect']['height'], i))
    pane = offices[largest]
    rect = pane['rect']
    direction = 'right' if rect['width'] > 2 * rect['height'] else 'down'
    return pane['pane_id'], direction, 0.5
