"""Read native C++ class defaults (CDOs) out of the running game.

Some tuning values are set in C++ constructors and never serialised into the
.pak (e.g. Chain Lightning's ChainCount/Range on URBehaviorScriptLightning), so
dump_kismet can't see them. They do exist in memory: every native class has a
Default__<Class> object holding its constructor values. This reads those objects
read-only with ReadProcessMemory (read_cdos.ps1) and decodes the plain fields,
inherited RGame fields included (int32/float/double/bool, and FRMutableFloat/
FRMutableInteger's base `Value`, F*WeaponSetting's `BaseValue`), using the offsets in the Dumper-7 SDK.

Needs: the game running, and a Dumper-7 dump from the SAME game build (the
GObjects offset and class indices come from it; read_cdos.ps1 reaches each CDO
through its class and skips anything that doesn't verify).

Remember a Blueprint subclass's CDO can override these -- check its serialised
`Default__BP_*` properties (dump_kismet) before trusting a native value.

Usage: python scripts/extract/native_defaults.py <Dumper-7 dir> <out.json> <Class> [<Class> ...]
       e.g. ... C:/Dumper-7/5.6.1-0+UE5-RGame native.json RBehaviorScriptLightning
"""
import json
import re
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).parent
FIELD = re.compile(r'\s*(int32|float|double|bool|struct FRMutableFloat|struct FRMutableInteger'
                   r'|struct FFloatWeaponSetting|struct FIntegerWeaponSetting)'
                   r'\s+(\w+)(?::\s*1)?;\s*// 0x([0-9A-F]+)\(')


def gobjects_offset(sdk_dir: Path) -> int:
    basic = (sdk_dir / 'CppSDK/SDK/Basic.hpp').read_text(encoding='utf-8')
    return int(re.search(r'GObjects\s*=\s*(0x[0-9A-Fa-f]+)', basic).group(1), 16)


def class_index(dump: str, cls: str) -> str:
    m = re.search(r'^\[([0-9A-F]+)\] \{0x[0-9a-f]+\} Class RGame\.' + cls + r'$', dump, re.M)
    if not m:
        raise SystemExit(f'not in GObjects-Dump.txt: {cls}')
    return m.group(1)


def class_layout(classes_hpp: str, cls: str):
    """(size, [(type, name, offset)]) for `class U<cls>`/`A<cls>` in the SDK,
    including fields inherited from RGame parents (engine base classes have
    nothing worth decoding)."""
    m = re.search(r'^// 0x[0-9A-F]+ \(0x([0-9A-F]+) - 0x[0-9A-F]+\)\nclass [UA]' + cls +
                  r'(?: final)? : public [UA](\w+)\n\{(.*?)\n\};', classes_hpp, re.S | re.M)
    if not m:
        raise SystemExit(f'not in SDK: {cls}')
    size, parent, body = int(m.group(1), 16), m.group(2), m.group(3)
    fields = []
    if re.search(r'^class [UA]' + parent + r'(?: final)? : ', classes_hpp, re.M) and parent.startswith('R'):
        fields = class_layout(classes_hpp, parent)[1]
    for line in body.splitlines():
        f = FIELD.match(line)
        if f and not f.group(2).startswith(('Pad', 'Cached')):
            fields.append((f.group(1), f.group(2), int(f.group(3), 16)))
    return size, fields


def decode(buf: bytes, fields):
    out = {}
    for t, name, off in fields:
        if t == 'int32':
            out[name] = struct.unpack_from('<i', buf, off)[0]
        elif t == 'float':
            out[name] = round(struct.unpack_from('<f', buf, off)[0], 6)
        elif t == 'double':
            out[name] = struct.unpack_from('<d', buf, off)[0]
        elif t == 'bool':
            out[name] = bool(buf[off])
        elif t == 'struct FRMutableFloat':   # CurrentValue, Value, AbsoluteValue
            out[name] = round(struct.unpack_from('<f', buf, off + 4)[0], 6)
        elif t == 'struct FRMutableInteger':
            out[name] = struct.unpack_from('<i', buf, off + 4)[0]
        elif t == 'struct FFloatWeaponSetting':  # BaseValue first
            out[name] = round(struct.unpack_from('<f', buf, off)[0], 6)
        elif t == 'struct FIntegerWeaponSetting':
            out[name] = struct.unpack_from('<i', buf, off)[0]
    return out


def main():
    sdk_dir, out_path, classes = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3:]
    dump = (sdk_dir / 'GObjects-Dump.txt').read_text(encoding='utf-8', errors='replace')
    classes_hpp = (sdk_dir / 'CppSDK/SDK/RGame_classes.hpp').read_text(encoding='utf-8')

    layouts, targets = {}, []
    for cls in classes:
        size, fields = class_layout(classes_hpp, cls)
        layouts[cls] = fields
        targets.append(f'{cls}:{class_index(dump, cls)}:{size:X}')

    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(['pwsh', '-NoProfile', '-File', str(HERE / 'read_cdos.ps1'),
                        '-OutDir', tmp, '-GObjectsOffset', str(gobjects_offset(sdk_dir)),
                        '-Targets', ','.join(targets)], check=True)
        result = {}
        for cls in classes:
            f = Path(tmp) / f'{cls}.bin'
            if not f.exists():
                print(f'skipped {cls}: CDO did not verify (stale Dumper-7 dump?)')
                continue
            result[cls] = decode(f.read_bytes(), layouts[cls])

    out_path.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(f'wrote {out_path} ({len(result)}/{len(classes)} classes)')


if __name__ == '__main__':
    main()
