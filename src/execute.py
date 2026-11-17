"""Versioned JSON adapter to nbclient in the project's selected Pixi environment."""

import json
import os
import signal
import sys
import threading
import tomllib
from importlib.metadata import version
from pathlib import Path

CONTRACT = json.loads(Path(__file__).with_name("execution-contract.json").read_text())
ENVIRONMENT = json.loads(Path(__file__).with_name("environment-contract.json").read_text())


class KernelLifetime:
    """Own the OS kernel process even when nbclient's event loop cannot clean up.

    Jupyter launches kernels in a new session, so killing the adapter's process
    group alone does not terminate them. The independent watchdog and SIGTERM
    handler kill that session directly. The parent also receives its PID over a
    private control pipe, allowing cleanup if the adapter crashes or is killed.
    No connection information or kernel token is sent over that pipe.
    """

    def __init__(self, deadline=None):
        self.pid = None
        self.pgid = None
        self.lock = threading.RLock()
        self.previous = {}
        self.closed = threading.Event()
        for sig in (signal.SIGTERM, signal.SIGINT):
            self.previous[sig] = signal.signal(sig, self.terminate)
        self.timer = threading.Timer(deadline, self.expire) if deadline else None
        if self.timer:
            self.timer.daemon = True
            self.timer.start()
        if os.environ.get("ASTRO_MYST_CONTROL_FD"):
            parent = os.getppid()

            def watch_parent():
                while not self.closed.wait(0.2):
                    if os.getppid() != parent:
                        self.expire()

            threading.Thread(target=watch_parent, daemon=True).start()

    @staticmethod
    def notify(message):
        descriptor = os.environ.get("ASTRO_MYST_CONTROL_FD")
        if descriptor:
            try:
                os.write(int(descriptor), (json.dumps(message) + "\n").encode())
            except (OSError, ValueError):
                pass

    def record(self, manager):
        with self.lock:
            self.pid = getattr(manager.provisioner, "pid", None)
            if self.pid and os.name != "nt":
                try:
                    pgid = os.getpgid(self.pid)
                    self.pgid = pgid if pgid != os.getpgrp() else None
                except ProcessLookupError:
                    pass
            if self.pid:
                self.notify({"event": "kernel-started", "pid": self.pid, "pgid": self.pgid})

    def kill(self):
        with self.lock:
            if self.pid:
                try:
                    if self.pgid:
                        os.killpg(self.pgid, signal.SIGKILL)
                    else:
                        os.kill(self.pid, signal.SIGTERM if os.name == "nt" else signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.notify({"event": "kernel-stopped", "pid": self.pid})
                self.pid = self.pgid = None

    def terminate(self, signum, frame):
        self.kill()
        # A handler must not call asyncio/nbclient cleanup recursively while
        # wait_for_reply owns the event loop. The kernel is already terminated.
        os._exit(128 + signum)

    def expire(self):
        self.kill()
        os._exit(124)

    def close(self):
        self.closed.set()
        if self.timer:
            self.timer.cancel()
        self.kill()
        for sig, previous in self.previous.items():
            signal.signal(sig, previous)


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
    lifetime = KernelLifetime(request.get("deadline"))
    start_kernel = manager.start_kernel

    async def start_owned_kernel(*args, **kwargs):
        await start_kernel(*args, **kwargs)
        lifetime.record(manager)

    manager.start_kernel = start_owned_kernel
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
    finally:
        lifetime.close()
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
