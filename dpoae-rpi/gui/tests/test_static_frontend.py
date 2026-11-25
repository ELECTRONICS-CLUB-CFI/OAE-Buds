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


def test_dark_mode_assets_and_print_override() -> None:
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    css = (STATIC_DIR / "css" / "app.css").read_text(encoding="utf-8")

    assert 'id="btn-theme-toggle"' in html
    assert 'id="setting-theme"' in html
    assert ':root[data-theme="dark"]' in css
    assert "@media print" in css
    # Ensure print mode resets back to white paper even when dark mode is active
    print_section = css.split("@media print", 1)[1]
    assert ':root[data-theme="dark"]' in print_section
    assert "--bg: #ffffff" in print_section


def test_dev_tab_hidden_by_default_and_assets_present() -> None:
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    dev_js = (STATIC_DIR / "js" / "dev.js").read_text(encoding="utf-8")
    store_js = (STATIC_DIR / "js" / "store.js").read_text(encoding="utf-8")

    # Dev tab and panel must be hidden by default in clinical mode
    assert 'id="tab-btn-dev" class="tab-btn hidden"' in html
    assert 'id="panel-dev" class="tab-panel hidden' in html
    assert 'id="dev-confirm-modal" class="modal-backdrop hidden"' in html
    assert 'id="btn-dev-confirm"' in html
    assert 'id="setup-dev-overrides-pill"' in html
    assert 'id="dev-use-overrides"' in html
    assert 'id="dev-fft-canvas"' in html
    assert 'id="dev-wave-canvas"' in html
    assert 'id="dev-tone-form"' in html
    assert 'id="dev-console-log"' in html

    # Store defaults dev_mode and dev_overrides_enabled to false and keeps logs ephemeral
    assert "dev_mode: typeof saved.dev_mode === \"boolean\" ? saved.dev_mode : false" in store_js
    assert "dev_overrides_enabled: typeof saved.dev_overrides_enabled === \"boolean\" ? saved.dev_overrides_enabled : false" in store_js
    assert "consoleLogs: []" in store_js
    assert "/api/dev/tone-test" in dev_js
    assert "/api/dev/runs" in dev_js
    assert "/api/dev/spectrum/" in dev_js
    assert "/api/dev/wav/" in dev_js
