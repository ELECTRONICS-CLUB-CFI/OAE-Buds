"""Tests verifying offline static frontend serving, zero-CDN compliance, and asset integrity."""

from __future__ import annotations

import re
from pathlib import Path

from fastapi.testclient import TestClient

from gui.app.main import create_app


REPO_ROOT = Path(__file__).resolve().parents[2]
STATIC_DIR = REPO_ROOT / "gui" / "static"


def test_root_serves_index_html_and_all_static_assets(tmp_path: Path) -> None:
    app = create_app(
        repo_root=REPO_ROOT,
        results_dir=tmp_path / "results",
        cards_path=tmp_path / "missing_cards",
    )

    with TestClient(app) as client:
        root_resp = client.get("/")
        assert root_resp.status_code == 200
        assert "text/html" in root_resp.headers.get("content-type", "")
        html = root_resp.text
        assert "OAE Buds" in html

        # Every /static/... path referenced in index.html must load cleanly
        refs = re.findall(r'(?:src|href)="(/static/[^"]+)"', html)
        assert "/static/css/app.css" in refs
        assert "/static/vendor/chart.umd.min.js" in refs
        assert "/static/js/app.js" in refs

        for ref in refs:
            r = client.get(ref)
            assert r.status_code == 200, f"Failed to fetch {ref}"
            assert len(r.content) > 0

        # Every ES6 module file under static/js/ must also be served
        for js_file in (STATIC_DIR / "js").glob("*.js"):
            r = client.get(f"/static/js/{js_file.name}")
            assert r.status_code == 200, f"Failed to fetch JS module {js_file.name}"


def test_frontend_has_zero_external_cdn_links() -> None:
    asset_files = [
        STATIC_DIR / "index.html",
        STATIC_DIR / "css" / "app.css",
        *sorted((STATIC_DIR / "js").glob("*.js")),
    ]
    external_url_re = re.compile(r"https?://", re.IGNORECASE)

    for path in asset_files:
        text = path.read_text(encoding="utf-8")
        assert not external_url_re.search(text), f"External URL found in offline asset: {path}"
