from __future__ import annotations

import asyncio
import os
import platform
import re
import uuid
from collections import defaultdict, deque
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Deque, Dict, List, Optional, Set, Tuple

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
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    result: Optional[ConversionResult] = None
    log: List[dict[str, Any]] = field(default_factory=list)


class TaskCreatePayload(BaseModel):
    lcsc_id: str = Field(..., description="LCSC component identifier (e.g. C8733)")
    output_path: str = Field(
        ..., description="Library prefix path (e.g. /path/to/MyLib)"
    )
    overwrite: bool = False
    overwrite_model: bool = Field(
        False, description="Overwrite existing 3D models even if files exist already."
    )
    symbol: bool = False
    footprint: bool = False
    model: bool = Field(False, description="Export 3D model")
    kicad_version: str = Field("v6", pattern=r"^v[56]$")
    project_relative: bool = Field(
        False, description="Store 3D model path relative to project"
    )
    project_relative_path: Optional[str] = Field(
        None, description="Project-relative 3D model path suffix (prefixed by ${KIPRJMOD})"
    )
    model_path: Optional[str] = Field(
        None, description="Explicit 3D model base path to use as-is."
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


class PathRequest(BaseModel):
    path: str


class LibraryScaffoldRequest(BaseModel):
    base_path: str = Field(..., description="Base directory for the library")
    library_name: str = Field(..., description="Library name without extension")
    symbol: bool = True
    footprint: bool = True
    model: bool = True
    project_relative: bool = False

    @model_validator(mode="after")
    def ensure_outputs(cls, payload: "LibraryScaffoldRequest") -> "LibraryScaffoldRequest":
        if not any((payload.symbol, payload.footprint, payload.model)):
            raise ValueError("Select at least one scaffold target.")
        return payload


class LibraryScaffoldResponse(BaseModel):
    resolved_library_prefix: str
    symbol_path: Optional[str]
    footprint_dir: Optional[str]
    model_dir: Optional[str]
    created: Dict[str, bool]


class LibraryValidateRequest(BaseModel):
    path: str


class LibraryValidateResponse(BaseModel):
    resolved_path: str
    exists: bool
    is_dir: bool
    writable: bool
    assets: Dict[str, bool]
    counts: Dict[str, int] = Field(default_factory=dict)
    warnings: List[str] = Field(default_factory=list)
    model_path: Optional[str] = None


class ComponentCheckRequest(BaseModel):
    path: str
    lcsc_id: str

    @field_validator("lcsc_id")
    @classmethod
    def validate_lcsc(cls, value: str) -> str:
        if not value or not value.startswith("C"):
            raise ValueError("LCSC ID must start with 'C'")
        return value


class ComponentCheckResponse(BaseModel):
    symbol_path: Optional[str] = None
    footprint_path: Optional[str] = None
    model_paths: Dict[str, str] = Field(default_factory=dict)
    messages: List[str] = Field(default_factory=list)


class ComponentBatchRequest(BaseModel):
    path: str
    lcsc_ids: List[str]

    @field_validator("lcsc_ids")
    @classmethod
    def validate_lcsc_ids(cls, value: List[str]) -> List[str]:
        cleaned = []
        for entry in value:
            if not entry:
                continue
            entry = entry.strip().upper()
            if not entry.startswith("C"):
                raise ValueError("LCSC ID must start with 'C'")
            cleaned.append(entry)
        if not cleaned:
            raise ValueError("At least one LCSC ID is required.")
        return cleaned


class ComponentBatchResponse(BaseModel):
    results: Dict[str, ComponentCheckResponse] = Field(default_factory=dict)


def _normalize_library_prefix(base_path: str, library_name: str) -> Path:
    try:
        base = Path(base_path).expanduser().resolve(strict=False)
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid base path: {base_path}") from exc
    cleaned_name = (library_name or "").strip()
    if not cleaned_name:
        raise HTTPException(status_code=400, detail="Library name must not be empty.")
    if any(sep in cleaned_name for sep in ("/", "\\")):
        raise HTTPException(status_code=400, detail="Library name must not contain path separators.")
    return base / cleaned_name


def _ensure_directory_writable(path: Path) -> None:
    if not path.exists():
        try:
            path.mkdir(parents=True, exist_ok=True)
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail=f"Missing permissions for '{path}'.") from exc
    if not os.access(str(path), os.W_OK):
        raise HTTPException(status_code=403, detail=f"Directory not writable: {path}")


def _scaffold_library(payload: LibraryScaffoldRequest) -> Tuple[Path, Dict[str, bool], Dict[str, Optional[str]]]:
    prefix = _normalize_library_prefix(payload.base_path, payload.library_name)
    _ensure_directory_writable(prefix.parent)

    created: Dict[str, bool] = {"symbol": False, "footprint": False, "model": False}
    paths: Dict[str, Optional[str]] = {"symbol": None, "footprint": None, "model": None}

    if not prefix.exists():
        try:
            prefix.mkdir(exist_ok=True)
        except OSError as exc:
            raise HTTPException(status_code=403, detail=f"Unable to create library folder: {prefix}") from exc

    symbol_path = prefix.with_suffix(".kicad_sym")
    if payload.symbol:
        if not symbol_path.exists():
            try:
                symbol_path.write_text(
                    "(kicad_symbol_lib\n"
                    "  (version 20211014)\n"
                    "  (generator https://github.com/uPesy/easyeda2kicad.py)\n"
                    ")",
                    encoding="utf-8",
                )
            except OSError as exc:
                raise HTTPException(status_code=403, detail=f"Unable to create symbol file: {symbol_path}") from exc
            created["symbol"] = True
        paths["symbol"] = str(symbol_path)
    elif symbol_path.exists():
        paths["symbol"] = str(symbol_path)

    footprint_dir = prefix.with_suffix(".pretty")
    if payload.footprint:
        if not footprint_dir.exists():
            try:
                footprint_dir.mkdir(exist_ok=True)
            except OSError as exc:
                raise HTTPException(status_code=403, detail=f"Unable to create footprint folder: {footprint_dir}") from exc
            created["footprint"] = True
        paths["footprint"] = str(footprint_dir)
    elif footprint_dir.exists():
        paths["footprint"] = str(footprint_dir)

    if payload.model or payload.footprint:
        model_dir = prefix.with_suffix(".3dshapes")
        created_model = False
        if not model_dir.exists():
            try:
                model_dir.mkdir(exist_ok=True)
            except OSError as exc:
                raise HTTPException(status_code=403, detail=f"Unable to create 3D folder: {model_dir}") from exc
            created_model = True
        if model_dir.exists():
            paths["model"] = str(model_dir)
        if payload.model:
            created["model"] = created_model
        elif created_model:
            created["model"] = True

    return prefix, created, paths


def _inspect_library(path: str) -> LibraryValidateResponse:
    try:
        target = Path(path).expanduser()
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid path: {path}") from exc

    resolved = target.resolve(strict=False)
    is_dir = resolved.is_dir()
    is_file = resolved.is_file()

    assets = {"symbol": False, "footprint": False, "model": False}
    counts = {"symbol": 0, "footprint": 0, "model": 0}
    warnings: List[str] = []

    lower_suffix = resolved.suffix.lower()
    if is_file and lower_suffix in {".kicad_sym", ".lib"}:
        symbol_candidates = [resolved]
        library_root = resolved.with_suffix("")
    else:
        symbol_candidates = [resolved.with_suffix(".kicad_sym"), resolved.with_suffix(".lib")]
        library_root = resolved

    symbol_exists = next((candidate for candidate in symbol_candidates if candidate.is_file()), None)
    if symbol_exists:
        assets["symbol"] = True
        counts["symbol"] = _count_symbols_in_file(symbol_exists)

    footprint_dir = library_root.with_suffix(".pretty")
    footprint_exists = footprint_dir.is_dir()
    if footprint_exists:
        assets["footprint"] = True
        counts["footprint"] = sum(1 for item in footprint_dir.iterdir() if item.is_file() and item.suffix == ".kicad_mod")
    model_path = _extract_model_path(footprint_dir) if footprint_exists else None

    model_dir = library_root.with_suffix(".3dshapes")
    model_exists = model_dir.is_dir()
    if model_exists:
        assets["model"] = True
        counts["model"] = sum(1 for item in model_dir.iterdir() if item.is_file() and item.suffix.lower() == ".wrl")

    exists = resolved.exists() or bool(symbol_exists) or footprint_exists or model_exists

    writable = False
    if symbol_exists:
        writable = os.access(str(symbol_exists.parent), os.W_OK)
        if not writable:
            warnings.append("Bibliotheksdatei kann nicht überschrieben werden.")
    elif exists and is_dir:
        writable = os.access(str(resolved), os.W_OK)
        if not writable:
            warnings.append("Directory is not writable.")
    else:
        parent = resolved.parent
        if parent.exists():
            writable = os.access(str(parent), os.W_OK)
            if not writable:
                warnings.append("Parent directory is not writable.")
        else:
            warnings.append("Parent directory does not exist.")

    return LibraryValidateResponse(
        resolved_path=str(symbol_exists or resolved),
        exists=exists,
        is_dir=is_dir,
        writable=writable,
        assets=assets,
        counts=counts,
        warnings=warnings,
        model_path=model_path,
    )


def _extract_model_path(footprint_dir: Path) -> Optional[str]:
    if not footprint_dir.exists():
        return None
    candidates = list(footprint_dir.glob("*.kicad_mod"))
    for candidate in candidates[:20]:
        try:
            content = candidate.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        match = re.search(r'\(model\s+"([^"]+)"', content)
        if not match:
            match = re.search(r"\(model\s+([^\s\)]+)", content)
        if not match:
            continue
        model_path = match.group(1).strip()
        if not model_path:
            return None
        last_slash = max(model_path.rfind("/"), model_path.rfind("\\"))
        if last_slash == -1:
            return None
        return model_path[:last_slash]
    return None


def _extract_model_paths(footprint_path: Path, model_dir: Path) -> Dict[str, str]:
    try:
        content = footprint_path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return {}

    model_paths: Dict[str, str] = {}
    for match in re.finditer(r'\(model\s+(?:"([^"]+)"|([^\s\)]+))', content):
        raw_path = (match.group(1) or match.group(2) or "").strip()
        if not raw_path:
            continue
        resolved = _resolve_model_candidate(raw_path, model_dir)
        if resolved:
            model_paths[resolved.name] = str(resolved)
    return model_paths


def _resolve_model_candidate(raw_path: str, model_dir: Path) -> Optional[Path]:
    cleaned = raw_path.strip().replace("\\", "/")
    if cleaned.startswith("${KIPRJMOD}"):
        cleaned = cleaned[len("${KIPRJMOD}") :]
    cleaned = cleaned.lstrip("/")

    candidate = Path(cleaned)
    if candidate.is_absolute():
        if candidate.is_file():
            return candidate
        return None

    for base in (model_dir, model_dir.parent):
        resolved = (base / cleaned).resolve(strict=False)
        if resolved.is_file():
            return resolved

    basename = Path(raw_path).name
    if basename:
        fallback = model_dir / basename
        if fallback.is_file():
            return fallback

    return None


def _iter_symbol_blocks_v6(content: str) -> List[str]:
    blocks: List[str] = []
    depth = 0
    in_block = False
    block_lines: List[str] = []
    for line in content.splitlines():
        if not in_block:
            if line.lstrip().startswith("(symbol "):
                in_block = True
                depth = line.count("(") - line.count(")")
                block_lines = [line]
                if depth <= 0:
                    blocks.append("\n".join(block_lines))
                    in_block = False
            continue
        block_lines.append(line)
        depth += line.count("(") - line.count(")")
        if depth <= 0:
            blocks.append("\n".join(block_lines))
            in_block = False
    return blocks


def _iter_symbol_blocks_v5(content: str) -> List[str]:
    blocks: List[str] = []
    block_lines: List[str] = []
    in_block = False
    for line in content.splitlines():
        if not in_block:
            if line.startswith("DEF "):
                in_block = True
                block_lines = [line]
            continue
        block_lines.append(line)
        if line.strip() == "ENDDEF":
            blocks.append("\n".join(block_lines))
            in_block = False
    return blocks


def _find_component_block(content: str, lcsc_id: str, suffix: str) -> Optional[Tuple[str, Optional[str]]]:
    lcsc = lcsc_id.strip()
    if not lcsc:
        return None

    blocks = _iter_symbol_blocks_v6(content) if suffix == ".kicad_sym" else _iter_symbol_blocks_v5(content)
    if not blocks:
        return None

    if suffix == ".kicad_sym":
        lcsc_pattern = re.compile(
            rf'\(property\s+"LCSC Part"\s+"{re.escape(lcsc)}"',
            re.IGNORECASE | re.DOTALL,
        )
        footprint_pattern = re.compile(
            r'\(property\s+"Footprint"\s+"([^"]+)"',
            re.IGNORECASE | re.DOTALL,
        )
    else:
        lcsc_pattern = re.compile(
            rf'^\s*F6\s+"{re.escape(lcsc)}".*LCSC Part',
            re.IGNORECASE | re.MULTILINE,
        )
        footprint_pattern = re.compile(r'^\s*F2\s+"([^"]*)"', re.MULTILINE)

    for block in blocks:
        if not lcsc_pattern.search(block):
            continue
        footprint_match = footprint_pattern.search(block)
        footprint_ref = footprint_match.group(1).strip() if footprint_match else None
        return block, footprint_ref
    return None


def _check_component_in_library(path: str, lcsc_id: str) -> ComponentCheckResponse:
    try:
        target = Path(path).expanduser()
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid path: {path}") from exc

    resolved = target.resolve(strict=False)
    lower_suffix = resolved.suffix.lower()
    if lower_suffix in {".kicad_sym", ".lib"}:
        symbol_candidates = [resolved]
        library_root = resolved.with_suffix("")
    else:
        symbol_candidates = [resolved.with_suffix(".kicad_sym"), resolved.with_suffix(".lib")]
        library_root = resolved

    symbol_path = next((candidate for candidate in symbol_candidates if candidate.is_file()), None)
    if not symbol_path:
        return ComponentCheckResponse(messages=["Symbol library not found."])

    try:
        content = symbol_path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ComponentCheckResponse(messages=["Unable to read symbol library."])

    match = _find_component_block(content, lcsc_id, symbol_path.suffix.lower())
    if not match:
        return ComponentCheckResponse(messages=["Component not found in library."])

    _block, footprint_ref = match
    footprint_path: Optional[Path] = None
    if footprint_ref:
        footprint_name = footprint_ref.split(":")[-1].strip()
        if footprint_name:
            footprint_path = library_root.with_suffix(".pretty") / f"{footprint_name}.kicad_mod"

    model_paths: Dict[str, str] = {}
    if footprint_path and footprint_path.is_file():
        model_dir = library_root.with_suffix(".3dshapes")
        model_paths = _extract_model_paths(footprint_path, model_dir)

    return ComponentCheckResponse(
        symbol_path=str(symbol_path),
        footprint_path=str(footprint_path) if footprint_path and footprint_path.is_file() else None,
        model_paths=model_paths,
        messages=[],
    )


def _index_symbols_by_lcsc(content: str, suffix: str) -> Dict[str, Optional[str]]:
    mapping: Dict[str, Optional[str]] = {}
    if suffix == ".kicad_sym":
        for block in _iter_symbol_blocks_v6(content):
            lcsc_match = re.search(
                r'\(property\s+"LCSC Part"\s+"([^"]+)"',
                block,
                re.IGNORECASE | re.DOTALL,
            )
            if not lcsc_match:
                continue
            lcsc_id = lcsc_match.group(1).strip().upper()
            footprint_match = re.search(
                r'\(property\s+"Footprint"\s+"([^"]+)"',
                block,
                re.IGNORECASE | re.DOTALL,
            )
            footprint_ref = footprint_match.group(1).strip() if footprint_match else None
            mapping[lcsc_id] = footprint_ref
        return mapping

    for block in _iter_symbol_blocks_v5(content):
        lcsc_match = re.search(
            r'^\s*F6\s+"([^"]+)".*LCSC Part',
            block,
            re.IGNORECASE | re.MULTILINE,
        )
        if not lcsc_match:
            continue
        lcsc_id = lcsc_match.group(1).strip().upper()
        footprint_match = re.search(r'^\s*F2\s+"([^"]*)"', block, re.MULTILINE)
        footprint_ref = footprint_match.group(1).strip() if footprint_match else None
        mapping[lcsc_id] = footprint_ref
    return mapping


def _check_components_in_library(path: str, lcsc_ids: List[str]) -> ComponentBatchResponse:
    try:
        target = Path(path).expanduser()
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid path: {path}") from exc

    resolved = target.resolve(strict=False)
    lower_suffix = resolved.suffix.lower()
    if lower_suffix in {".kicad_sym", ".lib"}:
        symbol_candidates = [resolved]
        library_root = resolved.with_suffix("")
    else:
        symbol_candidates = [resolved.with_suffix(".kicad_sym"), resolved.with_suffix(".lib")]
        library_root = resolved

    symbol_path = next((candidate for candidate in symbol_candidates if candidate.is_file()), None)
    results: Dict[str, ComponentCheckResponse] = {}
    if not symbol_path:
        for lcsc_id in lcsc_ids:
            results[lcsc_id] = ComponentCheckResponse(messages=["Symbol library not found."])
        return ComponentBatchResponse(results=results)

    try:
        content = symbol_path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        for lcsc_id in lcsc_ids:
            results[lcsc_id] = ComponentCheckResponse(messages=["Unable to read symbol library."])
        return ComponentBatchResponse(results=results)

    index = _index_symbols_by_lcsc(content, symbol_path.suffix.lower())

    for lcsc_id in lcsc_ids:
        footprint_ref = index.get(lcsc_id)
        if not footprint_ref:
            results[lcsc_id] = ComponentCheckResponse(messages=["Component not found in library."])
            continue
        footprint_name = footprint_ref.split(":")[-1].strip()
        footprint_path = (
            library_root.with_suffix(".pretty") / f"{footprint_name}.kicad_mod"
            if footprint_name
            else None
        )
        model_paths: Dict[str, str] = {}
        if footprint_path and footprint_path.is_file():
            model_dir = library_root.with_suffix(".3dshapes")
            model_paths = _extract_model_paths(footprint_path, model_dir)
        results[lcsc_id] = ComponentCheckResponse(
            symbol_path=str(symbol_path),
            footprint_path=str(footprint_path) if footprint_path and footprint_path.is_file() else None,
            model_paths=model_paths,
            messages=[],
        )
    return ComponentBatchResponse(results=results)


def _count_symbols_in_file(path: Path) -> int:
    try:
        content = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return 1

    matches = re.findall(r"\(\s*symbol\b", content)
    return len(matches) or 1


def _fs_roots() -> List[dict[str, str]]:
    roots: List[dict[str, str]] = []
    seen: set[str] = set()

    if os.name == "nt":
        from string import ascii_uppercase

        for letter in ascii_uppercase:
            drive_path = Path(f"{letter}:/").resolve()
            if drive_path.exists():
                path_str = str(drive_path)
                if path_str not in seen:
                    roots.append(
                        {
                            "path": path_str,
                            "label": f"{letter}:\\",
                        }
                    )
                    seen.add(path_str)
    else:
        root_path = Path("/").resolve()
        roots.append({"path": str(root_path), "label": "/"})
        seen.add(str(root_path))

    home_path = Path.home().resolve()
    if str(home_path) not in seen:
        roots.append({"path": str(home_path), "label": str(home_path)})
        seen.add(str(home_path))

    # Add common user directories if they exist
    for relative in ("Documents", "Downloads", "Desktop"):
        candidate = home_path / relative
        if candidate.exists():
            path_str = str(candidate.resolve())
            if path_str not in seen:
                roots.append({"path": path_str, "label": path_str})
                seen.add(path_str)

    return roots


def _fs_list_directory(path: str) -> dict[str, Any]:
    try:
        target = Path(path).expanduser().resolve(strict=False)
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid path: {path}") from exc

    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Path does not exist: {path}")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail=f"Path is not a directory: {path}")

    entries: List[dict[str, Any]] = []
    try:
        with os.scandir(target) as it:
            for entry in it:
                entries.append(
                    {
                        "name": entry.name,
                        "path": str(Path(entry.path).resolve(strict=False)),
                        "is_dir": entry.is_dir(follow_symlinks=False),
                        "is_symlink": entry.is_symlink(),
                    }
                )
    except PermissionError as exc:
        raise HTTPException(
            status_code=403, detail=f"Access denied for directory: {path}"
        ) from exc

    entries.sort(key=lambda item: (not item["is_dir"], item["name"].lower()))

    parent = str(target.parent) if target.parent != target else None

    breadcrumbs: List[dict[str, str]] = []
    current = target
    seen: Set[str] = set()
    while True:
        label = current.name or current.drive or "/"
        breadcrumbs.append({"label": label, "path": str(current)})
        current_str = str(current)
        if current_str in seen or current == current.parent:
            break
        seen.add(current_str)
        current = current.parent
    breadcrumbs.reverse()

    return {"path": str(target), "parent": parent, "entries": entries, "breadcrumbs": breadcrumbs}


def _fs_check(path: str) -> dict[str, Any]:
    target = Path(path).expanduser()
    resolved = target.resolve(strict=False)
    exists = target.exists()
    is_dir = target.is_dir()

    if exists and is_dir:
        writable = os.access(str(target), os.W_OK)
    else:
        parent = target.parent if target.suffix else target.parent
        writable = parent.exists() and os.access(str(parent), os.W_OK)

    return {
        "requested": path,
        "resolved": str(resolved),
        "exists": exists,
        "is_dir": is_dir,
        "writable": writable,
    }


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
            record.updated_at = datetime.now(UTC)
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
                record.finished_at = datetime.now(UTC)
            elif stage == ConversionStage.FAILED:
                record.status = TaskStatus.FAILED
                record.finished_at = datetime.now(UTC)
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
                task.started_at = datetime.now(UTC)
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
                    task.finished_at = datetime.now(UTC)
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
                    task.finished_at = datetime.now(UTC)
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

    async def start_worker() -> None:
        if app.state.worker_task is None or app.state.worker_task.done():
            app.state.worker_task = asyncio.create_task(worker())

    async def stop_worker() -> None:
        worker_task = app.state.worker_task
        if not worker_task:
            return
        await app.state.queue.join()
        worker_task.cancel()
        with suppress(asyncio.CancelledError):
            await worker_task
        app.state.worker_task = None

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await start_worker()
        try:
            yield
        finally:
            await stop_worker()

    app.router.lifespan_context = lifespan
    app.state.start_worker = start_worker
    app.state.stop_worker = stop_worker

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
                overwrite_model=payload.overwrite_model,
                generate_symbol=payload.symbol,
                generate_footprint=payload.footprint,
                generate_model=payload.model,
                kicad_version=version,
                project_relative=payload.project_relative,
                project_relative_path=payload.project_relative_path,
                model_path=payload.model_path,
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

    @router.get("/fs/roots")
    async def fs_roots() -> List[dict[str, str]]:
        return _fs_roots()

    @router.get("/fs/list")
    async def fs_list(path: str) -> Dict[str, Any]:
        return _fs_list_directory(path)

    @router.post("/fs/check")
    async def fs_check(payload: PathRequest) -> Dict[str, Any]:
        return _fs_check(payload.path)

    @router.post(
        "/libraries/scaffold", response_model=LibraryScaffoldResponse, status_code=status.HTTP_201_CREATED
    )
    async def libraries_scaffold(payload: LibraryScaffoldRequest) -> LibraryScaffoldResponse:
        prefix, created, paths = _scaffold_library(payload)
        return LibraryScaffoldResponse(
            resolved_library_prefix=str(prefix),
            symbol_path=paths.get("symbol"),
            footprint_dir=paths.get("footprint"),
            model_dir=paths.get("model"),
            created=created,
        )

    @router.post("/libraries/validate", response_model=LibraryValidateResponse)
    async def libraries_validate(payload: LibraryValidateRequest) -> LibraryValidateResponse:
        return _inspect_library(payload.path)

    @router.post("/libraries/component", response_model=ComponentCheckResponse)
    async def libraries_component(payload: ComponentCheckRequest) -> ComponentCheckResponse:
        return _check_component_in_library(payload.path, payload.lcsc_id)

    @router.post("/libraries/components", response_model=ComponentBatchResponse)
    async def libraries_components(payload: ComponentBatchRequest) -> ComponentBatchResponse:
        return _check_components_in_library(payload.path, payload.lcsc_ids)

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


async def startup_app(app: FastAPI) -> None:
    start_worker = getattr(app.state, "start_worker", None)
    if callable(start_worker):
        await start_worker()


async def shutdown_app(app: FastAPI) -> None:
    stop_worker = getattr(app.state, "stop_worker", None)
    if callable(stop_worker):
        await stop_worker()
