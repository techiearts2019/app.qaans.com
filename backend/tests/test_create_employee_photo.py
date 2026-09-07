"""Backend tests for the "Add Employee with photo" fix.

User reported bug: after Add Employee flow the DB row had `photo=NULL`
and `face_encoding=NULL` even though a photo was captured on-device.

Fix under test lives in server.py::create_employee:
 - accepts `photo_b64` (raw base64 JPEG) — decodes, runs quality/enrolment
   assessment, stores as `data:image/jpeg;base64,…`, saves 128-d encoding.
 - rejects any `photo` starting with `file:` (422) so unreachable URIs
   never poison the DB again.
 - rejects `photo_b64` whose image has no detectable face (422 via
   `_assess_enrolment`).
 - still creates the row when no photo fields are supplied (fallback).
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
    Allocation,
    AttendanceRecord,
    Employee,
    OtpCode,
    SessionLocal,
    Supervisor,
    password_hash,
)

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/") + "/api"


# ---------- shared fixtures ----------
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
def face_b64() -> str:
    """Download a stock face photo and return raw base64 (no data: prefix)."""
    # Use the same portrait Ramesh Kumar seed uses — known to have a
    # detectable face and pass the enrolment quality gates.
    url = (
        "https://images.unsplash.com/photo-1646227655685-a530813759b3?"
        "crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjA1NTJ8MHwxfHNlYXJjaHwzfHx3"
        "b3JrZXIlMjBwb3J0cmFpdHxlbnwwfHx8fDE3ODI1NTEzODB8MA&ixlib=rb-4.1.0&q=85"
    )
    data = urlopen(Request(url, headers={"User-Agent": "pytest/1.0"}), timeout=15).read()
    im = Image.open(io.BytesIO(data)).convert("RGB")
    im.thumbnail((640, 640))
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=80)
    return base64.b64encode(buf.getvalue()).decode()


@pytest.fixture(scope="module")
def black_image_b64() -> str:
    """A pure black 320x320 image — no face, must be rejected by quality gate."""
    im = Image.new("RGB", (320, 320), color=(0, 0, 0))
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=80)
    return base64.b64encode(buf.getvalue()).decode()


def _base_payload(code: str) -> dict:
    """Minimal fields required by the Add Employee form."""
    return {
        "name": "Photo Test Emp",
        "code": code,
        "designation": "Site Supervisor",
        "skill": "Supervision",
        "gender": "Male",
        "marital_status": "Single",
        "dob": "01 Jan 1990",
        "father_name": "Test Dad",
        "primary_mobile": "9999999997",
        "aadhaar": "999999999997",
        "current_address": "test",
        "permanent_address": "test",
        "date_of_joining": "01 Jan 2025",
        "status": "No Allocation",
    }


def _cleanup_employee(code: str) -> None:
    with SessionLocal() as db:
        emp = db.query(Employee).filter(Employee.code == code).first()
        if not emp:
            return
        db.query(Allocation).filter(Allocation.employee_id == emp.id).delete()
        db.query(AttendanceRecord).filter(
            AttendanceRecord.employee_id == emp.id
        ).delete()
        db.delete(emp)
        db.commit()


# ---------- 1. HAPPY PATH: photo_b64 stored as data URL + face_encoding computed ----------
class TestCreateEmployeeWithPhotoB64:
    def test_happy_path_stores_data_url_and_face_encoding(self, headers, face_b64):
        code = f"TEST-PB64-{datetime.now().strftime('%H%M%S')}"
        payload = {**_base_payload(code), "photo_b64": face_b64}
        try:
            r = requests.post(
                f"{BASE_URL}/employees", headers=headers, json=payload, timeout=60
            )
            assert r.status_code == 200, r.text
            body = r.json()

            # response echoes photo as data URL
            assert body.get("photo"), "response photo empty"
            assert body["photo"].startswith("data:image/jpeg;base64,"), (
                f"expected data URL, got prefix {body['photo'][:40]!r}"
            )

            # verify DB persistence
            with SessionLocal() as db:
                emp = db.query(Employee).filter(Employee.code == code).first()
                assert emp is not None, "employee not persisted"
                assert emp.photo, "DB photo NULL"
                assert emp.photo.startswith("data:image/jpeg;base64,"), (
                    "DB photo not a data URL"
                )
                assert emp.face_encoding, "DB face_encoding NULL"
                enc = json.loads(emp.face_encoding)
                assert isinstance(enc, list), "face_encoding not a JSON list"
                assert len(enc) == 128, f"expected 128-d encoding, got {len(enc)}"
                # every element should be a float
                assert all(isinstance(x, (int, float)) for x in enc)
                # raw JSON blob is expected to be reasonably long (~2500-2800 chars)
                assert len(emp.face_encoding) >= 1500, (
                    f"face_encoding JSON suspiciously short: "
                    f"{len(emp.face_encoding)} chars"
                )
        finally:
            _cleanup_employee(code)

    def test_match_endpoint_finds_employee_created_via_photo_b64(
        self, headers, face_b64
    ):
        """End-to-end: after create with photo_b64, attendance/match on
        same base64 should return matched=true with distance ~0."""
        code = f"TEST-MATCH-{datetime.now().strftime('%H%M%S')}"
        payload = {**_base_payload(code), "photo_b64": face_b64}
        try:
            r = requests.post(
                f"{BASE_URL}/employees", headers=headers, json=payload, timeout=60
            )
            assert r.status_code == 200, r.text
            new_id = r.json()["id"]

            m = requests.post(
                f"{BASE_URL}/attendance/match",
                headers=headers,
                json={"image_b64": face_b64, "type": "Check-in", "threshold": 0.6},
                timeout=60,
            )
            assert m.status_code == 200, m.text
            mb = m.json()
            assert mb["matched"] is True, mb
            assert mb["distance"] is not None and mb["distance"] < 0.1, (
                f"distance {mb['distance']} not near 0"
            )
            # It should specifically match the employee we just created
            # (since face is identical to Ramesh's stock photo, the seed
            # DHD-1042 might also match — either is acceptable as long as
            # distance is near-zero, but our new record must be one of the
            # candidates in `matches`).
            candidate_ids = [x["employee"]["id"] for x in mb.get("matches", []) if x.get("employee")]
            top_id = mb["employee"]["id"] if mb.get("employee") else None
            assert new_id in candidate_ids or top_id == new_id, (
                f"newly-created employee {new_id} not in match candidates "
                f"{candidate_ids}, top={top_id}"
            )
        finally:
            _cleanup_employee(code)


# ---------- 2. file:// rejection ----------
class TestFileUriRejected:
    def test_file_uri_returns_422(self, headers):
        code = f"TEST-FILE-{datetime.now().strftime('%H%M%S')}"
        payload = {
            **_base_payload(code),
            "photo": "file:///data/user/0/host.exp.exponent/cache/Camera/abc.jpg",
        }
        try:
            r = requests.post(
                f"{BASE_URL}/employees", headers=headers, json=payload, timeout=30
            )
            assert r.status_code == 422, r.text
            detail = r.json().get("detail", "")
            assert detail.startswith("Local file URIs are not allowed"), (
                f"unexpected detail: {detail!r}"
            )
            # and the employee row must NOT have been created
            with SessionLocal() as db:
                assert (
                    db.query(Employee).filter(Employee.code == code).first() is None
                ), "employee row leaked despite 422"
        finally:
            _cleanup_employee(code)


# ---------- 3. no-face rejection ----------
class TestNoFaceRejected:
    def test_black_image_returns_422(self, headers, black_image_b64):
        code = f"TEST-NOFACE-{datetime.now().strftime('%H%M%S')}"
        payload = {**_base_payload(code), "photo_b64": black_image_b64}
        try:
            r = requests.post(
                f"{BASE_URL}/employees", headers=headers, json=payload, timeout=30
            )
            assert r.status_code == 422, r.text
            with SessionLocal() as db:
                assert (
                    db.query(Employee).filter(Employee.code == code).first() is None
                ), "employee row leaked despite quality-gate 422"
        finally:
            _cleanup_employee(code)


# ---------- 4. no-photo fallback ----------
class TestNoPhotoFallback:
    def test_create_without_any_photo_field(self, headers):
        code = f"TEST-NOPHOTO-{datetime.now().strftime('%H%M%S')}"
        payload = _base_payload(code)  # no photo, no photo_b64
        try:
            r = requests.post(
                f"{BASE_URL}/employees", headers=headers, json=payload, timeout=30
            )
            assert r.status_code == 200, r.text
            body = r.json()
            # response photo may be null / missing / empty
            assert not body.get("photo"), f"unexpected photo in response: {body.get('photo')!r}"

            with SessionLocal() as db:
                emp = db.query(Employee).filter(Employee.code == code).first()
                assert emp is not None
                assert emp.photo in (None, "", None), f"DB photo should be null, got {emp.photo!r}"
                assert emp.face_encoding in (None, "", None), (
                    "DB face_encoding should be null when no photo supplied"
                )
        finally:
            _cleanup_employee(code)
