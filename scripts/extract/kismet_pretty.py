"""Render a dump_kismet JSON export as readable pseudo-code.

Prints the class-default properties (the Blueprint's tunable numbers) followed by
every function's bytecode, one statement per line, prefixed with its byte offset
so jump targets can be followed by eye. Local temporaries keep their compiler
names (CallFunc_Multiply_..._ReturnValue) because those names say which node
produced them -- the expression a temporary was assigned from is printed where it's
assigned, not inlined, which is enough to read a damage formula.

Usage: python scripts/extract/kismet_pretty.py <dump.json> [--no-defaults]
"""
import json
import sys


def name_of(ref):
    """'Function'Lib:Multiply_DoubleDouble'' -> 'Multiply_DoubleDouble'."""
    if not ref:
        return '?'
    s = ref.get('ObjectName', '?') if isinstance(ref, dict) else str(ref)
    s = s.split("'")[1] if "'" in s else s
    return s.split(':')[-1].split('.')[-1]


def var_name(v):
    if 'Path' in v:
        return '.'.join(v['Path'])
    prop = v.get('Property') or {}
    return prop.get('Name', '?')


def fmt_num(x):
    return repr(round(x, 6)) if isinstance(x, float) else repr(x)


def expr(e):
    if e is None:
        return '<none>'
    t = e.get('Token', '?')
    if t in ('EX_LocalVariable', 'EX_LocalOutVariable', 'EX_DefaultVariable'):
        return var_name(e['Variable'])
    if t == 'EX_InstanceVariable':
        return 'self.' + var_name(e['Variable'])
    if t in ('EX_IntConst', 'EX_ByteConst', 'EX_Int64Const', 'EX_FloatConst', 'EX_DoubleConst'):
        return fmt_num(e['Value'])
    if t == 'EX_NameConst':
        return f"N'{e['Value']}'"
    if t == 'EX_StringConst':
        return json.dumps(e['Value'])
    if t == 'EX_TextConst':
        v = e['Value']
        return 'T' + json.dumps(v.get('SourceString') if isinstance(v, dict) else v)
    if t == 'EX_ObjectConst':
        return f"obj({name_of(e['Value'])})"
    if t == 'EX_SoftObjectConst':
        return f"soft({json.dumps(e['Value'])[:80]})"
    if t in ('EX_VectorConst', 'EX_RotationConst'):
        return f"{t[3:]}{json.dumps(e['Value'])}"
    if t == 'EX_True':
        return 'true'
    if t == 'EX_False':
        return 'false'
    if t in ('EX_NoObject', 'EX_Nothing'):
        return 'null'
    if t == 'EX_Self':
        return 'self'
    if t in ('EX_CallMath', 'EX_FinalFunction', 'EX_LocalFinalFunction',
             'EX_VirtualFunction', 'EX_LocalVirtualFunction'):
        fn = e['Function'] if isinstance(e['Function'], dict) else {'ObjectName': e['Function']}
        args = ', '.join(expr(p) for p in e.get('Parameters', []))
        return f"{name_of(fn)}({args})"
    if t in ('EX_Context', 'EX_ClassContext'):
        return f"{expr(e['ObjectExpression'])}->{expr(e['ContextExpression'])}"
    if t == 'EX_InterfaceContext':
        return expr(e['InterfaceValue'])
    if t == 'EX_StructMemberContext':
        return f"{expr(e['StructExpression'])}.{var_name(e['Property'])}"
    if t == 'EX_Cast':
        return f"cast<{e['ConversionType']}>({expr(e['Target'])})"
    if t in ('EX_DynamicCast', 'EX_MetaCast', 'EX_ObjToInterfaceCast'):
        return f"cast<{name_of(e['InterfaceClass'])}>({expr(e['Target'])})"
    if t == 'EX_StructConst':
        return f"{name_of(e['Struct'])}{{{', '.join(expr(p) for p in e['Properties'])}}}"
    if t == 'EX_ArrayConst':
        return '[' + ', '.join(expr(p) for p in e['Values']) + ']'
    if t == 'EX_ArrayGetByRef':
        return f"{expr(e['ArrayVariable'])}[{expr(e['ArrayIndex'])}]"
    if t == 'EX_SwitchValue':
        cases = '; '.join(f"{expr(c['CaseIndexValueTerm'])}: {expr(c['CaseTerm'])}" for c in e['Cases'])
        return f"switch({expr(e['IndexTerm'])}) {{{cases}; default: {expr(e['DefaultTerm'])}}}"
    if t == 'EX_CallMulticastDelegate':
        return f"broadcast {expr(e['Delegate'])}({', '.join(expr(p) for p in e.get('Parameters', []))})"
    if t == 'EX_SkipOffsetConst':
        return f"skip({e['Value']})"
    return f"<{t}>"


def stmt(e):
    t = e['Token']
    if t in ('EX_Let', 'EX_LetBool', 'EX_LetObj', 'EX_LetWeakObjPtr'):
        return f"{expr(e['Variable'])} = {expr(e['Expression'])}"
    if t == 'EX_LetValueOnPersistentFrame':
        return f"{name_of(e['DestinationProperty']) if 'ObjectName' in e['DestinationProperty'] else var_name(e['DestinationProperty'])} = {expr(e['AssignmentExpression'])}"
    if t == 'EX_JumpIfNot':
        return f"if not {expr(e['BooleanExpression'])}: goto {e['CodeOffset']}"
    if t == 'EX_Jump':
        return f"goto {e['CodeOffset']}"
    if t == 'EX_ComputedJump':
        return f"goto *{expr(e['CodeOffsetExpression'])}"
    if t == 'EX_PushExecutionFlow':
        return f"push {e['PushingAddress']}"
    if t == 'EX_PopExecutionFlow':
        return 'pop'
    if t == 'EX_PopExecutionFlowIfNot':
        return f"pop if not {expr(e['BooleanExpression'])}"
    if t == 'EX_Return':
        return f"return {expr(e['Expression'])}"
    if t == 'EX_EndOfScript':
        return None
    if t == 'EX_SetArray':
        return f"{expr(e['AssigningProperty'])} = [{', '.join(expr(x) for x in e['Elements'])}]"
    if t in ('EX_AddMulticastDelegate', 'EX_RemoveMulticastDelegate'):
        op = '+=' if t.startswith('EX_Add') else '-='
        return f"{expr(e['MulticastDelegate'])} {op} {expr(e['Delegate'])}"
    if t == 'EX_BindDelegate':
        return f"bind {expr(e['Delegate'])} -> {e['FunctionName']}"
    if t == 'EX_ClearMulticastDelegate':
        return f"clear {expr(e['DelegateToClear'])}"
    return expr(e)


def main():
    path = sys.argv[1]
    show_defaults = '--no-defaults' not in sys.argv
    exports = json.load(open(path, encoding='utf-8'))
    for ex in exports:
        if show_defaults and ex.get('Name', '').startswith('Default__'):
            props = {k: v for k, v in (ex.get('Properties') or {}).items()
                     if k not in ('UberGraphFrame',)}
            print(f"== defaults {ex['Name']}")
            print(json.dumps(props, indent=1))
    for ex in exports:
        if ex.get('Type') != 'Function' or not ex.get('ScriptBytecode'):
            continue
        print(f"\n== {ex['Name']}")
        for s in ex['ScriptBytecode']:
            line = stmt(s)
            if line is not None:
                print(f"  {s.get('StatementIndex', ''):>5}: {line}")


if __name__ == '__main__':
    main()
