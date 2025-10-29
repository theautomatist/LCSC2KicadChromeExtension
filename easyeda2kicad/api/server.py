from __future__ import annotations

import asyncio
import contextlib
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Deque, Dict, List, Optional, Set

from fastapi import (
    APIRouter,
    Depends,
    FastAPI,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator, model_validator

from easyeda2kicad.kicad.parameters_kicad_symbol import KicadVersion
from easyeda2kicad.service import (
    ConversionError,
    ConversionRequest,
    ConversionResult,
    ConversionStage,
    run_conversion,
)


class TaskStatus(str):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class TaskRecord:
    id: str
    request: ConversionRequest
    status: str = TaskStatus.QUEUED
    progress: int = 0
    message: Optional[str] = None
    error: Optional[str] = None
    created_at: datetime = field(default_factory=datetime.utcnow)
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    updated_at: datetime = field(default_factory=datetime.utcnow)
    result: Optional[ConversionResult] = None
    log: List[dict[str, Any]] = field(default_factory=list)


class TaskCreatePayload(BaseModel):
    lcsc_id: str = Field(..., description="LCSC component identifier (e.g. C8733)")
    output_path: str = Field(
        ..., description="Library prefix path (e.g. /path/to/MyLib)"
    )
    overwrite: bool = False
    symbol: bool = False
    footprint: bool = False
    model: bool = Field(False, description="Export 3D model")
    kicad_version: str = Field("v6", pattern=r"^v[56]$")
    project_relative: bool = Field(
        False, description="Store 3D model path relative to project"
    )

    @field_validator("lcsc_id")
    @classmethod
    def validate_lcsc(cls, value: str) -> str:
        if not value or not value.startswith("C"):
            raise ValueError("LCSC ID must start with 'C'")
        return value
    @model_validator(mode="after")
    def ensure_target_selected(cls, payload: "TaskCreatePayload") -> "TaskCreatePayload":
        if not any([payload.symbol, payload.footprint, payload.model]):
            raise ValueError("Select at least one output: symbol, footprint or model.")
        return payload


class ConversionResultModel(BaseModel):
    symbol_path: Optional[str] = None
    footprint_path: Optional[str] = None
    model_paths: Dict[str, str] = Field(default_factory=dict)
    messages: List[str] = Field(default_factory=list)


class TaskSummary(BaseModel):
    id: str
    status: str
    progress: int
    message: Optional[str]
    queue_position: Optional[int]
    error: Optional[str]
    created_at: datetime
    started_at: Optional[datetime]
    finished_at: Optional[datetime]
    result: Optional[ConversionResultModel]


class TaskDetail(TaskSummary):
    log: List[dict[str, Any]]


def create_app(
    conversion_runner: Callable[[ConversionRequest, Optional[Callable]], ConversionResult]
    = run_conversion,
) -> FastAPI:
    router = APIRouter()
    app = FastAPI(
        title="easyeda2kicad API",
        description="REST/WebSocket interface for easyeda2kicad conversions.",
        version="0.1.0",
    )

    app.state.conversion_runner = conversion_runner
    app.state.queue: asyncio.Queue[TaskRecord] = asyncio.Queue()
    app.state.pending: Deque[str] = deque()
    app.state.tasks: Dict[str, TaskRecord] = {}
    app.state.task_lock = asyncio.Lock()
    app.state.subscribers: Dict[str, Set[WebSocket]] = defaultdict(set)
    app.state.worker_task: Optional[asyncio.Task[Any]] = None

    async def get_task(task_id: str) -> TaskRecord:
        async with app.state.task_lock:
            record = app.state.tasks.get(task_id)
        if not record:
            raise HTTPException(status_code=404, detail="Task not found.")
        return record

    def queue_position(task_id: str) -> Optional[int]:
        try:
            return app.state.pending.index(task_id) + 1
        except ValueError:
            return None

    def as_summary(record: TaskRecord) -> TaskSummary:
        return TaskSummary(
            id=record.id,
            status=record.status,
            progress=record.progress,
            message=record.message,
            queue_position=queue_position(record.id),
            error=record.error,
            created_at=record.created_at,
            started_at=record.started_at,
            finished_at=record.finished_at,
            result=ConversionResultModel(
                symbol_path=record.result.symbol_path if record.result else None,
                footprint_path=record.result.footprint_path if record.result else None,
                model_paths=record.result.model_paths if record.result else {},
                messages=record.result.messages if record.result else [],
            )
            if record.result
            else None,
        )

    def as_detail(record: TaskRecord) -> TaskDetail:
        summary = as_summary(record)
        return TaskDetail(**summary.model_dump(), log=record.log)

    async def broadcast(task_id: str) -> None:
        async with app.state.task_lock:
            record = app.state.tasks.get(task_id)
            subscribers = list(app.state.subscribers.get(task_id, set()))
        if not record:
            return
        payload = as_summary(record).model_dump()
        disconnects: List[WebSocket] = []
        for websocket in subscribers:
            try:
                await websocket.send_json(payload)
            except WebSocketDisconnect:
                disconnects.append(websocket)
            except RuntimeError:
                disconnects.append(websocket)
        if disconnects:
            async with app.state.task_lock:
                for websocket in disconnects:
                    app.state.subscribers[task_id].discard(websocket)

    async def broadcast_queue_changes() -> None:
        async with app.state.task_lock:
            pending_ids = list(app.state.pending)
        for task_id in pending_ids:
            await broadcast(task_id)

    async def update_progress(
        task_id: str, stage: ConversionStage, percent: int, message: Optional[str]
    ) -> None:
        async with app.state.task_lock:
            record = app.state.tasks.get(task_id)
            if not record:
                return
            record.progress = max(0, min(100, percent))
            record.message = message
            record.updated_at = datetime.utcnow()
            record.log.append(
                {
                    "timestamp": record.updated_at.isoformat(),
                    "stage": stage.name,
                    "message": message,
                    "progress": record.progress,
                }
            )
            if stage == ConversionStage.COMPLETED:
                record.status = TaskStatus.COMPLETED
                record.finished_at = datetime.utcnow()
            elif stage == ConversionStage.FAILED:
                record.status = TaskStatus.FAILED
                record.finished_at = datetime.utcnow()
            else:
                record.status = TaskStatus.RUNNING
        await broadcast(task_id)

    async def worker() -> None:
        loop = asyncio.get_running_loop()
        while True:
            task = await app.state.queue.get()
            async with app.state.task_lock:
                if app.state.pending and app.state.pending[0] == task.id:
                    app.state.pending.popleft()
                task.status = TaskStatus.RUNNING
                task.started_at = datetime.utcnow()
                task.updated_at = task.started_at
            await broadcast(task.id)
            await broadcast_queue_changes()

            def progress_callback(
                stage: ConversionStage, percent: int, message: Optional[str]
            ) -> None:
                asyncio.run_coroutine_threadsafe(
                    update_progress(task.id, stage, percent, message), loop
                )

            try:
                result = await asyncio.to_thread(
                    app.state.conversion_runner, task.request, progress_callback
                )
            except Exception as exc:  # pragma: no cover - defensive catch
                async with app.state.task_lock:
                    task.status = TaskStatus.FAILED
                    task.error = str(exc)
                    task.message = str(exc)
                    task.progress = task.progress or 0
                    task.finished_at = datetime.utcnow()
                    task.updated_at = task.finished_at
                    task.log.append(
                        {
                            "timestamp": task.updated_at.isoformat(),
                            "stage": ConversionStage.FAILED.name,
                            "message": task.error,
                            "progress": task.progress,
                        }
                    )
                await broadcast(task.id)
            else:
                async with app.state.task_lock:
                    task.status = TaskStatus.COMPLETED
                    task.result = result
                    task.progress = max(task.progress, 100)
                    task.message = "Conversion finished."
                    task.finished_at = datetime.utcnow()
                    task.updated_at = task.finished_at
                    task.log.append(
                        {
                            "timestamp": task.updated_at.isoformat(),
                            "stage": ConversionStage.COMPLETED.name,
                            "message": task.message,
                            "progress": task.progress,
                        }
                    )
                await broadcast(task.id)

            app.state.queue.task_done()

    @app.on_event("startup")
    async def startup() -> None:
        if app.state.worker_task is None:
            app.state.worker_task = asyncio.create_task(worker())

    @app.on_event("shutdown")
    async def shutdown() -> None:
        await app.state.queue.join()
        if app.state.worker_task:
            app.state.worker_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await app.state.worker_task
            app.state.worker_task = None

    @router.post(
        "/tasks", status_code=status.HTTP_202_ACCEPTED, response_model=TaskSummary
    )
    async def enqueue_task(payload: TaskCreatePayload) -> TaskSummary:
        version = KicadVersion.v6 if payload.kicad_version == "v6" else KicadVersion.v5
        try:
            request = ConversionRequest(
                lcsc_id=payload.lcsc_id,
                output_prefix=payload.output_path,
                overwrite=payload.overwrite,
                generate_symbol=payload.symbol,
                generate_footprint=payload.footprint,
                generate_model=payload.model,
                kicad_version=version,
                project_relative=payload.project_relative,
            )
        except ConversionError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        task_id = str(uuid.uuid4())
        record = TaskRecord(id=task_id, request=request)

        async with app.state.task_lock:
            app.state.tasks[task_id] = record
            app.state.pending.append(task_id)
            await app.state.queue.put(record)

        await broadcast_queue_changes()
        await broadcast(task_id)

        return as_summary(record)

    @router.get("/tasks", response_model=List[TaskSummary])
    async def list_tasks() -> List[TaskSummary]:
        async with app.state.task_lock:
            records = list(app.state.tasks.values())
        return [as_summary(record) for record in records]

    @router.get("/tasks/{task_id}", response_model=TaskDetail)
    async def retrieve_task(task: TaskRecord = Depends(get_task)) -> TaskDetail:
        return as_detail(task)

    @router.get("/health")
    async def health() -> JSONResponse:
        return JSONResponse({"status": "ok"})

    @app.websocket("/ws/tasks/{task_id}")
    async def task_updates(websocket: WebSocket, task_id: str) -> None:
        await websocket.accept()
        async with app.state.task_lock:
            record = app.state.tasks.get(task_id)
            if not record:
                await websocket.send_json({"error": "Task not found."})
                await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
                return
            app.state.subscribers[task_id].add(websocket)
        await broadcast(task_id)
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            async with app.state.task_lock:
                app.state.subscribers[task_id].discard(websocket)

    app.include_router(router)

    return app
