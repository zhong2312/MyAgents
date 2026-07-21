"""Lean loopback companion exposing only MiroFish novel-world simulation APIs."""

from __future__ import annotations

import os
import secrets
import threading
import time
import json
from pathlib import Path
from urllib.parse import unquote, urlparse

os.environ.setdefault("MIROFISH_COMPANION_MODE", "1")
os.environ.setdefault("SECRET_KEY", secrets.token_hex(32))

import psutil  # noqa: E402
from flask import Flask, jsonify, request  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from app.services.novel_simulation_manager import get_novel_simulation_manager  # noqa: E402
from app.services.novel_simulation_models import (  # noqa: E402
    NovelSimulationScenario,
    NovelSimulationModelSelection,
    NovelWorldSnapshot,
)

SIMULATION_MODEL_SCENE_IDS = {
    "simulation.actor",
    "simulation.world",
    "simulation.resolve",
    "simulation.report",
}


def create_companion_app() -> Flask:
    app = Flask("mirofish-novel-companion")
    app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024
    app.json.ensure_ascii = False

    def error(message: str, status: int):
        return jsonify({"success": False, "error": message}), status

    @app.before_request
    def authenticate():
        secret = os.environ.get("API_SECRET_KEY", "")
        if secret and request.headers.get("X-API-Key", "") != secret:
            return error("认证失败：请提供有效的 API Key", 401)
        if request.path.startswith("/api/novel-simulation"):
            project_id = request.headers.get("X-MyAgents-Project-Id", "").strip()
            if not project_id:
                return error("缺少 X-MyAgents-Project-Id", 400)
            encoded_workspace = request.headers.get("X-MyAgents-Workspace-Path", "").strip()
            if not encoded_workspace:
                return error("缺少 X-MyAgents-Workspace-Path", 400)
            request.environ["novel.project_id"] = project_id
            request.environ["novel.workspace_path"] = unquote(encoded_workspace)
        return None

    def project_id() -> str:
        return str(request.environ.get("novel.project_id", ""))

    def workspace_path() -> str:
        return str(request.environ.get("novel.workspace_path", ""))

    def validate_workspace(workspace_path: object, expected_project_id: str) -> str:
        if not isinstance(workspace_path, str) or not workspace_path.strip():
            raise ValueError("workspacePath is required")
        path = Path(workspace_path).expanduser()
        if not path.is_absolute() or not path.is_dir():
            raise ValueError("workspacePath must be an absolute project directory")
        metadata_path = path.resolve() / "novel.json"
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise ValueError("workspacePath is not a readable novel project") from exc
        if metadata.get("projectId") != expected_project_id:
            raise ValueError("workspace projectId does not match the request")
        resolved_path = str(path.resolve())
        if os.path.normcase(resolved_path) != os.path.normcase(str(Path(workspace_path()).resolve())):
            raise ValueError("workspacePath does not match the authenticated workspace")
        return resolved_path

    def parse_model_selections(value: object) -> dict[str, NovelSimulationModelSelection]:
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise ValueError("modelSelections must be an object")
        result: dict[str, NovelSimulationModelSelection] = {}
        for scene_id, selection in value.items():
            if scene_id not in SIMULATION_MODEL_SCENE_IDS:
                raise ValueError(f"unknown simulation model scene: {scene_id}")
            result[scene_id] = NovelSimulationModelSelection.model_validate(selection)
        return result

    def validate_proxy_url(value: object) -> str | None:
        if value is None or value == "":
            return None
        if not isinstance(value, str):
            raise ValueError("modelProxyUrl must be a URL")
        parsed = urlparse(value)
        if parsed.scheme != "http" or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("modelProxyUrl must be a loopback HTTP URL")
        hostname = (parsed.hostname or "").lower()
        if hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError("modelProxyUrl must be a loopback HTTP URL")
        return value

    @app.get("/health")
    def health():
        return jsonify({"status": "ok", "service": "mirofish-novel-companion"})

    @app.get("/api/novel-simulation/capabilities")
    def capabilities():
        return jsonify({
            "success": True,
            "data": {
                "apiVersion": 1,
                "engine": "mirofish-explorer",
                "engineVersion": "0.2.0-explorer",
                "features": [
                    "structured-snapshot",
                    "persistent-runs",
                    "pause",
                    "resume",
                    "advance",
                    "events",
                ],
            },
        })

    @app.post("/api/novel-simulation/runs")
    def create_run():
        try:
            payload = request.get_json(silent=True) or {}
            snapshot = NovelWorldSnapshot.model_validate(payload.get("snapshot"))
            scenario = NovelSimulationScenario.model_validate(payload.get("scenario"))
            current_project_id = project_id()
            if snapshot.project_id != current_project_id:
                return error("snapshot projectId does not match the workspace", 403)
            workspace_path = validate_workspace(payload.get("workspacePath"), current_project_id)
            model_selections = parse_model_selections(payload.get("modelSelections"))
            proxy_url = validate_proxy_url(payload.get("modelProxyUrl"))
            run = get_novel_simulation_manager().create_run(
                snapshot,
                scenario,
                workspace_path=workspace_path,
                model_selections=model_selections,
                model_proxy_url=proxy_url,
            )
            return jsonify({"success": True, "data": run.to_wire()}), 201
        except (ValidationError, ValueError, TypeError) as exc:
            return error(str(exc), 400)

    @app.get("/api/novel-simulation/runs")
    def list_runs():
        requested_project_id = (request.args.get("projectId") or "").strip()
        if requested_project_id != project_id():
            return error("projectId does not match the workspace", 403)
        runs = get_novel_simulation_manager().list_runs(
            requested_project_id,
            workspace_path(),
        )
        return jsonify({
            "success": True,
            "data": {"runs": [run.to_wire() for run in runs]},
        })

    @app.get("/api/novel-simulation/runs/<run_id>")
    def get_run(run_id: str):
        run = get_novel_simulation_manager().get_run(
            run_id,
            project_id(),
            workspace_path(),
        )
        if not run:
            return error("simulation run not found", 404)
        return jsonify({"success": True, "data": run.to_wire()})

    def run_action(run_id: str, action: str):
        manager = get_novel_simulation_manager()
        try:
            run = getattr(manager, action)(run_id, project_id(), workspace_path())
            return jsonify({"success": True, "data": run.to_wire()})
        except KeyError as exc:
            return error(str(exc), 404)
        except ValueError as exc:
            return error(str(exc), 409)

    @app.post("/api/novel-simulation/runs/<run_id>/start")
    def start_run(run_id: str):
        return run_action(run_id, "start")

    @app.post("/api/novel-simulation/runs/<run_id>/pause")
    def pause_run(run_id: str):
        return run_action(run_id, "pause")

    @app.post("/api/novel-simulation/runs/<run_id>/resume")
    def resume_run(run_id: str):
        return run_action(run_id, "start")

    @app.post("/api/novel-simulation/runs/<run_id>/advance")
    def advance_run(run_id: str):
        return run_action(run_id, "advance")

    @app.post("/api/novel-simulation/runs/<run_id>/cancel")
    def cancel_run(run_id: str):
        return run_action(run_id, "cancel")

    @app.get("/api/novel-simulation/runs/<run_id>/events")
    def get_events(run_id: str):
        try:
            after = request.args.get("after", default=0, type=int) or 0
            limit = request.args.get("limit", default=200, type=int) or 200
            data = get_novel_simulation_manager().events(
                run_id,
                after=after,
                limit=limit,
                project_id=project_id(),
                workspace_path=workspace_path(),
            )
            return jsonify({"success": True, "data": data})
        except KeyError as exc:
            return error(str(exc), 404)

    return app


def start_parent_watchdog() -> None:
    """Exit when the MyAgents host that owns this companion is gone."""
    parent_pid_text = os.environ.get("MIROFISH_PARENT_PID", "").strip()
    if not parent_pid_text.isdigit():
        return
    parent_pid = int(parent_pid_text)
    if parent_pid <= 0:
        return

    def watch() -> None:
        while psutil.pid_exists(parent_pid):
            time.sleep(1)
        os._exit(0)

    threading.Thread(
        target=watch,
        name="mirofish-parent-watchdog",
        daemon=True,
    ).start()


def main() -> None:
    host = os.environ.get("MIROFISH_HOST", "127.0.0.1")
    port = int(os.environ.get("MIROFISH_PORT", "5103"))
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError("Novel companion must bind to a loopback address")
    start_parent_watchdog()
    create_companion_app().run(host=host, port=port, threaded=True, debug=False)


if __name__ == "__main__":
    main()
