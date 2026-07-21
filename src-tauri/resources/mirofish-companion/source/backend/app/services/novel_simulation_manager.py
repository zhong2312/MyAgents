"""Persistent lifecycle manager for novel-world simulations."""

from __future__ import annotations

import json
import os
import threading
import uuid
from pathlib import Path
from typing import Any

from .novel_simulation_engine import NovelSimulationEngine
from .novel_simulation_models import (
    NovelSimulationModelSelection,
    NovelSimulationRun,
    NovelSimulationScenario,
    NovelSimulationStatus,
    NovelWorldSnapshot,
    utc_now_iso,
)


class NovelSimulationManager:
    def __init__(self, base_dir: str | None = None, engine: NovelSimulationEngine | None = None):
        default_dir = Path(__file__).resolve().parents[2] / "uploads-explorer" / "novel-simulations"
        self.base_dir = Path(
            base_dir
            or os.environ.get("NOVEL_SIMULATION_DATA_DIR", "")
            or default_dir
        )
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.engine = engine or NovelSimulationEngine()
        self._lock = threading.RLock()
        self._condition = threading.Condition(self._lock)
        self._workers: dict[str, threading.Thread] = {}
        self._cancelled: set[str] = set()
        self._step_requests: dict[str, int] = {}
        self._generations: dict[str, int] = {}
        self._recover_interrupted_runs()

    def create_run(
        self,
        snapshot: NovelWorldSnapshot,
        scenario: NovelSimulationScenario,
        workspace_path: str = "",
        model_selections: dict[str, NovelSimulationModelSelection] | None = None,
        model_proxy_url: str | None = None,
    ) -> NovelSimulationRun:
        actor_ids = {actor.id for actor in snapshot.actors}
        missing = [value for value in scenario.selected_actor_ids if value not in actor_ids]
        if missing:
            raise ValueError(f"selected actors do not exist: {', '.join(missing)}")
        run = NovelSimulationRun(
            runId=f"novel-run-{uuid.uuid4().hex[:12]}",
            projectId=snapshot.project_id,
            maxRounds=scenario.horizon_rounds,
            snapshot=snapshot,
            scenario=scenario,
            workspacePath=workspace_path,
            modelSelections=model_selections or {},
            modelProxyUrl=model_proxy_url,
        )
        self._save(run)
        return run

    def list_runs(
        self,
        project_id: str | None = None,
        workspace_path: str | None = None,
    ) -> list[NovelSimulationRun]:
        runs: list[NovelSimulationRun] = []
        for path in self.base_dir.glob("*/run.json"):
            try:
                run = self._load_path(path)
            except Exception:
                continue
            if (
                run
                and (not project_id or run.project_id == project_id)
                and (not workspace_path or self._same_workspace(run.workspace_path, workspace_path))
            ):
                runs.append(run)
        return sorted(runs, key=lambda item: item.updated_at, reverse=True)

    def get_run(
        self,
        run_id: str,
        project_id: str | None = None,
        workspace_path: str | None = None,
    ) -> NovelSimulationRun | None:
        if not run_id.startswith("novel-run-") or not run_id.replace("-", "").isalnum():
            return None
        try:
            run = self._load_path(self.base_dir / run_id / "run.json")
        except Exception:
            return None
        if run and project_id is not None and run.project_id != project_id:
            return None
        if run and workspace_path is not None and not self._same_workspace(
            run.workspace_path,
            workspace_path,
        ):
            return None
        return run

    def start(
        self,
        run_id: str,
        project_id: str | None = None,
        workspace_path: str | None = None,
    ) -> NovelSimulationRun:
        with self._lock:
            run = self._require(run_id, project_id, workspace_path)
            if run.status not in {NovelSimulationStatus.DRAFT, NovelSimulationStatus.PAUSED}:
                raise ValueError(f"run cannot start from status {run.status.value}")
            run.status = NovelSimulationStatus.RUNNING
            self._generations[run_id] = self._generations.get(run_id, 0) + 1
            run.error = None
            run.updated_at = utc_now_iso()
            self._cancelled.discard(run_id)
            self._save(run)
            self._ensure_worker_locked(run_id)
            self._condition.notify_all()
            return run

    def pause(
        self,
        run_id: str,
        project_id: str | None = None,
        workspace_path: str | None = None,
    ) -> NovelSimulationRun:
        with self._lock:
            run = self._require(run_id, project_id, workspace_path)
            if run.status != NovelSimulationStatus.RUNNING:
                raise ValueError("only a running simulation can be paused")
            run.status = NovelSimulationStatus.PAUSED
            self._generations[run_id] = self._generations.get(run_id, 0) + 1
            run.updated_at = utc_now_iso()
            self._save(run)
            self._condition.notify_all()
            return run

    def cancel(
        self,
        run_id: str,
        project_id: str | None = None,
        workspace_path: str | None = None,
    ) -> NovelSimulationRun:
        with self._lock:
            run = self._require(run_id, project_id, workspace_path)
            if run.status in {NovelSimulationStatus.COMPLETED, NovelSimulationStatus.CANCELLED}:
                return run
            self._cancelled.add(run_id)
            self._step_requests.pop(run_id, None)
            self._generations[run_id] = self._generations.get(run_id, 0) + 1
            run.status = NovelSimulationStatus.CANCELLED
            run.updated_at = utc_now_iso()
            run.completed_at = utc_now_iso()
            self._save(run)
            self._condition.notify_all()
            return run

    def advance(
        self,
        run_id: str,
        project_id: str | None = None,
        workspace_path: str | None = None,
    ) -> NovelSimulationRun:
        with self._lock:
            run = self._require(run_id, project_id, workspace_path)
            if run.status not in {NovelSimulationStatus.DRAFT, NovelSimulationStatus.PAUSED}:
                raise ValueError("single-step advance requires a draft or paused simulation")
            if self._step_requests.get(run_id):
                raise ValueError("a single-step advance is already in progress")
            self._ensure_worker_locked(run_id)
            self._step_requests[run_id] = 1
            run.status = NovelSimulationStatus.RUNNING
            self._generations[run_id] = self._generations.get(run_id, 0) + 1
            run.error = None
            run.updated_at = utc_now_iso()
            self._save(run)
            self._condition.notify_all()
            return run

    def events(
        self,
        run_id: str,
        after: int = 0,
        limit: int = 200,
        project_id: str | None = None,
        workspace_path: str | None = None,
    ) -> dict[str, Any]:
        run = self._require(run_id, project_id, workspace_path)
        start = max(0, after)
        end = min(len(run.events), start + max(1, min(limit, 500)))
        return {"events": run.events[start:end], "nextCursor": end, "total": len(run.events)}

    def _run_to_completion(self, run_id: str) -> None:
        step = False
        try:
            while True:
                with self._lock:
                    run = self._require(run_id)
                    if run_id in self._cancelled:
                        return
                    step = self._step_requests.pop(run_id, None) is not None
                    if run.status == NovelSimulationStatus.PAUSED and not step:
                        self._condition.wait()
                        continue
                    if run.status == NovelSimulationStatus.PAUSED and step:
                        run.status = NovelSimulationStatus.RUNNING
                        run.updated_at = utc_now_iso()
                        self._save(run)
                    elif run.status != NovelSimulationStatus.RUNNING:
                        return
                    if run.current_round >= run.max_rounds:
                        run.status = NovelSimulationStatus.COMPLETED
                        run.completed_at = utc_now_iso()
                        run.updated_at = utc_now_iso()
                        self._save(run)
                        return
                    generation = self._generations.get(run_id, 0)
                applied = self._advance_round(run_id, generation)
                if step and applied:
                    with self._lock:
                        current = self.get_run(run_id)
                        if current and current.status == NovelSimulationStatus.RUNNING:
                            current.status = NovelSimulationStatus.PAUSED
                            current.updated_at = utc_now_iso()
                            self._save(current)
                    continue
        except Exception as exc:
            with self._lock:
                run = self.get_run(run_id)
                if run and run.status != NovelSimulationStatus.CANCELLED:
                    run.status = NovelSimulationStatus.FAILED
                    run.error = str(exc)
                    run.updated_at = utc_now_iso()
                    self._save(run)
        finally:
            with self._lock:
                self._workers.pop(run_id, None)
                self._step_requests.pop(run_id, None)
                self._generations.pop(run_id, None)
                self._condition.notify_all()

    def _advance_round(self, run_id: str, generation: int) -> bool:
        with self._lock:
            run = self._require(run_id)
        result = self.engine.simulate_round(run)
        with self._lock:
            current = self._require(run_id)
            if (
                current.status != NovelSimulationStatus.RUNNING
                or self._generations.get(run_id, 0) != generation
            ):
                return False
            current.rounds.append(result)
            current.events.extend(result.get("events", []))
            current.state_changes.extend(result.get("stateChanges", []))
            current.warnings.extend(result.get("warnings", []))
            current.current_round = int(result.get("round", current.current_round + 1))
            current.updated_at = utc_now_iso()
            if current.current_round >= current.max_rounds:
                current.status = NovelSimulationStatus.COMPLETED
                current.completed_at = utc_now_iso()
            self._save(current)
            return True

    def _require(
        self,
        run_id: str,
        project_id: str | None = None,
        workspace_path: str | None = None,
    ) -> NovelSimulationRun:
        run = self.get_run(run_id, project_id, workspace_path)
        if not run:
            raise KeyError(f"simulation run not found: {run_id}")
        return run

    def _path(self, run: NovelSimulationRun) -> Path:
        return self.base_dir / run.run_id / "run.json"

    def _save(self, run: NovelSimulationRun) -> None:
        path = self._path(run)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(run.to_wire(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temp, path)

    def _load_path(self, path: Path) -> NovelSimulationRun | None:
        if not path.exists():
            return None
        return NovelSimulationRun.model_validate_json(path.read_text(encoding="utf-8"))

    @staticmethod
    def _same_workspace(left: str, right: str) -> bool:
        if not left or not right:
            return False
        return os.path.normcase(os.path.abspath(left)) == os.path.normcase(os.path.abspath(right))

    def _ensure_worker_locked(self, run_id: str) -> None:
        existing = self._workers.get(run_id)
        if existing and existing.is_alive():
            return
        worker = threading.Thread(
            target=self._run_to_completion,
            args=(run_id,),
            name=f"novel-simulation-{run_id}",
            daemon=True,
        )
        self._workers[run_id] = worker
        worker.start()

    def _recover_interrupted_runs(self) -> None:
        for path in self.base_dir.glob("*/run.json"):
            try:
                run = self._load_path(path)
            except Exception:
                continue
            if run and run.status == NovelSimulationStatus.RUNNING:
                run.status = NovelSimulationStatus.PAUSED
                run.warnings.append("MiroFish 服务曾在运行中退出，已恢复为暂停状态。")
                run.updated_at = utc_now_iso()
                self._save(run)


_manager: NovelSimulationManager | None = None
_manager_lock = threading.Lock()


def get_novel_simulation_manager() -> NovelSimulationManager:
    global _manager
    if _manager is None:
        with _manager_lock:
            if _manager is None:
                _manager = NovelSimulationManager()
    return _manager


def reset_novel_simulation_manager(
    base_dir: str | None = None,
    engine: NovelSimulationEngine | None = None,
) -> NovelSimulationManager:
    global _manager
    _manager = NovelSimulationManager(base_dir=base_dir, engine=engine)
    return _manager
