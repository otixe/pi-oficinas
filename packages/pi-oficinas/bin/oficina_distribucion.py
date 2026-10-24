"""Validated, optional user-owned distribution. Never write this file."""
import json
import math
import stat
from pathlib import Path

from equipo_config import load_equipo


def read_distribution(path, equipo=None):
    team = equipo or load_equipo()
    agents = tuple(team['oficinas'])
    leader = team['lider']
    path = Path(path)
    if not path.exists() and not path.is_symlink():
        raise ValueError(f'distribucion.json inexistente ({path})')
    try:
        if stat.S_ISLNK(path.lstat().st_mode):
            raise ValueError('enlace simbólico no permitido')
        def unique_pairs(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError(f'clave duplicada: {key}')
                value[key] = item
            return value
        config = json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=unique_pairs)
        if (not isinstance(config, dict) or type(config.get('version')) is not int
                or config['version'] != 2
                or set(config) != {'version', 'pestana', 'nombres', 'geometria'}):
            raise ValueError('distribución: esquema exacto requerido (metadata legacy v1 admitida)')
        names = config['nombres']
        geometry = config['geometria']
        if not isinstance(names, dict) or not isinstance(geometry, dict):
            raise ValueError('nombres y geometria deben ser objetos')
        def label(value):
            return (isinstance(value, str) and 0 < len(value) <= 40 and value.strip()
                    and len(value.splitlines()) <= 1 and not any(c in value for c in '\r\n'))
        if not label(config['pestana']):
            raise ValueError('pestana debe ser texto no vacío, sin saltos y de hasta 40 caracteres')
        if any(k not in (*agents, leader) or not label(v) for k, v in names.items()):
            raise ValueError('nombres: agentes inválidos o labels fuera de rango')
        if geometry.get('tipo') not in ('L', 'C'):
            raise ValueError('geometria.tipo debe ser L o C')
        if geometry.get('tipo') == 'C' and len(geometry.get('columna_derecha') or []) < 2:
            raise ValueError('geometria C: columna_derecha requiere al menos 2 (la ultima es la esquina)')
        if set(geometry) != {'tipo', 'lider_ancho', 'franja_superior_alto',
                             'columna_derecha', 'franja_inferior'}:
            raise ValueError('v2 requiere campos exactos y lider_ancho')
        for key in ('lider_ancho', 'franja_superior_alto'):
            value = geometry.get(key)
            if type(value) not in (float, int) or not math.isfinite(value) or not .1 <= value <= .9:
                raise ValueError(f'geometria.{key} debe estar entre 0.1 y 0.9')
        right, bottom = (geometry.get('columna_derecha'), geometry.get('franja_inferior'))
        if not isinstance(right, list) or not isinstance(bottom, list) or not right:
            raise ValueError('geometria: columna_derecha requiere al menos una oficina; franja_inferior debe ser lista')
        if len(right) > 10 or len(bottom) > 10:
            raise ValueError('geometria: split ratio inferior a 0.1')
        if any(type(n) is not str or n not in agents for n in right + bottom) or len(set(right + bottom)) != len(right + bottom) or set(right + bottom) != set(agents):
            raise ValueError('geometria: agentes fuera de equipo, duplicados o ausentes')
        config['geometria'] = geometry
        return config
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError, TypeError) as exc:
        raise ValueError(f'distribucion.json inválido ({path}): {exc}') from exc
