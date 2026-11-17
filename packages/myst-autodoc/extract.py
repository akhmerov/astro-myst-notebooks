"""Static Griffe extraction. Read configuration from stdin, emit versioned JSON."""

import json
import logging
import re
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
            if name == "doc":
                # RST inline roles may wrap across lines. Their whitespace is
                # ordinary prose spacing, including around explicit targets.
                content = " ".join(node.content.split())
                match = re.fullmatch(r"(.+?)\s*<([^<>]+)>", content)
                title, target = (part.strip() for part in match.groups()) if match else (content, content)
                destination = config.get("documents", {}).get(target)
                if not isinstance(destination, str) or not destination:
                    raise ValueError(f"RST document reference {target!r} requires an api.documents mapping")
                return f"[{title}]({destination})"
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
        constructor = target.all_members.get("__init__") if target.is_class else None
        signature = target.signature(name=obj.path) if target.is_function or target.is_class else obj.path
        if target.is_class and not signature:
            signature = constructor.signature(name=obj.path, return_type=False) if constructor else f"{obj.path}()"
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
        documentation = sections(target)
        if constructor and constructor.docstring:
            # Constructor parameters and examples are part of the public class
            # documentation, including when __init__ is inherited. Keep class
            # descriptions first and merge repeated sections without duplication.
            for section in sections(constructor):
                previous = next((entry for entry in documentation if entry["kind"] == section["kind"] and entry.get("title") == section.get("title")), None)
                if previous is None:
                    documentation.append(section)
                elif "text" in section and section["text"] != previous.get("text"):
                    previous["text"] += "\n\n" + section["text"]
                elif "entries" in section:
                    for entry in section["entries"]:
                        existing = next((value for value in previous["entries"] if value["name"] == entry["name"]), None)
                        if existing is None:
                            previous["entries"].append(entry)
                        elif entry["description"] and entry["description"] != existing["description"]:
                            existing["description"] += "\n\n" + entry["description"]
                elif "blocks" in section:
                    previous["blocks"].extend(block for block in section["blocks"] if block not in previous["blocks"])
        canonical = target.path
        if getattr(obj, "inherited", False):
            owner = obj.parent.final_target if obj.parent.is_alias else obj.parent
            canonical = f"{owner.path}.{obj.name}"
        bases = []
        for base in target.bases if target.is_class else []:
            try:
                resolved = base.canonical_path
            except (AttributeError, griffe.NameResolutionError, griffe.AliasResolutionError):
                resolved = None
            bases.append({"name": str(base), "target": resolved})
        record = objects[obj.path] = {
            "name": obj.path, "canonical": canonical, "kind": kind,
            "signature": signature, "overloads": overloads, "bases": bases, "sections": documentation, "scope": scope,
            "source": {"file": str(target.relative_package_filepath), "line": target.lineno}, "members": [],
        }
        if target.is_class or target.is_module:
            exports = target.exports if target.is_module else None
            for member in (obj.all_members if target.is_class else obj.members).values():
                # An explicit __all__ defines this module's public API. Loaded
                # sibling modules (including tests) are not necessarily exports.
                # A module listed in configuration is still visited separately.
                if (exports is not None and member.name not in exports) or (
                    exports is None and member.name.startswith("_")
                ):
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
    diagnostics = []
    configuration = json.load(sys.stdin)
    warning_policy = configuration.get("docstringWarnings", "error")
    if warning_policy not in ("error", "warn"):
        raise ValueError("docstringWarnings must be error or warn")

    class Diagnostics(logging.Handler):
        def emit(self, record):
            if record.levelno >= logging.WARNING:
                message = record.getMessage()
                # NumPy docstrings may legitimately omit optional type labels.
                # Keep the prose and report this separately; malformed parameter
                # names and unknown sections still fail instead of losing data.
                if warning_policy == "warn" or "No types or annotations for parameters" in message:
                    diagnostics.append({"level": "warning", "message": message})
                    return
                raise ValueError(record.getMessage())

    logging.getLogger("griffe").addHandler(Diagnostics())
    try:
        model = extract(configuration)
        model["diagnostics"] = diagnostics
        json.dump(model, sys.stdout)
    except Exception as error:
        print(f"autodoc: {error}", file=sys.stderr)
        sys.exit(1)
