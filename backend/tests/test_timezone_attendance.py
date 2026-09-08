"""Timezone regression tests: every attendance write MUST use IST wall-clock
regardless of server local TZ, and the `today` filter MUST be IST-based.
"""
from __future__ import annotations

import base64
import io
import os
import sys
import time as time_mod
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from zoneinfo import ZoneInfo

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
    SalaryRecord,
    SessionLocal,
    Supervisor,
    ist_date_str,
    ist_time_str,
    now_ist,
    password_hash,
)

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/") + "/api"
IST = ZoneInfo("Asia/Kolkata")


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
    from urllib.request import Request, urlopen
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


def _cleanup(code: str):
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


# ---------- 1. helper functions are TZ-independent ----------
class TestIstHelpersTzIndependent:
    def test_ist_time_str_matches_kolkata_wallclock_when_process_tz_is_LA(self):
        """Set process TZ to America/Los_Angeles and confirm ist_time_str()
        still returns the IST wall-clock time."""
        original_tz = os.environ.get("TZ")
        try:
            os.environ["TZ"] = "America/Los_Angeles"
            time_mod.tzset()
            expected = datetime.now(IST).strftime("%I:%M %p")
            actual = ist_time_str()
            # allow up to 1 minute drift between the two calls
            assert actual == expected or _within_one_minute(actual, expected), (
                f"ist_time_str={actual!r} vs Kolkata wallclock={expected!r}"
            )
        finally:
            if original_tz is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = original_tz
            time_mod.tzset()

    def test_ist_date_str_matches_kolkata_date(self):
        assert ist_date_str() == datetime.now(IST).strftime("%Y-%m-%d")

    def test_now_ist_is_tz_aware_kolkata(self):
        assert now_ist().tzinfo is not None
        assert now_ist().utcoffset() == timedelta(hours=5, minutes=30)


def _within_one_minute(a: str, b: str) -> bool:
    """Loose comparison so a minute-tick between the two `datetime.now`
    reads doesn't flake the test."""
    try:
        ta = datetime.strptime(a, "%I:%M %p")
        tb = datetime.strptime(b, "%I:%M %p")
        return abs((ta - tb).total_seconds()) <= 60
    except Exception:
        return False


# ---------- 2. manual create writes IST ----------
class TestAttendanceMarkWritesIst:
    def test_manual_mark_time_matches_ist(self, headers):
        code = f"TEST-TZ-MARK-{datetime.now().strftime('%H%M%S%f')}"
        # create employee via API
        r = requests.post(
            f"{BASE_URL}/employees",
            headers=headers,
            json={"name": "TZ Mark", "code": code, "status": "Active"},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        emp_id = r.json()["id"]
        try:
            before = datetime.now(IST) - timedelta(minutes=1)
            m = requests.post(
                f"{BASE_URL}/attendance/mark",
                headers=headers,
                json={"employee_id": emp_id, "type": "Check-in"},
                timeout=30,
            )
            after = datetime.now(IST) + timedelta(minutes=1)
            assert m.status_code == 200, m.text
            time_str = m.json()["time"]
            # parse "HH:MM AM/PM" against today's IST date
            written = datetime.strptime(
                f"{datetime.now(IST).strftime('%Y-%m-%d')} {time_str}",
                "%Y-%m-%d %I:%M %p",
            ).replace(tzinfo=IST)
            assert before <= written <= after, (
                f"time {time_str} not in IST window "
                f"[{before.strftime('%I:%M %p')}, {after.strftime('%I:%M %p')}]"
            )

            # verify the row's `day` is today-in-IST
            with SessionLocal() as db:
                rec = (
                    db.query(AttendanceRecord)
                    .filter(AttendanceRecord.employee_id == emp_id)
                    .order_by(AttendanceRecord.marked_at.desc())
                    .first()
                )
                assert rec is not None
                assert rec.day == now_ist().date(), (
                    f"day={rec.day} != IST today={now_ist().date()}"
                )
        finally:
            _cleanup(code)


# ---------- 3. face match writes IST ----------
class TestAttendanceMatchWritesIst:
    def test_match_face_records_ist_time(self, headers, face_b64):
        code = f"TEST-TZ-MATCH-{datetime.now().strftime('%H%M%S%f')}"
        r = requests.post(
            f"{BASE_URL}/employees",
            headers=headers,
            json={
                "name": "TZ Match",
                "code": code,
                "status": "Active",
                "photo_b64": face_b64,
            },
            timeout=60,
        )
        assert r.status_code == 200, r.text
        emp_id = r.json()["id"]
        try:
            before = datetime.now(IST) - timedelta(minutes=1)
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
            after = datetime.now(IST) + timedelta(minutes=1)
            assert m.status_code == 200, m.text
            body = m.json()
            assert body["matched"] is True, body
            time_str = body["attendance"]["time"]
            written = datetime.strptime(
                f"{datetime.now(IST).strftime('%Y-%m-%d')} {time_str}",
                "%Y-%m-%d %I:%M %p",
            ).replace(tzinfo=IST)
            assert before <= written <= after, (
                f"match time {time_str} not IST wallclock"
            )
        finally:
            _cleanup(code)


# ---------- 4. today filter uses IST day ----------
class TestTodayFilterUsesIst:
    def test_seeded_ist_today_row_appears_in_today(self, headers):
        code = f"TEST-TZ-TODAY-{datetime.now().strftime('%H%M%S%f')}"
        r = requests.post(
            f"{BASE_URL}/employees",
            headers=headers,
            json={"name": "TZ Today", "code": code, "status": "Active"},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        emp_id = r.json()["id"]
        try:
            # seed row directly with `day=now_ist().date()` and time="10:00 AM"
            with SessionLocal() as db:
                db.add(
                    AttendanceRecord(
                        employee_id=emp_id,
                        type="Check-in",
                        time="10:00 AM",
                        status="On Time",
                        day=now_ist().date(),
                    )
                )
                db.commit()

            g = requests.get(
                f"{BASE_URL}/attendance/today", headers=headers, timeout=30
            )
            assert g.status_code == 200, g.text
            ids = [row["employee_id"] for row in g.json()]
            assert emp_id in ids, f"seeded IST-today row missing from /today"

            # now seed a row with day=IST-yesterday and confirm it does NOT appear
            with SessionLocal() as db:
                db.add(
                    AttendanceRecord(
                        employee_id=emp_id,
                        type="Check-out",
                        time="06:00 PM",
                        status="On Time",
                        day=(now_ist() - timedelta(days=1)).date(),
                    )
                )
                db.commit()

            g2 = requests.get(
                f"{BASE_URL}/attendance/today", headers=headers, timeout=30
            )
            assert g2.status_code == 200, g2.text
            # `/today` should still list emp (from the today row) but only
            # today's rows. Count check-outs for emp_id — must be zero.
            checkouts = [
                r for r in g2.json()
                if r["employee_id"] == emp_id and r["type"] == "Check-out"
            ]
            assert checkouts == [], (
                f"yesterday check-out leaked into /today: {checkouts}"
            )
        finally:
            _cleanup(code)


# ---------- 5. AttendanceRecord.day default is IST date, not server date ----
class TestAttendanceRecordDayDefaultIsIst:
    def test_new_record_default_day_matches_ist_date(self, headers):
        code = f"TEST-TZ-DEFDAY-{datetime.now().strftime('%H%M%S%f')}"
        r = requests.post(
            f"{BASE_URL}/employees",
            headers=headers,
            json={"name": "TZ DefDay", "code": code, "status": "Active"},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        emp_id = r.json()["id"]
        try:
            with SessionLocal() as db:
                rec = AttendanceRecord(
                    employee_id=emp_id,
                    type="Check-in",
                    time=ist_time_str(),
                    status="On Time",
                )
                db.add(rec)
                db.commit()
                db.refresh(rec)
                assert rec.day == now_ist().date(), (
                    f"default day={rec.day} != IST today={now_ist().date()}"
                )
        finally:
            _cleanup(code)
