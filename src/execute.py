"""Versioned JSON adapter to nbclient in the project's selected Pixi environment."""

import json
import sys
import tomllib
from importlib.metadata import version
from pathlib import Path

CONTRACT = json.loads(Path(__file__).with_name("execution-contract.json").read_text())
ENVIRONMENT = json.loads(Path(__file__).with_name("environment-contract.json").read_text())


def environment(request):
    """Check installed Jupyter distributions against the selected Pixi feature."""
    from packaging.specifiers import SpecifierSet

    versions = {name: version(name) for name in CONTRACT["packages"]}
    for name, installed in versions.items():
        supported = ENVIRONMENT["conda"][name]
        if installed not in SpecifierSet(supported):
            raise RuntimeError(f"{name} {installed} does not satisfy supported requirement {supported}")
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


def evaluate(client, expression):
    """Evaluate one inline expression through the protocol's user_expressions."""
    msg_id = client.kc.execute(
        "", silent=True, store_history=False, user_expressions={"result": expression}
    )
    reply = client.wait_for_reply(msg_id)
    if reply is None:
        raise RuntimeError("Timed out while evaluating an inline expression")
    result = reply["content"].get("user_expressions", {}).get("result")
    if result is None or result.get("status") != "ok":
        detail = result or reply["content"]
        raise RuntimeError(f"{detail.get('ename', 'Error')}: {detail.get('evalue', '')}")
    return {"output_type": "display_data", "data": result["data"], "metadata": result.get("metadata", {})}


def execute(request):
    """Run a page in a fresh kernel and retain structured cell failures."""
    import nbformat
    from nbclient import NotebookClient

    items = request["cells"]
    cells = [item for item in items if item.get("kind", "cell") == "cell"]
    notebook = nbformat.v4.new_notebook(
        cells=[
            nbformat.v4.new_code_cell(
                cell["source"],
                id=cell["id"],
                metadata={"source_map": cell.get("origin"), "tags": cell.get("tags", [])},
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
    manager = client.create_kernel_manager()
    manager.kernel_spec.argv = [
        sys.executable,
        "-m",
        "ipykernel_launcher",
        "-f",
        "{connection_file}",
    ]
    expressions = {}
    try:
        # Mirror NotebookClient.execute, interleaving inline expressions with
        # cells in authored order so prose sees the state at its position.
        client.reset_execution_trackers()
        with client.setup_kernel():
            info = client.wait_for_reply(client.kc.kernel_info())
            if info is not None and "language_info" in info["content"]:
                notebook.metadata["language_info"] = info["content"]["language_info"]
            index = 0
            for item in items:
                active = item
                if item.get("kind", "cell") == "cell":
                    client.execute_cell(
                        notebook.cells[index], index, execution_count=client.code_cells_executed + 1
                    )
                    index += 1
                else:
                    expressions[item["id"]] = evaluate(client, item["source"])
    except Exception as error:
        return {
            "error": {
                "name": type(error).__name__,
                "message": str(error),
                "cell": active,
            }
        }
    return {"notebook": notebook, "expressions": expressions}


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
