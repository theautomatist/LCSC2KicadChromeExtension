"""FastAPI application exposing easyeda2kicad services."""

from .server import create_app

__all__ = ["create_app"]
