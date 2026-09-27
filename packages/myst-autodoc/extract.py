"""Static Griffe extraction. Read configuration from stdin, emit versioned JSON."""

import json
import logging
import sys
from types import SimpleNamespace

import griffe


def extract(config):
    parser = config.get("parser", "numpy")
    markup = config.get("markup", "myst")
    if parser not in ("numpy", "google", "sphinx"):
        raise ValueError(f"Unsupported docstring parser: {parser}")
    if markup not in ("myst", "rst"):
        raise ValueError(f"Unsupported docstring markup: {markup}")
    loader = griffe.GriffeLoader(
        search_paths=config.get("searchPaths"), docstring_parser=parser,
        allow_inspection=False,
    )
    modules = [loader.load(name) for name in config["modules"]]
    loader.resolve_aliases(implicit=False, external=False)
    objects = {}

    def prose(value):
        if markup == "myst" or not value.strip():
            return value
        from rst_to_myst import rst_to_myst
        from rst_to_myst.mdformat_render import AdditionalRenderers
        from mdformat.plugins import PARSER_EXTENSIONS
        from mdformat.renderer import MDRenderer

        output = rst_to_myst(value, use_sphinx=False, default_role="autolink")
        warnings = [line for line in output.warning_stream.getvalue().splitlines()
                    if line and "Treating doctest block as pycon literal block" not in line]
        if warnings:
            raise ValueError("Unsupported RST: " + "\n".join(warnings))

        def role(node, _context):
            name = node.meta["name"].removeprefix("py:")
            if name not in {"func", "class", "meth", "attr", "mod", "data", "obj", "autolink"}:
                raise ValueError(f"Unsupported RST role: {name}")
            if name == "autolink":
                # Ordinary RST default-role identifiers can be local variables.
                return f"`{node.content}`"
            return "{py:" + name + "}`" + node.content + "`"

        myst = PARSER_EXTENSIONS["myst"]
        renderers = SimpleNamespace(RENDERERS={**myst.RENDERERS, "myst_role": role},
                                    POSTPROCESSORS=getattr(myst, "POSTPROCESSORS", {}))
        return MDRenderer().render(output.tokens, {
            "parser_extension": [PARSER_EXTENSIONS[n] for n in ("tables", "frontmatter", "deflist")]
            + [AdditionalRenderers, renderers], "mdformat": {"number": True},
        }, output.env)

    def sections(obj):
        result = []
        for section in obj.docstring.parsed if obj.docstring else []:
            kind = section.kind.value
            record = {"kind": kind, "title": section.title}
            if kind == "text":
                record["text"] = prose(section.value)
            elif kind == "examples":
                record["blocks"] = [
                    {"kind": k.value, "text": prose(v) if k.value == "text" else v}
                    for k, v in section.value
                ]
            elif kind in ("admonition", "deprecated"):
                record.update(text=prose(section.value.description),
                              annotation=str(section.value.annotation or ""))
            elif kind in {"parameters", "other parameters", "type parameters", "attributes",
                          "returns", "yields", "receives", "raises", "warns",
                          "functions", "classes", "modules", "type aliases"}:
                record["entries"] = [{
                    "name": getattr(entry, "name", ""),
                    "annotation": str(getattr(entry, "annotation", "") or ""),
                    "description": prose(entry.description),
                } for entry in section.value]
            else:
                raise ValueError(f"{obj.path}: unsupported docstring section {kind}")
            result.append(record)
        return result

    roots = {module.path.split(".")[0] for module in modules}

    def visit(obj, ancestors=()):
        if obj.is_alias:
            try:
                target = obj.final_target
            except griffe.AliasResolutionError:
                return  # External imports are not documentation objects.
        else:
            target = obj
        if target.path.split(".")[0] not in roots:
            return
        if target.path in ancestors:
            return
        kind = target.kind.value
        if kind == "function" and target.parent and target.parent.is_class:
            kind = "method"
        elif kind == "attribute":
            kind = "property" if "property" in target.labels else (
                "data" if target.parent and target.parent.is_module else "attribute")
        if kind not in {"module", "class", "function", "method", "attribute", "property", "data"}:
            raise ValueError(f"{obj.path}: unsupported Python object kind {kind}")
        signature = target.signature(name=obj.path) if target.is_function or target.is_class else obj.path
        overloads = [function.signature(name=obj.path) for function in (target.overloads or [])] if target.is_function else []
        if target.is_attribute:
            if target.annotation:
                signature += f": {target.annotation}"
            if target.value is not None:
                signature += f" = {target.value}"
        scope = {}
        parent = target
        while parent:
            for name in parent.members:
                if name not in scope:
                    try:
                        scope[name] = target.resolve(name)
                    except griffe.NameResolutionError:
                        pass
            parent = parent.parent
        record = objects[obj.path] = {
            "name": obj.path, "canonical": target.path, "kind": kind,
            "signature": signature, "overloads": overloads, "sections": sections(target), "scope": scope,
            "source": {"file": str(target.relative_package_filepath), "line": target.lineno}, "members": [],
        }
        if target.is_class or target.is_module:
            for member in obj.members.values():
                if member.name.startswith("_"):
                    continue
                visit(member, (*ancestors, target.path))
                if member.path in objects:
                    record["members"].append(member.path)

    for module in modules:
        visit(module)
    # Canonical names and all public re-exports share one identity.
    aliases = {}
    for name, record in objects.items():
        aliases.setdefault(record["canonical"], set()).update((name, record["canonical"]))
    for record in objects.values():
        record["aliases"] = sorted(aliases[record["canonical"]])
    return {"version": 1, "objects": objects}


if __name__ == "__main__":
    class Diagnostics(logging.Handler):
        def emit(self, record):
            if record.levelno >= logging.WARNING:
                raise ValueError(record.getMessage())

    logging.getLogger("griffe").addHandler(Diagnostics())
    try:
        json.dump(extract(json.load(sys.stdin)), sys.stdout)
    except Exception as error:
        print(f"autodoc: {error}", file=sys.stderr)
        sys.exit(1)
