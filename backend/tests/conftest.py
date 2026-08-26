"""Session-scoped test fixtures.

The server no longer auto-seeds any data. These fixtures create the minimal
records the face-attendance tests need (one supervisor, one enrolled
employee `DHD-1042 Ramesh Kumar`) at the start of the test session and
tear them down at the end.
"""
from __future__ import annotations

import io
import sys
from urllib.request import Request, urlopen

import pytest
from dotenv import load_dotenv
from PIL import Image

load_dotenv("/app/backend/.env")
sys.path.insert(0, "/app/backend")

from server import (  # noqa: E402
    AttendanceRecord,
    Employee,
    SessionLocal,
    Supervisor,
)

TEST_SUPERVISOR_EMAIL = "techiearts19@gmail.com"
TEST_EMPLOYEE_CODE = "DHD-1042"
TEST_EMPLOYEE_PHOTO_URL = (
    "https://images.unsplash.com/photo-1646227655685-a530813759b3?"
    "crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjA1NTJ8MHwxfHNlYXJjaHwzfHx3"
    "b3JrZXIlMjBwb3J0cmFpdHxlbnwwfHx8fDE3ODI1NTEzODB8MA&ixlib=rb-4.1.0&q=85"
)


def _fetch_ref_photo_url() -> str:
    """Try to keep the same Unsplash worker portrait; if it 404s in the
    future, tests will still fail loudly rather than silently on wrong data."""
    return TEST_EMPLOYEE_PHOTO_URL


@pytest.fixture(scope="session", autouse=True)
def _ensure_test_seed():
    """Autouse: guarantees supervisor + DHD-1042 exist for the test run and
    cleans them up afterwards (unless they were pre-existing)."""
    created_supervisor = False
    created_employee = False
    with SessionLocal() as db:
        sup = (
            db.query(Supervisor)
            .filter(Supervisor.email == TEST_SUPERVISOR_EMAIL)
            .first()
        )
        if not sup:
            db.add(
                Supervisor(
                    name="Techie Arts",
                    code="SUP-TEST",
                    email=TEST_SUPERVISOR_EMAIL,
                    phone="+91 90000 00000",
                    designation="Test Supervisor",
                )
            )
            created_supervisor = True

        emp = (
            db.query(Employee)
            .filter(Employee.code == TEST_EMPLOYEE_CODE)
            .first()
        )
        if not emp:
            db.add(
                Employee(
                    name="Ramesh Kumar",
                    name_hi="रमेश कुमार",
                    code=TEST_EMPLOYEE_CODE,
                    designation="Site Supervisor",
                    skill="Supervision",
                    status="Active",
                    primary_mobile="+91 98231 45678",
                    email="ramesh.k@qaans.local",
                    photo=_fetch_ref_photo_url(),
                )
            )
            created_employee = True
        db.commit()

    yield

    # Teardown: only remove rows we created here.
    with SessionLocal() as db:
        if created_employee:
            emp = (
                db.query(Employee)
                .filter(Employee.code == TEST_EMPLOYEE_CODE)
                .first()
            )
            if emp:
                db.query(AttendanceRecord).filter(
                    AttendanceRecord.employee_id == emp.id
                ).delete()
                db.delete(emp)
        if created_supervisor:
            sup = (
                db.query(Supervisor)
                .filter(Supervisor.email == TEST_SUPERVISOR_EMAIL)
                .first()
            )
            if sup:
                db.delete(sup)
        db.commit()
