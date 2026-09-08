"""Backend tests for PATCH /api/employees/{emp_id} (partial update)
and DELETE /api/employees/{emp_id} (cascade delete).

Covers the six scenarios from the review-request:
  1. auth: 401 without Bearer token
  2. partial: only sends `designation` → other columns untouched
  3. photo_b64 happy path (200 + data URL + 128-d encoding + match round-trip)
  4. file:// photo → 422 with "Local file URIs are not allowed"
  5. black photo_b64 → 422 (quality gate)
  6. project_id="<pid>" → single Allocation row + status=Active
  7. project_id=""      → all allocations removed + status="No Allocation"
  8. no photo fields     → row updated, photo/face_encoding untouched
  9. DELETE with children (attendance/salary/allocation) succeeds; children gone.
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
    Project,
    SalaryRecord,
    SessionLocal,
    Supervisor,
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
def face_b64() -> str:
    """Known-good face photo → passes the enrolment quality gate."""
    url = (
        "https://images.unsplash.com/photo-1646227655685-a530813759b3?"
        "crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjA1NTJ8MHwxfHNlYXJjaHwzfHx3"
        "b3JrZXIlMjBwb3J0cmFpdHxlbnwwfHx8fDE3ODI1NTEzODB8MA&ixlib=rb-4.1.0&q=85"
    )
    data = urlopen(
        Request(url, headers={"User-Agent": "pytest/1.0"}), timeout=15
    ).read()
    im = Image.open(io.BytesIO(data)).convert("RGB")
    im.thumbnail((640, 640))
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=80)
    return base64.b64encode(buf.getvalue()).decode()


@pytest.fixture(scope="module")
def black_image_b64() -> str:
    im = Image.new("RGB", (320, 320), color=(0, 0, 0))
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=80)
    return base64.b64encode(buf.getvalue()).decode()


# ---------- helpers ----------
def _create_employee(headers, code, extra=None) -> str:
    """Create a bare employee row via the API and return its id."""
    payload = {
        "name": "Update Test Emp",
        "code": code,
        "designation": "Helper",
        "skill": "General",
        "primary_mobile": "9999999900",
        "current_address": "test",
        "permanent_address": "test",
        "status": "No Allocation",
    }
    if extra:
        payload.update(extra)
    r = requests.post(
        f"{BASE_URL}/employees", headers=headers, json=payload, timeout=30
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _cleanup(code):
    with SessionLocal() as db:
        emp = db.query(Employee).filter(Employee.code == code).first()
        if not emp:
            return
        db.query(Allocation).filter(Allocation.employee_id == emp.id).delete()
        db.query(AttendanceRecord).filter(
            AttendanceRecord.employee_id == emp.id
        ).delete()
        db.query(SalaryRecord).filter(
            SalaryRecord.employee_id == emp.id
        ).delete()
        db.delete(emp)
        db.commit()


def _cleanup_project(name):
    with SessionLocal() as db:
        p = db.query(Project).filter(Project.name == name).first()
        if not p:
            return
        db.query(Allocation).filter(Allocation.project_id == p.id).delete()
        db.delete(p)
        db.commit()


# ---------- 1. auth ----------
class TestUpdateEmployeeAuth:
    def test_patch_requires_bearer(self):
        code = f"TEST-U-401-{datetime.now().strftime('%H%M%S')}"
        # we can PATCH a random id — auth should reject before lookup
        r = requests.patch(
            f"{BASE_URL}/employees/does-not-matter",
            json={"designation": "x"},
            timeout=15,
        )
        assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text}"


# ---------- 2. partial update touches only supplied columns ----------
class TestPartialUpdate:
    def test_patch_only_designation_leaves_other_fields_alone(self, headers):
        code = f"TEST-U-PART-{datetime.now().strftime('%H%M%S')}"
        emp_id = _create_employee(
            headers,
            code,
            extra={
                "name": "Original Name",
                "primary_mobile": "8888888888",
                "email": "orig@test.local",
                "skill": "Welding",
            },
        )
        try:
            r = requests.patch(
                f"{BASE_URL}/employees/{emp_id}",
                headers=headers,
                json={"designation": "Senior Foreman"},
                timeout=30,
            )
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["designation"] == "Senior Foreman"
            # other fields untouched
            with SessionLocal() as db:
                emp = db.get(Employee, emp_id)
                assert emp.name == "Original Name"
                assert emp.primary_mobile == "8888888888"
                assert emp.email == "orig@test.local"
                assert emp.skill == "Welding"
                assert emp.designation == "Senior Foreman"
        finally:
            _cleanup(code)


# ---------- 3. photo_b64 happy path ----------
class TestPhotoB64HappyPath:
    def test_patch_with_photo_b64_stores_data_url_and_encoding(
        self, headers, face_b64
    ):
        code = f"TEST-U-PHOTO-{datetime.now().strftime('%H%M%S')}"
        emp_id = _create_employee(headers, code)
        try:
            r = requests.patch(
                f"{BASE_URL}/employees/{emp_id}",
                headers=headers,
                json={"photo_b64": face_b64},
                timeout=60,
            )
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["photo"].startswith("data:image/jpeg;base64,")

            with SessionLocal() as db:
                emp = db.get(Employee, emp_id)
                assert emp.photo.startswith("data:image/jpeg;base64,")
                assert emp.face_encoding, "face_encoding NULL after PATCH"
                enc = json.loads(emp.face_encoding)
                assert isinstance(enc, list) and len(enc) == 128
                assert all(isinstance(x, (int, float)) for x in enc)

            # end-to-end: /attendance/match with the same b64 must match ~0
            m = requests.post(
                f"{BASE_URL}/attendance/match",
                headers=headers,
                json={
                    "image_b64": face_b64,
                    "type": "Check-in",
                    "threshold": 0.6,
                },
                timeout=60,
            )
            assert m.status_code == 200, m.text
            mb = m.json()
            assert mb["matched"] is True
            assert mb["distance"] is not None and mb["distance"] < 0.1, (
                f"expected distance ~0, got {mb['distance']}"
            )
        finally:
            _cleanup(code)


# ---------- 4. file:// rejected ----------
class TestFileUriRejected:
    def test_patch_with_file_uri_returns_422(self, headers):
        code = f"TEST-U-FILE-{datetime.now().strftime('%H%M%S')}"
        emp_id = _create_employee(headers, code)
        try:
            r = requests.patch(
                f"{BASE_URL}/employees/{emp_id}",
                headers=headers,
                json={
                    "photo": (
                        "file:///data/user/0/host.exp.exponent/cache/"
                        "Camera/abc.jpg"
                    )
                },
                timeout=15,
            )
            assert r.status_code == 422, r.text
            detail = r.json().get("detail", "")
            assert detail.startswith("Local file URIs are not allowed"), detail
            # DB photo must be unchanged
            with SessionLocal() as db:
                emp = db.get(Employee, emp_id)
                assert emp.photo in (None, ""), f"photo leaked: {emp.photo!r}"
        finally:
            _cleanup(code)


# ---------- 5. black image rejected by quality gate ----------
class TestBlackImageRejected:
    def test_patch_black_photo_b64_returns_422(self, headers, black_image_b64):
        code = f"TEST-U-BLACK-{datetime.now().strftime('%H%M%S')}"
        emp_id = _create_employee(headers, code)
        try:
            r = requests.patch(
                f"{BASE_URL}/employees/{emp_id}",
                headers=headers,
                json={"photo_b64": black_image_b64},
                timeout=30,
            )
            assert r.status_code == 422, r.text
            with SessionLocal() as db:
                emp = db.get(Employee, emp_id)
                assert emp.photo in (None, ""), (
                    f"photo leaked despite quality-gate 422: {emp.photo!r}"
                )
                assert emp.face_encoding in (None, ""), (
                    "face_encoding leaked despite quality-gate 422"
                )
        finally:
            _cleanup(code)


# ---------- 6. project_id (allocation semantics) ----------
class TestProjectAllocation:
    @pytest.fixture(scope="class")
    def project_a(self):
        name = f"TEST-PROJ-A-{datetime.now().strftime('%H%M%S')}"
        with SessionLocal() as db:
            p = Project(name=name, status="Active", location="test")
            db.add(p)
            db.commit()
            pid = p.id
        yield pid
        _cleanup_project(name)

    @pytest.fixture(scope="class")
    def project_b(self):
        name = f"TEST-PROJ-B-{datetime.now().strftime('%H%M%S')}"
        with SessionLocal() as db:
            p = Project(name=name, status="Active", location="test")
            db.add(p)
            db.commit()
            pid = p.id
        yield pid
        _cleanup_project(name)

    def test_setting_project_id_creates_single_allocation_and_replaces_prior(
        self, headers, project_a, project_b
    ):
        code = f"TEST-U-ALLOC-{datetime.now().strftime('%H%M%S')}"
        emp_id = _create_employee(headers, code)
        try:
            # First allocate to A
            r1 = requests.patch(
                f"{BASE_URL}/employees/{emp_id}",
                headers=headers,
                json={"project_id": project_a},
                timeout=30,
            )
            assert r1.status_code == 200, r1.text
            assert r1.json()["status"] == "Active"
            with SessionLocal() as db:
                allocs = (
                    db.query(Allocation)
                    .filter(Allocation.employee_id == emp_id)
                    .all()
                )
                assert len(allocs) == 1
                assert allocs[0].project_id == project_a

            # Reallocate to B — prior A allocation must be removed
            r2 = requests.patch(
                f"{BASE_URL}/employees/{emp_id}",
                headers=headers,
                json={"project_id": project_b},
                timeout=30,
            )
            assert r2.status_code == 200, r2.text
            assert r2.json()["status"] == "Active"
            with SessionLocal() as db:
                allocs = (
                    db.query(Allocation)
                    .filter(Allocation.employee_id == emp_id)
                    .all()
                )
                assert len(allocs) == 1, (
                    f"expected exactly 1 allocation, got {len(allocs)}"
                )
                assert allocs[0].project_id == project_b
        finally:
            _cleanup(code)

    def test_empty_project_id_removes_all_allocations(
        self, headers, project_a
    ):
        code = f"TEST-U-UNALLOC-{datetime.now().strftime('%H%M%S')}"
        emp_id = _create_employee(headers, code)
        try:
            # allocate
            requests.patch(
                f"{BASE_URL}/employees/{emp_id}",
                headers=headers,
                json={"project_id": project_a},
                timeout=30,
            )
            # then unallocate with empty string
            r = requests.patch(
                f"{BASE_URL}/employees/{emp_id}",
                headers=headers,
                json={"project_id": ""},
                timeout=30,
            )
            assert r.status_code == 200, r.text
            assert r.json()["status"] == "No Allocation"
            with SessionLocal() as db:
                allocs = (
                    db.query(Allocation)
                    .filter(Allocation.employee_id == emp_id)
                    .all()
                )
                assert allocs == [], (
                    f"allocations not cleared: {[a.project_id for a in allocs]}"
                )
                emp = db.get(Employee, emp_id)
                assert emp.status == "No Allocation"
        finally:
            _cleanup(code)


# ---------- 7. no photo fields ----------
class TestNoPhotoUpdate:
    def test_patch_without_photo_fields_leaves_photo_and_encoding_alone(
        self, headers, face_b64
    ):
        code = f"TEST-U-NOPHOTO-{datetime.now().strftime('%H%M%S')}"
        emp_id = _create_employee(headers, code)
        try:
            # first set a real photo so we have something to preserve
            r0 = requests.patch(
                f"{BASE_URL}/employees/{emp_id}",
                headers=headers,
                json={"photo_b64": face_b64},
                timeout=60,
            )
            assert r0.status_code == 200, r0.text
            with SessionLocal() as db:
                emp = db.get(Employee, emp_id)
                original_photo = emp.photo
                original_encoding = emp.face_encoding
                assert original_photo and original_encoding

            # now patch without any photo field
            r = requests.patch(
                f"{BASE_URL}/employees/{emp_id}",
                headers=headers,
                json={"designation": "Foreman"},
                timeout=30,
            )
            assert r.status_code == 200, r.text
            with SessionLocal() as db:
                emp = db.get(Employee, emp_id)
                assert emp.designation == "Foreman"
                assert emp.photo == original_photo, "photo mutated"
                assert emp.face_encoding == original_encoding, (
                    "face_encoding mutated"
                )
        finally:
            _cleanup(code)


# ---------- 8. DELETE with children ----------
class TestDeleteCascade:
    def test_delete_removes_attendance_salary_allocations(
        self, headers
    ):
        code = f"TEST-U-DEL-{datetime.now().strftime('%H%M%S')}"
        emp_id = _create_employee(headers, code)
        proj_name = f"TEST-PROJ-DEL-{datetime.now().strftime('%H%M%S')}"
        proj_id = None
        try:
            # seed a project + allocate
            with SessionLocal() as db:
                p = Project(name=proj_name, status="Active", location="t")
                db.add(p)
                db.commit()
                proj_id = p.id
                db.add(
                    Allocation(project_id=proj_id, employee_id=emp_id)
                )
                db.add(
                    AttendanceRecord(
                        employee_id=emp_id,
                        type="Check-in",
                        time="09:00 AM",
                        status="On Time",
                    )
                )
                db.add(
                    SalaryRecord(
                        employee_id=emp_id,
                        month="Jan 26",
                        days_worked=1,
                        daily_rate=500,
                        deductions=0,
                        status="Pending",
                    )
                )
                db.commit()

            r = requests.delete(
                f"{BASE_URL}/employees/{emp_id}", headers=headers, timeout=30
            )
            assert r.status_code == 200, r.text
            assert r.json() == {"ok": True}

            with SessionLocal() as db:
                assert db.get(Employee, emp_id) is None
                assert (
                    db.query(AttendanceRecord)
                    .filter(AttendanceRecord.employee_id == emp_id)
                    .count()
                    == 0
                ), "attendance not cleaned up"
                assert (
                    db.query(SalaryRecord)
                    .filter(SalaryRecord.employee_id == emp_id)
                    .count()
                    == 0
                ), "salary not cleaned up"
                assert (
                    db.query(Allocation)
                    .filter(Allocation.employee_id == emp_id)
                    .count()
                    == 0
                ), "allocations not cleaned up"
        finally:
            _cleanup(code)
            _cleanup_project(proj_name)
