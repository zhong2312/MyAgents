"""Typed contracts for novel-world simulations."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class ApiModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class NovelSimulationStatus(str, Enum):
    DRAFT = "draft"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    FAILED = "failed"


class NovelSourceRef(ApiModel):
    path: str
    source_hash: str = Field(default="", alias="sourceHash")
    authority: Literal["canon", "actual", "planned", "belief", "author-secret"]


class NovelActorSnapshot(ApiModel):
    id: str
    name: str
    kind: Literal["character", "faction", "group"] = "character"
    summary: str = ""
    location_id: str | None = Field(default=None, alias="locationId")
    goals: list[str] = Field(default_factory=list)
    traits: list[str] = Field(default_factory=list)
    resources: list[str] = Field(default_factory=list)
    knowledge: list[str] = Field(default_factory=list)
    constraints: list[str] = Field(default_factory=list)
    source_refs: list[NovelSourceRef] = Field(default_factory=list, alias="sourceRefs")

    @field_validator("id", "name")
    @classmethod
    def require_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be empty")
        return value


class NovelLocationSnapshot(ApiModel):
    id: str
    name: str
    summary: str = ""
    parent_id: str | None = Field(default=None, alias="parentId")
    source_refs: list[NovelSourceRef] = Field(default_factory=list, alias="sourceRefs")


class NovelRuleSnapshot(ApiModel):
    id: str
    title: str
    description: str
    severity: Literal["hard", "soft"] = "hard"
    source_refs: list[NovelSourceRef] = Field(default_factory=list, alias="sourceRefs")


class NovelTimelineEventSnapshot(ApiModel):
    id: str
    title: str
    summary: str = ""
    time_label: str = Field(default="", alias="timeLabel")
    actor_ids: list[str] = Field(default_factory=list, alias="actorIds")
    location_ids: list[str] = Field(default_factory=list, alias="locationIds")
    source_refs: list[NovelSourceRef] = Field(default_factory=list, alias="sourceRefs")


class NovelWorldSnapshot(ApiModel):
    schema_version: Literal[1] = Field(default=1, alias="schemaVersion")
    project_id: str = Field(alias="projectId")
    title: str
    source_revision: str = Field(alias="sourceRevision")
    anchor: str = ""
    actors: list[NovelActorSnapshot] = Field(default_factory=list)
    locations: list[NovelLocationSnapshot] = Field(default_factory=list)
    rules: list[NovelRuleSnapshot] = Field(default_factory=list)
    timeline_events: list[NovelTimelineEventSnapshot] = Field(
        default_factory=list,
        alias="timelineEvents",
    )

    @model_validator(mode="after")
    def validate_references(self) -> "NovelWorldSnapshot":
        actor_ids = [actor.id for actor in self.actors]
        location_ids = [location.id for location in self.locations]
        rule_ids = [rule.id for rule in self.rules]
        for label, values in (
            ("actor", actor_ids),
            ("location", location_ids),
            ("rule", rule_ids),
        ):
            if len(values) != len(set(values)):
                raise ValueError(f"duplicate {label} id")
        known_locations = set(location_ids)
        known_actors = set(actor_ids)
        for actor in self.actors:
            if actor.location_id and actor.location_id not in known_locations:
                raise ValueError(f"actor {actor.id} references an unknown location")
        for event in self.timeline_events:
            if any(actor_id not in known_actors for actor_id in event.actor_ids):
                raise ValueError(f"timeline event {event.id} references an unknown actor")
            if any(location_id not in known_locations for location_id in event.location_ids):
                raise ValueError(f"timeline event {event.id} references an unknown location")
        return self


class NovelSimulationScenario(ApiModel):
    schema_version: Literal[1] = Field(default=1, alias="schemaVersion")
    id: str
    name: str
    objective: str
    horizon_rounds: int = Field(default=5, ge=1, le=30, alias="horizonRounds")
    selected_actor_ids: list[str] = Field(default_factory=list, alias="selectedActorIds")
    seed_events: list[str] = Field(default_factory=list, alias="seedEvents")
    constraints: list[str] = Field(default_factory=list)

    @field_validator("id", "name", "objective")
    @classmethod
    def require_scenario_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("scenario text must not be empty")
        if len(value) > 4_000:
            raise ValueError("scenario text is too long")
        return value


class NovelSimulationModelSelection(ApiModel):
    provider_id: str = Field(alias="providerId")
    model: str

    @field_validator("provider_id", "model")
    @classmethod
    def require_selection_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("model selection values must not be empty")
        if len(value) > 256:
            raise ValueError("model selection value is too long")
        return value


class NovelSimulationRun(ApiModel):
    schema_version: Literal[1] = Field(default=1, alias="schemaVersion")
    run_id: str = Field(alias="runId")
    project_id: str = Field(alias="projectId")
    engine: str = "mirofish-explorer"
    engine_version: str = Field(default="0.2.0-explorer", alias="engineVersion")
    status: NovelSimulationStatus = NovelSimulationStatus.DRAFT
    current_round: int = Field(default=0, alias="currentRound")
    max_rounds: int = Field(alias="maxRounds")
    snapshot: NovelWorldSnapshot
    scenario: NovelSimulationScenario
    workspace_path: str = Field(default="", alias="workspacePath")
    model_selections: dict[str, NovelSimulationModelSelection] = Field(
        default_factory=dict,
        alias="modelSelections",
    )
    model_proxy_url: str | None = Field(default=None, alias="modelProxyUrl")
    rounds: list[dict[str, Any]] = Field(default_factory=list)
    events: list[dict[str, Any]] = Field(default_factory=list)
    state_changes: list[dict[str, Any]] = Field(default_factory=list, alias="stateChanges")
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None
    created_at: str = Field(default_factory=utc_now_iso, alias="createdAt")
    updated_at: str = Field(default_factory=utc_now_iso, alias="updatedAt")
    completed_at: str | None = Field(default=None, alias="completedAt")

    def to_wire(self) -> dict[str, Any]:
        return self.model_dump(mode="json", by_alias=True)
