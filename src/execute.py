"""Versioned JSON adapter to nbclient in the project's selected Pixi environment."""

import json
import sys
import tomllib
from importlib.metadata import version
from pathlib import Path

CONTRACT = json.loads(Path(__file__).with_name("execution-contract.json").read_text())


def environment(request):
    """Check installed Jupyter distributions against the selected Pixi feature."""
    from packaging.specifiers import SpecifierSet

    versions = {name: version(name) for name in CONTRACT["packages"]}
    if pixi := request.get("pixi"):
        manifest = tomllib.loads(Path(pixi["manifest"]).read_text())
        config = manifest.get("tool", {}).get("pixi", manifest)
        requirements = config["feature"][pixi["feature"]]["dependencies"]
        for name, installed in versions.items():
            spec = requirements[name]
            if isinstance(spec, dict):
                spec = spec["version"]
            if installed not in SpecifierSet(spec):
                raise RuntimeError(
                    f"{name} {installed} does not satisfy Pixi requirement {spec}; "
                    "run the docs task in the configured Pixi environment"
                )
    return versions


def execute(request):
    """Run a page in a fresh kernel and retain structured cell failures."""
    import nbformat
    from nbclient import NotebookClient

    cells = request["cells"]
    notebook = nbformat.v4.new_notebook(
        cells=[
            nbformat.v4.new_code_cell(
                cell["source"],
                id=cell["id"],
                metadata={"source_map": cell.get("origin")},
            )
            for cell in cells
        ]
    )
    client = NotebookClient(
        notebook,
        kernel_name="python3",
        timeout=request.get("timeout", 120),
        allow_errors=False,
        resources={"metadata": {"path": str(Path(request["cwd"]).resolve())}},
    )
    active = None

    def on_cell_execute(cell_index, **_kwargs):
        nonlocal active
        active = cell_index

    client.on_cell_execute = on_cell_execute
    manager = client.create_kernel_manager()
    manager.kernel_spec.argv = [
        sys.executable,
        "-m",
        "ipykernel_launcher",
        "-f",
        "{connection_file}",
    ]
    try:
        client.execute()
    except Exception as error:
        return {
            "error": {
                "name": type(error).__name__,
                "message": str(error),
                "cell": cells[active] if active is not None else None,
            }
        }
    return {"notebook": notebook}


def main(request):
    """Validate the protocol before dispatching an environment check or execution."""
    if request.get("protocol") != CONTRACT["protocol"]:
        raise ValueError(
            f"Unsupported execution protocol {request.get('protocol')}; expected {CONTRACT['protocol']}"
        )
    if request.get("operation") not in {"check", "execute"}:
        raise ValueError("Unsupported execution operation")
    versions = environment(request)
    result = {} if request["operation"] == "check" else execute(request)
    return {"protocol": CONTRACT["protocol"], "versions": versions, **result}


if __name__ == "__main__":
    try:
        response = main(json.load(sys.stdin))
    except Exception as error:
        response = {
            "protocol": CONTRACT["protocol"],
            "error": {
                "name": type(error).__name__,
                "message": str(error),
            },
        }
    json.dump(response, sys.stdout)
