"""Adapt NumPy/RST docstrings to Pydocs using Griffe and RST-to-MyST parsers."""

from copy import deepcopy
from types import SimpleNamespace
import builtins
from fnmatch import fnmatchcase

from griffe import Docstring, Extension, NameResolutionError
from mdformat.plugins import PARSER_EXTENSIONS
from mdformat.renderer import MDRenderer
from rst_to_myst import rst_to_myst
from rst_to_myst.mdformat_render import AdditionalRenderers


class MystDocstrings(Extension):
    """Preserve Sphinx class prose and translate parsed docstrings for Pydocs.

    ``class_only`` mirrors autodoc's ``class-doc-from: class``. Document routes
    map Sphinx's doc-role targets to site-relative paths. No Python code is run.
    """

    def __init__(self, *, class_only=(), documents=None, exclude=()):
        self.class_only = set(class_only)
        self.documents = documents or {}
        self.exclude = exclude

    def on_package(self, *, pkg, **_kwargs):
        def visit(obj):
            if (
                obj.is_alias
                or obj.name.startswith("_")
                or any(fnmatchcase(obj.path, pattern) for pattern in self.exclude)
            ):
                return
            # Pydocs merges constructor parameters, but not constructor prose.
            if obj.is_class and obj.path not in self.class_only:
                constructor = obj.members.get("__init__") or obj.members.get("__new__")
                if constructor and constructor.docstring:
                    own = deepcopy(obj.docstring.parsed) if obj.docstring else []
                    extra = deepcopy(constructor.docstring.parsed)
                    if not obj.docstring:
                        obj.docstring = Docstring("", parent=obj)
                    obj.docstring.parsed = own + extra
            if obj.docstring:
                for section in obj.docstring.parsed:
                    kind = section.kind.value
                    if kind == "text":
                        section.value = self.convert(section.value, obj)
                    elif kind == "examples":
                        section.value = [
                            (
                                kind,
                                self.convert(value, obj)
                                if kind.value == "text"
                                else value,
                            )
                            for kind, value in section.value
                        ]
                    elif kind == "admonition":
                        section.value.description = self.convert(
                            section.value.description, obj
                        )
                    elif isinstance(section.value, list):
                        for entry in section.value:
                            if hasattr(entry, "description"):
                                entry.description = self.convert(entry.description, obj)
                            if isinstance(getattr(entry, "annotation", None), str):
                                entry.annotation = entry.annotation.strip(
                                    "`"
                                ).removeprefix("~")
            for member in list(obj.members.values()):
                visit(member)

        visit(pkg)

    def convert(self, text, obj):
        if not text.strip():
            return text
        output = rst_to_myst(text, use_sphinx=False, default_role="autolink")
        warnings = output.warning_stream.getvalue()
        # RST-to-MyST calls conversion of doctests to pycon a render warning.
        problems = [
            line
            for line in warnings.splitlines()
            if line and "Treating doctest block as pycon literal block" not in line
        ]
        if problems:
            raise ValueError(f"{obj.path}: " + "\n".join(problems))

        def role(node, _context):
            name = node.meta["name"]
            value = node.content
            if " <" in value and value.endswith(">"):
                title, target = value[:-1].rsplit(" <", 1)
            else:
                target = value
                title = (
                    value.removeprefix("~").split(".")[-1]
                    if value.startswith("~")
                    else value
                )
            if name == "doc":
                if target not in self.documents:
                    raise ValueError(f"{obj.path}: unknown document {target}")
                return f"[{title}]({self.documents[target]})"
            if name not in {
                "autolink",
                "class",
                "func",
                "meth",
                "attr",
                "obj",
                "mod",
                "data",
            }:
                raise ValueError(f"{obj.path}: unsupported RST role {name}")
            target = target.removeprefix("~")
            head, *tail = target.split(".")
            try:
                target = ".".join([obj.resolve(head), *tail])
            except NameResolutionError:
                # Sphinx's default autolink role leaves ordinary variable names
                # literal. Qualified names and explicit roles must resolve.
                if not hasattr(builtins, target):
                    if (
                        name == "autolink"
                        and not value.startswith("~")
                        and head != obj.package.name
                    ):
                        return f"`{title}`"
            return f"[`{title}`][{target}]"

        myst = PARSER_EXTENSIONS["myst"]
        renderers = SimpleNamespace(
            RENDERERS={**myst.RENDERERS, "myst_role": role},
            POSTPROCESSORS=getattr(myst, "POSTPROCESSORS", {}),
        )
        options = {
            "parser_extension": [
                PARSER_EXTENSIONS[name] for name in ["tables", "frontmatter", "deflist"]
            ]
            + [AdditionalRenderers, renderers],
            "mdformat": {"number": True},
        }
        return MDRenderer().render(output.tokens, options, output.env)
