"""Fail-closed, secret-free configuration shared by the office Python CLI.

The path is explicit (--equipo), inherited (PI_OFICINAS_EQUIPO), or local to
this package. Never resolve a missing file against the caller's cwd.
"""
import json
import os
import pwd
from pathlib import Path
import re
import stat

ROOT = Path(__file__).resolve().parents[1]
# Source checkout owns a canonical legacy config; a vendored team package owns
# only its parent's config. Neither case selects a foreign cwd silently.
DEFAULT_PATH = ROOT / 'equipo.json' if (ROOT / 'equipo.json').is_file() else ROOT.parent / 'equipo.json'
FIELDS = frozenset(('version', 'lider', 'lider_key_env', 'office_key_prefix',
                    'base', 'lider_body', 'oficinas', 'distribucion', 'soul_prefix'))
OPTIONAL_FIELDS = frozenset(('souls', 'secretaria', 'pi_bin', 'relanzar_modo',
                            'pi_coding_agent_dir', 'pi_coding_session_dir'))
SECRETARIA_BOOL_FIELDS = frozenset(('monitor', 'avisos', 'contexto', 'correo', 'correo_respaldo'))
SECRETARIA_RANGES = {'quiet_min': (1, 1440), 'parada_min': (1, 1440), 'pegada_min': (1, 1440),
                     'reentrada_cooldown_min': (60, 1440), 'contexto_aviso': (1, 99),
                     'contexto_ttl_min': (1, 1440), 'gracia_min': (0, 60), 'correo_cada_min': (1, 1440),
                     'correo_tope_diario': (1, 1000), 'correo_tope_hora': (1, 100), 'confirmacion_min': (1, 1440)}
NAME = re.compile(r'[a-z][a-z0-9-]{0,39}\Z')
ENV = re.compile(r'[A-Z][A-Z0-9_]*\Z')
SOUL = re.compile(r'50 Agents/[A-Za-z0-9 -]+(?:/[A-Za-z0-9 -]+)*\Z')
SOUL_FILE = re.compile(r'50 Agents/[A-Za-z0-9 -]+(?:/[A-Za-z0-9 -]+)*/SOUL\.md\Z')


def soul_path(config, agent):
    return config.get('souls', {}).get(agent) or f"{config['soul_prefix']}/{agent}/Vigente/SOUL.md"



def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f'clave duplicada: {key}')
        result[key] = value
    return result


def _real_path(value, *, directory=False):
    if not isinstance(value, str) or not value or '\x00' in value:
        raise ValueError('ruta ausente/inválida')
    path = Path(value)
    if not path.is_absolute() or '..' in path.parts or str(path) != value:
        raise ValueError('ruta debe ser absoluta, normalizada y sin traversal')
    for parent in (path, *path.parents):
        if parent.is_symlink():
            raise ValueError(f'ruta con symlink: {parent}')
    if directory and (not path.is_dir() or not stat.S_ISDIR(path.stat().st_mode)):
        raise ValueError(f'directorio inexistente: {path}')
    return path


def load_equipo(path=None, *, legacy_anchor=None):
    selected = path if path is not None else os.environ.get('PI_OFICINAS_EQUIPO')
    if not selected:
        raise ValueError('Usar --equipo o PI_OFICINAS_EQUIPO; no hay equipo implícito')
    implicit = path is None and not os.environ.get('PI_OFICINAS_EQUIPO')
    source = _real_path(str(selected))
    if not source.is_file() or not stat.S_ISREG(source.stat().st_mode):
        raise ValueError(f'config de equipo inexistente/no regular: {source}')
    if source.stat().st_uid != os.getuid() or source.stat().st_mode & 0o022:
        raise ValueError('config de equipo no pertenece al usuario o escribible por grupo/otros')
    try:
        data = json.loads(source.read_text(encoding='utf-8'), object_pairs_hook=_unique)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f'config de equipo inválida: {exc}') from exc
    if (not isinstance(data, dict) or not FIELDS.issubset(data) or
            data.keys() - FIELDS - OPTIONAL_FIELDS or
            type(data['version']) is not int or data['version'] != 2):
        raise ValueError('config de equipo: esquema version 2 exacto requerido')
    if 'secretaria' in data:
        secretaria = data['secretaria']
        if (not isinstance(secretaria, dict) or
                set(secretaria) - SECRETARIA_BOOL_FIELDS - SECRETARIA_RANGES.keys() or
                any(type(secretaria.get(key)) is not bool for key in SECRETARIA_BOOL_FIELDS if key in secretaria) or
                any(type(secretaria.get(key)) is not int or
                    not SECRETARIA_RANGES[key][0] <= secretaria[key] <= SECRETARIA_RANGES[key][1]
                    for key in SECRETARIA_RANGES if key in secretaria)):
            raise ValueError('secretaria inválida: flags booleanos y umbrales dentro de rango')
    lider = data['lider']
    offices = data['oficinas']
    if not isinstance(lider, str) or not NAME.fullmatch(lider):
        raise ValueError('lider inválido')
    if (not isinstance(offices, list) or not offices or len(offices) > 20
            or any(not isinstance(n, str) or not NAME.fullmatch(n) for n in offices)
            or len(set(offices)) != len(offices) or lider in offices):
        raise ValueError('oficinas inválidas, repetidas o incluyen líder')
    for key in ('lider_key_env', 'office_key_prefix'):
        value = data[key]
        if not isinstance(value, str) or not ENV.fullmatch(value):
            raise ValueError(f'{key} inválido')
    if not data['office_key_prefix'].endswith('_'):
        raise ValueError('office_key_prefix debe terminar en _')
    if data['lider_key_env'] in {data['office_key_prefix'] + n.upper().replace('-', '_') for n in offices}:
        raise ValueError('key líder colisiona con variable de oficina')
    soul = data['soul_prefix']
    if not isinstance(soul, str) or not SOUL.fullmatch(soul) or '..' in soul.split('/'):
        raise ValueError('soul_prefix inválido')
    souls = data.get('souls', {})
    if (not isinstance(souls, dict) or
            any(agent not in {lider, *offices} or not isinstance(path, str) or
                not SOUL_FILE.fullmatch(path) or '..' in path.split('/')
                for agent, path in souls.items())):
        raise ValueError('souls inválido: roles propios y rutas dentro del vault terminadas en SOUL.md')
    base = _real_path(data['base'], directory=True)
    body = _real_path(data['lider_body'], directory=True)
    if 'relanzar_modo' in data and data['relanzar_modo'] not in ('fresco', 'retomar'):
        raise ValueError('relanzar_modo debe ser fresco o retomar')
    if 'pi_bin' in data:
        expected_pi_bin = str(base / 'runtime' / 'node_modules' / '.bin' / 'pi')
        if not isinstance(data['pi_bin'], str) or data['pi_bin'] != expected_pi_bin:
            raise ValueError('pi_bin debe ser <base>/runtime/node_modules/.bin/pi; no usar pin global')
    if 'pi_coding_agent_dir' in data and data['pi_coding_agent_dir'] != '.pi-agent':
        raise ValueError('pi_coding_agent_dir debe ser .pi-agent; sin la clave pi usa ~/.pi/agent')
    if 'pi_coding_session_dir' in data and data['pi_coding_session_dir'] != 'sessions':
        raise ValueError('pi_coding_session_dir debe ser sessions bajo cada cuerpo')
    if body == base or not body.is_relative_to(base):
        raise ValueError('lider_body fuera de base')
    distribution = data['distribucion']
    if (not isinstance(distribution, str) or not re.fullmatch(r'[A-Za-z0-9_-]+\.json', distribution)):
        raise ValueError('distribucion debe ser nombre de archivo JSON bajo base')
    _real_path(str(base / distribution))
    _real_path(str(base / 'registro.json'))
    for name in offices:
        _real_path(str(base / name))
    return data


def paths(config):
    base = Path(config['base'])
    return base, Path(config['lider_body']), base / 'registro.json', base / config['distribucion']
