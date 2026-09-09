"""Backend tests for the Auto Check-in / Check-out feature in
POST /api/attendance/match.

Covers:
- Auto with no prior record today -> Check-in
- Auto with last record today = Check-in -> Check-out
- Auto with last record today = Check-out -> Check-in (cycles)
- Auto with only PREVIOUS IST day record -> Check-in (treated as no record today)
- Explicit type "Check-in" -> Check-in (even when last today is Check-in)
- Explicit type "Check-out" -> Check-out (verbatim)
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from urllib.request import Request, urlopen

import pytest
import requests
from dotenv import load_dotenv
from PIL import Image

load_dotenv("/app/backend/.env")
load_dotenv("/app/frontend/.env")
sys.path.insert(0, "/app/backend")

from server import (  # noqa: E402
    AttendanceRecord,
    Employee,
    OtpCode,
    SessionLocal,
    Supervisor,
    now_ist,
    password_hash,
)

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/") + "/api"


# ---------- fixtures ----------
@pytest.fixture(scope="module")
def token() -> str:
    with SessionLocal() as db:
        sup = db.query(Supervisor).first()
        assert sup, "no supervisor row seeded"
        email = sup.email
        db.query(OtpCode).filter(OtpCode.email == email.lower()).delete()
        db.add(
            OtpCode(
                email=email.lower(),
                code_hash=password_hash.hash("123456"),
                expires_at=datetime.now(timezone.utc).replace(tzinfo=None)
                + timedelta(minutes=5),
                attempts=0,
            )
        )
        db.commit()

    r = requests.post(
        f"{BASE_URL}/auth/verify-otp",
        json={"email": email, "otp": "123456"},
        timeout=60,
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def headers(token) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def ramesh_id() -> str:
    with SessionLocal() as db:
        emp = db.query(Employee).filter(Employee.code == "DHD-1042").first()
        assert emp, "DHD-1042 not seeded"
        return emp.id


@pytest.fixture(scope="module")
def ramesh_face_b64() -> str:
    """Load DHD-1042 stock photo, ensure face encoding is enrolled, and
    return a base64 JPEG that, when POSTed to /attendance/match, matches."""
    with SessionLocal() as db:
        emp = db.query(Employee).filter(Employee.code == "DHD-1042").first()
        url = emp.photo
    if url.startswith("data:"):
        b64 = url.split(",", 1)[1]
    else:
        req = Request(url, headers={"User-Agent": "pytest/1.0"})
        data = urlopen(req, timeout=15).read()
        im = Image.open(io.BytesIO(data)).convert("RGB")
        im.thumbnail((640, 640))
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=80)
        b64 = base64.b64encode(buf.getvalue()).decode()
    return b64


@pytest.fixture(autouse=True)
def _wipe_today_attendance(ramesh_id):
    """Ensure a clean slate before EACH auto/explicit test so ordering
    of tests does not affect the outcome."""
    with SessionLocal() as db:
        db.query(AttendanceRecord).filter(
            AttendanceRecord.employee_id == ramesh_id
        ).delete()
        db.commit()
    yield
    with SessionLocal() as db:
        db.query(AttendanceRecord).filter(
            AttendanceRecord.employee_id == ramesh_id
        ).delete()
        db.commit()


# ---------- helpers ----------
def _match(headers, image_b64, type_: str = "Auto"):
    r = requests.post(
        f"{BASE_URL}/attendance/match",
        headers=headers,
        json={"image_b64": image_b64, "type": type_, "threshold": 0.6},
        timeout=60,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["matched"] is True, body
    assert body["matches"], body
    return body


def _first_match_type(body) -> str:
    hit = next((m for m in body["matches"] if m["matched"]), None)
    assert hit is not None, body
    return hit["attendance"]["type"]


# ---------- Auto behaviour ----------
class TestAutoBehaviour:
    """The `type: "Auto"` default should let the backend flip between
    Check-in and Check-out based on the employee's last record today."""

    def test_auto_no_prior_record_writes_checkin(
        self, headers, ramesh_face_b64, ramesh_id
    ):
        body = _match(headers, ramesh_face_b64, "Auto")
        assert body["attendance"]["type"] == "Check-in"
        assert _first_match_type(body) == "Check-in"

        with SessionLocal() as db:
            rec = (
                db.query(AttendanceRecord)
                .filter(AttendanceRecord.employee_id == ramesh_id)
                .order_by(AttendanceRecord.marked_at.desc())
                .first()
            )
            assert rec is not None
            assert rec.type == "Check-in"

    def test_auto_last_checkin_writes_checkout(
        self, headers, ramesh_face_b64, ramesh_id
    ):
        # Seed a Check-in for today directly
        with SessionLocal() as db:
            db.add(
                AttendanceRecord(
                    employee_id=ramesh_id,
                    type="Check-in",
                    time="08:00 AM",
                    status="On Time",
                )
            )
            db.commit()

        body = _match(headers, ramesh_face_b64, "Auto")
        assert body["attendance"]["type"] == "Check-out"

    def test_auto_last_checkout_cycles_back_to_checkin(
        self, headers, ramesh_face_b64, ramesh_id
    ):
        with SessionLocal() as db:
            db.add(
                AttendanceRecord(
                    employee_id=ramesh_id,
                    type="Check-in",
                    time="08:00 AM",
                    status="On Time",
                )
            )
            db.commit()
            db.add(
                AttendanceRecord(
                    employee_id=ramesh_id,
                    type="Check-out",
                    time="12:00 PM",
                    status="On Time",
                )
            )
            db.commit()

        body = _match(headers, ramesh_face_b64, "Auto")
        assert body["attendance"]["type"] == "Check-in"

    def test_auto_only_previous_ist_day_treated_as_no_record(
        self, headers, ramesh_face_b64, ramesh_id
    ):
        """A stale Check-in from a previous IST day must NOT influence
        today's auto decision; the write should still be Check-in."""
        yesterday_ist = (now_ist().date() - timedelta(days=1))
        with SessionLocal() as db:
            db.add(
                AttendanceRecord(
                    employee_id=ramesh_id,
                    type="Check-in",
                    time="08:00 AM",
                    status="On Time",
                    day=yesterday_ist,
                )
            )
            db.commit()

        body = _match(headers, ramesh_face_b64, "Auto")
        assert body["attendance"]["type"] == "Check-in", body

        # Also confirm the previous-day row was NOT touched
        with SessionLocal() as db:
            count_yday = (
                db.query(AttendanceRecord)
                .filter(
                    AttendanceRecord.employee_id == ramesh_id,
                    AttendanceRecord.day == yesterday_ist,
                )
                .count()
            )
            assert count_yday == 1


# ---------- Explicit overrides ----------
class TestExplicitOverrides:
    """When the client sends an explicit type, the backend must honour it
    verbatim — even if it would appear "wrong" versus the last record."""

    def test_explicit_checkin_verbatim_after_existing_checkin(
        self, headers, ramesh_face_b64, ramesh_id
    ):
        with SessionLocal() as db:
            db.add(
                AttendanceRecord(
                    employee_id=ramesh_id,
                    type="Check-in",
                    time="08:00 AM",
                    status="On Time",
                )
            )
            db.commit()

        body = _match(headers, ramesh_face_b64, "Check-in")
        assert body["attendance"]["type"] == "Check-in", body

    def test_explicit_checkout_verbatim(
        self, headers, ramesh_face_b64
    ):
        body = _match(headers, ramesh_face_b64, "Check-out")
        assert body["attendance"]["type"] == "Check-out", body


# ---------- Validation ----------
class TestPayloadValidation:
    def test_invalid_type_rejected(self, headers, ramesh_face_b64):
        r = requests.post(
            f"{BASE_URL}/attendance/match",
            headers=headers,
            json={"image_b64": ramesh_face_b64, "type": "Bogus"},
            timeout=30,
        )
        assert r.status_code == 422, r.text

    def test_default_type_is_auto(self, headers, ramesh_face_b64, ramesh_id):
        """Omitting `type` from the payload should default to Auto.
        With no prior record today, that means Check-in."""
        r = requests.post(
            f"{BASE_URL}/attendance/match",
            headers=headers,
            json={"image_b64": ramesh_face_b64, "threshold": 0.6},
            timeout=60,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["matched"] is True
        assert body["attendance"]["type"] == "Check-in"
