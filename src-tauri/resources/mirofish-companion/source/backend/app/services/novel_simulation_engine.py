"""Novel-world round engine built on MiroFish's model routing infrastructure."""

from __future__ import annotations

import json
import logging
import uuid
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from typing import Any

from .novel_simulation_models import NovelSimulationRun, utc_now_iso

logger = logging.getLogger(__name__)


class NovelSimulationEngine:
    """Produce one auditable world-state round at a time."""

    MAX_PROMPT_CHARS = 55_000

    def simulate_round(self, run: NovelSimulationRun) -> dict[str, Any]:
        round_number = run.current_round + 1
        if run.model_proxy_url and run.model_selections:
            try:
                return self._simulate_with_model_proxy(run, round_number)
            except Exception as exc:
                logger.warning("Novel simulation model proxy failed, using fallback: %s", exc)
                fallback = self._fallback_round(run, round_number)
                fallback["warnings"].append(f"模型场景执行失败，本轮使用确定性降级：{exc}")
                return fallback
        return self._fallback_round(run, round_number)

    def _simulate_with_model_proxy(
        self,
        run: NovelSimulationRun,
        round_number: int,
    ) -> dict[str, Any]:
        """Run the four configured scenes through the MyAgents Host proxy.

        The companion never receives provider credentials. It only forwards the
        provider/model identifiers selected by the Host and the project path
        needed for Host-side credential and workspace checks.
        """
        context = self._build_context(run, round_number)
        stage_outputs: dict[str, dict[str, Any]] = {}
        for scene_id, instruction in (
            (
                "simulation.actor",
                "判断选中主体在本轮的合理行动。返回 JSON：{actorStates:[{actorId,nextIntent,knowledgeGained}]}。",
            ),
            (
                "simulation.world",
                "根据主体行动推演世界、环境和外部势力响应。返回 JSON：{events:[{title,summary,actorIds,locationId,cause,consequence,severity,ruleIds}]}。",
            ),
            (
                "simulation.resolve",
                "裁定行动与规则碰撞的结果。返回 JSON：{stateChanges:[{entityKind,entityId,field,before,after,reason}],events:[{title,summary,actorIds,locationId,cause,consequence,severity,ruleIds}]}。",
            ),
            (
                "simulation.report",
                "汇总本轮推演，指出需要作者审阅的风险。返回 JSON：{summary,warnings:[string]}。",
            ),
        ):
            selection = run.model_selections.get(scene_id)
            if selection is None:
                continue
            prompt_context = {
                **context,
                "stage": scene_id,
                "previousStageOutputs": stage_outputs,
            }
            stage_outputs[scene_id] = self._call_model_proxy(
                run,
                selection.provider_id,
                selection.model,
                instruction,
                prompt_context,
            )

        combined: dict[str, Any] = {}
        for output in stage_outputs.values():
            for key in ("events", "stateChanges", "actorStates", "warnings"):
                values = output.get(key)
                if isinstance(values, list):
                    combined.setdefault(key, []).extend(values)
        reports = stage_outputs.get("simulation.report", {})
        if isinstance(reports.get("summary"), str):
            combined["summary"] = reports["summary"]
        normalized = self._normalize_round(run, round_number, combined)
        if stage_outputs and not combined.get("warnings"):
            normalized["warnings"] = []
        return normalized

    def _build_context(self, run: NovelSimulationRun, round_number: int) -> dict[str, Any]:
        selected = set(run.scenario.selected_actor_ids)
        return {
            "round": round_number,
            "maxRounds": run.max_rounds,
            "objective": run.scenario.objective,
            "seedEvents": run.scenario.seed_events,
            "scenarioConstraints": run.scenario.constraints,
            "anchor": run.snapshot.anchor,
            "actors": [
                actor.model_dump(mode="json", by_alias=True)
                for actor in run.snapshot.actors
                if not selected or actor.id in selected
            ],
            "locations": [item.model_dump(mode="json", by_alias=True) for item in run.snapshot.locations],
            "rules": [item.model_dump(mode="json", by_alias=True) for item in run.snapshot.rules],
            "actualTimeline": [
                item.model_dump(mode="json", by_alias=True)
                for item in run.snapshot.timeline_events
            ],
            "previousRounds": run.rounds[-3:],
        }

    def _call_model_proxy(
        self,
        run: NovelSimulationRun,
        provider_id: str,
        model: str,
        instruction: str,
        context: dict[str, Any],
    ) -> dict[str, Any]:
        context_json = json.dumps(context, ensure_ascii=False)
        if len(context_json) > self.MAX_PROMPT_CHARS:
            context_json = context_json[: self.MAX_PROMPT_CHARS]
        body = json.dumps(
            {
                "workspacePath": run.workspace_path,
                "providerId": provider_id,
                "model": model,
                "systemPrompt": (
                    "你是小说世界推演的一个受控阶段。只根据已发生事实和给定上下文判断，"
                    "不得把未来规划当作事实，不得替作者强行推进。只返回 JSON。"
                ),
                "prompt": f"{instruction}\n上下文：\n{context_json}",
            },
            ensure_ascii=False,
        ).encode("utf-8")
        request = Request(
            run.model_proxy_url or "",
            data=body,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=120) as response:
                payload = json.loads(response.read(4 * 1024 * 1024).decode("utf-8"))
        except HTTPError as exc:
            detail = exc.read(16_384).decode("utf-8", errors="replace")
            raise RuntimeError(f"Host 模型代理返回 HTTP {exc.code}: {detail[:500]}") from exc
        except URLError as exc:
            raise RuntimeError(f"无法连接 Host 模型代理: {exc.reason}") from exc
        if not isinstance(payload, dict) or payload.get("success") is not True:
            raise RuntimeError(str(payload.get("error") if isinstance(payload, dict) else payload))
        output = payload.get("output")
        if not isinstance(output, str) or not output.strip():
            raise RuntimeError("Host 模型代理返回空内容")
        cleaned = output.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned
            cleaned = cleaned.rsplit("```", 1)[0].strip()
        result = json.loads(cleaned)
        if not isinstance(result, dict):
            raise RuntimeError("模型阶段必须返回 JSON 对象")
        return result

    def _normalize_round(
        self,
        run: NovelSimulationRun,
        round_number: int,
        result: dict[str, Any],
    ) -> dict[str, Any]:
        actor_ids = {actor.id for actor in run.snapshot.actors}
        location_ids = {location.id for location in run.snapshot.locations}
        rule_ids = {rule.id for rule in run.snapshot.rules}
        events: list[dict[str, Any]] = []
        for index, raw in enumerate(result.get("events", []) if isinstance(result, dict) else []):
            if not isinstance(raw, dict):
                continue
            events.append({
                "id": f"evt-{round_number}-{index + 1}-{uuid.uuid4().hex[:6]}",
                "round": round_number,
                "title": str(raw.get("title") or f"第 {round_number} 轮事件"),
                "summary": str(raw.get("summary") or ""),
                "actorIds": [value for value in raw.get("actorIds", []) if value in actor_ids],
                "locationId": raw.get("locationId") if raw.get("locationId") in location_ids else None,
                "cause": str(raw.get("cause") or ""),
                "consequence": str(raw.get("consequence") or ""),
                "severity": str(raw.get("severity") or "medium"),
                "ruleIds": [value for value in raw.get("ruleIds", []) if value in rule_ids],
                "createdAt": utc_now_iso(),
            })
        if not events:
            return self._fallback_round(run, round_number)
        state_changes = [item for item in result.get("stateChanges", []) if isinstance(item, dict)]
        actor_states = [item for item in result.get("actorStates", []) if isinstance(item, dict)]
        return {
            "round": round_number,
            "summary": str(result.get("summary") or events[0]["summary"]),
            "events": events,
            "stateChanges": state_changes,
            "actorStates": actor_states,
            "warnings": [str(item) for item in result.get("warnings", [])],
            "createdAt": utc_now_iso(),
        }

    def _fallback_round(self, run: NovelSimulationRun, round_number: int) -> dict[str, Any]:
        selected = [
            actor for actor in run.snapshot.actors
            if not run.scenario.selected_actor_ids or actor.id in run.scenario.selected_actor_ids
        ]
        actor = selected[(round_number - 1) % len(selected)] if selected else None
        seed = run.scenario.seed_events[(round_number - 1) % len(run.scenario.seed_events)] \
            if run.scenario.seed_events else run.scenario.objective
        location = run.snapshot.locations[(round_number - 1) % len(run.snapshot.locations)] \
            if run.snapshot.locations else None
        event = {
            "id": f"evt-{round_number}-fallback",
            "round": round_number,
            "title": seed[:48] or f"第 {round_number} 轮演化",
            "summary": f"{actor.name if actor else '世界环境'}围绕“{seed}”产生了新的行动迹象。",
            "actorIds": [actor.id] if actor else [],
            "locationId": location.id if location else None,
            "cause": run.scenario.objective,
            "consequence": "形成待作者审阅的下一轮状态候选。",
            "severity": "medium",
            "ruleIds": [],
            "createdAt": utc_now_iso(),
        }
        return {
            "round": round_number,
            "summary": event["summary"],
            "events": [event],
            "stateChanges": [],
            "actorStates": [{
                "actorId": actor.id,
                "nextIntent": actor.goals[0] if actor and actor.goals else seed,
                "knowledgeGained": [],
            }] if actor else [],
            "warnings": ["模型服务不可用，本轮使用确定性降级推演。"],
            "createdAt": utc_now_iso(),
        }

